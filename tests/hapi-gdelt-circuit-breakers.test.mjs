import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

it('uses the GDELT Intelligence circuit breaker for article requests', () => {
  const src = readFileSync(resolve(root, 'src/services/gdelt-intel.ts'), 'utf8');
  const start = src.indexOf('export async function fetchGdeltArticles');
  assert.notEqual(start, -1);
  const end = src.indexOf('\nexport ', start + 1);
  assert.match(src.slice(start, end === -1 ? undefined : end), /gdeltBreaker\.execute/);
  assert.match(src, /GDELT Intelligence/);
});

describe('CircuitBreaker isolation — GDELT split breaker independence', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('GDELT: positive breaker failure does not trip regular breaker', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const gdelt = createCircuitBreaker({ name: 'GDELT Intelligence', cacheTtlMs: 10 * 60 * 1000 });
      const positive = createCircuitBreaker({ name: 'GDELT Positive', cacheTtlMs: 10 * 60 * 1000 });

      const fallback = { articles: [], totalArticles: 0 };
      const alwaysFail = () => { throw new Error('GDELT API unavailable'); };

      // Force positive breaker into cooldown (2 failures)
      await positive.execute(alwaysFail, fallback); // failure 1
      await positive.execute(alwaysFail, fallback); // failure 2 → cooldown
      assert.equal(positive.isOnCooldown(), true, 'positive breaker should be on cooldown after 2 failures');

      // gdelt breaker must NOT be affected
      assert.equal(gdelt.isOnCooldown(), false, 'gdelt breaker must not be on cooldown when positive fails');

      // gdelt should still call through successfully
      const realArticles = { articles: [{ url: 'https://news.example/military', title: 'Conflict update' }], totalArticles: 1 };
      const result = await gdelt.execute(async () => realArticles, fallback);
      assert.deepEqual(result, realArticles, 'gdelt breaker should return live data unaffected by positive cooldown');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('GDELT: regular and positive breakers cache different data independently', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const gdelt = createCircuitBreaker({ name: 'GDELT Intelligence', cacheTtlMs: 10 * 60 * 1000 });
      const positive = createCircuitBreaker({ name: 'GDELT Positive', cacheTtlMs: 10 * 60 * 1000 });

      const fallback = { articles: [], totalArticles: 0 };
      const militaryData = { articles: [{ url: 'https://news.example/military', title: 'Military operations' }], totalArticles: 1 };
      const peaceData    = { articles: [{ url: 'https://good.example/peace', title: 'Peace agreement' }], totalArticles: 1 };

      // Populate both caches with different data
      await gdelt.execute(async () => militaryData, fallback);
      await positive.execute(async () => peaceData, fallback);

      // Each must return its own cached value; pass fallback fn that would return wrong data
      const cachedGdelt    = await gdelt.execute(async () => fallback, fallback);
      const cachedPositive = await positive.execute(async () => fallback, fallback);

      assert.ok(
        cachedGdelt.articles[0]?.url.includes('military'),
        'gdelt cache must return military article URL, not peace article',
      );
      assert.ok(
        cachedPositive.articles[0]?.url.includes('peace'),
        'positive cache must return peace article URL, not military article',
      );
      assert.notEqual(
        cachedGdelt.articles[0]?.url,
        cachedPositive.articles[0]?.url,
        'Cached article URLs must be distinct per breaker (no cross-contamination)',
      );
    } finally {
      clearAllCircuitBreakers();
    }
  });
});
