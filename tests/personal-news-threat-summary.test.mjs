import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_COLLECTORS, STANDALONE_INTERVAL_MIN } from '../scripts/personal-collect.mjs';
import { fetchNewsThreatSummary, summarizeNewsThreat } from '../scripts/seed-news-threat-summary.mjs';

const digest = JSON.parse(readFileSync(new URL('./fixtures/news-threat-digest-excerpt.json', import.meta.url)));
const now = Date.parse(digest.generatedAt);

test('counts a live keyword label by affected country once across editions', () => {
  assert.deepEqual(summarizeNewsThreat([digest, digest], now), {
    byCountry: { SY: { critical: 0, high: 1, medium: 0, low: 0, info: 0 } },
    generatedAt: now,
  });
});

test('excludes old headlines, distinguishes quiet news from replay or missing coverage', () => {
  assert.deepEqual(summarizeNewsThreat([digest], now + 6 * 3600_000).byCountry, {});
  assert.throws(() => summarizeNewsThreat([null, digest], now), /full English news digest unavailable/);
  assert.throws(() => summarizeNewsThreat([{ ...digest, coverage: { ...digest.coverage, servedStale: true } }], now), /unavailable/);
  assert.throws(() => summarizeNewsThreat([digest, null], now + 6 * 3600_000), /cannot confirm a quiet news cycle/);
  assert.equal(STANDALONE_INTERVAL_MIN['news-threat-summary'], 15);
  assert.equal(DEFAULT_COLLECTORS[0], 'news-threat-summary');
});

test('uses a valid response even if its cache expires while the other editions finish', async () => {
  let fullCache = digest;
  const requests = [];
  const result = await fetchNewsThreatSummary({
    env: { WM_PERSONAL_PASSWORD: 'news-summary-test-password' },
    cells: [{ edition: 'full', lang: 'en' }, { edition: 'tech', lang: 'en' }],
    spreadMs: 0,
    fetchImpl: async (input) => {
      const url = new URL(input);
      assert.equal(url.pathname, '/api/news/v1/list-feed-digest');
      const edition = url.searchParams.get('variant');
      requests.push(edition);
      const freshHeadline = (body) => ({
        ...body,
        categories: { politics: { items: [{ ...digest.categories.politics.items[0], publishedAt: Date.now() }] } },
      });
      if (edition === 'full') return Response.json(freshHeadline(fullCache));
      fullCache = null;
      return Response.json({ ...digest, categories: {} });
    },
  });
  assert.deepEqual(requests, ['full', 'tech']);
  assert.equal(fullCache, null);
  assert.equal(result.byCountry.SY.high, 1);
});

test('preserves the full-English freshness gate even if a specialty edition succeeds', async () => {
  await assert.rejects(fetchNewsThreatSummary({
    env: { WM_PERSONAL_PASSWORD: 'news-summary-test-password' },
    cells: [{ edition: 'tech', lang: 'en' }, { edition: 'full', lang: 'en' }],
    spreadMs: 0,
    fetchImpl: async (input) => Response.json({
      ...digest,
      coverage: { ...digest.coverage, servedStale: new URL(input).searchParams.get('variant') === 'full' },
    }),
  }), /Current full English news digest unavailable/);
});
