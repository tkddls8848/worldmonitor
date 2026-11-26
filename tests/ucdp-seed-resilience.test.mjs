import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverVersion as discoverStandaloneUcdpVersion } from '../scripts/seed-ucdp-events.mjs';
import ucdpCandidate from '../scripts/shared/ucdp-candidate.cjs';

const src = readFileSync('scripts/personal-providers.cjs', 'utf8');
const standaloneSrc = readFileSync('scripts/seed-ucdp-events.mjs', 'utf8');
const UCDP_REDIS_KEY = 'conflict:ucdp-events:v1';
const EXPECTED_UCDP_WRITER_PATHS = [
  'scripts/seed-ucdp-events.mjs',
];
const SOURCE_SCAN_IGNORED_DIRS = new Set([
  '.git',
  '.personal',
  '.vercel',
  'blog-site/node_modules',
  'coverage',
  'dist',
  'node_modules',
  'src/generated',
]);

function shouldScanSourceDir(path) {
  if (SOURCE_SCAN_IGNORED_DIRS.has(path)) return false;
  // Parallel tests create short-lived repo-root fixtures such as
  // tmp-times-of-india-feed-test. Those are never source, and they can
  // vanish between readdir and descent (ENOENT under --test-concurrency).
  const top = path.split(/[\\/]/)[0];
  return top !== 'tmp' && !top.startsWith('tmp-');
}

function sourceFilesContaining(rootDir, needle) {
  const matches = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      // The parallel test runner churns short-lived fixtures under scripts/
      // (bundle-runner, seed-utils-sigterm-cleanup), so a file readdirSync
      // just listed can vanish before we stat/read it. Such files are never
      // real source — skip them rather than letting a transient ENOENT crash
      // the whole audit (flaky under --test-concurrency); re-throw anything
      // else so a genuine fs error still surfaces.
      let stat;
      try {
        stat = statSync(path);
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        throw err;
      }
      if (stat.isDirectory()) {
        if (!shouldScanSourceDir(path)) continue;
        stack.push(path);
        continue;
      }
      if (!/\.(?:cjs|mjs|js|mts|ts)$/.test(path)) continue;
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        throw err;
      }
      if (text.includes(needle)) matches.push(path);
    }
  }
  return matches.sort();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ucdpRedisWriterPaths() {
  return sourceFilesContaining('.', UCDP_REDIS_KEY)
    .filter((path) => !path.endsWith('.test.mjs') && !path.endsWith('.test.mts'))
    .filter((path) => {
      const text = readFileSync(path, 'utf8');
      if (new RegExp(`(?:envelopeWrite|upstashSet)\\(\\s*['"]${escapeRegExp(UCDP_REDIS_KEY)}['"]`).test(text)) {
        return true;
      }
      if (new RegExp(`\\[\\s*['"]SET['"]\\s*,\\s*['"]${escapeRegExp(UCDP_REDIS_KEY)}['"]`).test(text)) {
        return true;
      }
      const keyVars = Array.from(
        text.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*['"]${escapeRegExp(UCDP_REDIS_KEY)}['"]`, 'g')),
        (match) => match[1],
      );
      return keyVars.some((keyVar) => (
        new RegExp(`(?:envelopeWrite|upstashSet)\\(\\s*${keyVar}\\b`).test(text)
          || new RegExp(`\\[\\s*['"]SET['"]\\s*,\\s*${keyVar}\\b`).test(text)
      ));
    })
    .map((path) => path.replace(/\\/g, '/'))
    .sort();
}

// Extract just the seedUcdpEvents function body for targeted assertions
const fnStart = src.indexOf('async function seedUcdpEvents()');
const fnEnd = src.indexOf('\nasync function startUcdpSeedLoop()');
const fnBody = src.slice(fnStart, fnEnd);

// Brace-matched extraction of a top-level function declaration from the source.
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

describe('UCDP version selection prefers the newest release', () => {
  const discover = src.slice(
    src.indexOf('async function ucdpDiscoverVersion()'),
    src.indexOf('async function seedUcdpEvents()'),
  );

  it('on-demand relay discovery requires a non-empty Result (no empty newer wins)', () => {
    const relayDiscover = src.slice(
      src.indexOf('async function ucdpRelayDiscoverVersion()'),
      src.indexOf('async function ucdpFetchAllEvents()'),
    );
    assert.match(relayDiscover, /Array\.isArray\(page0\?\.Result\) && page0\.Result\.length > 0/);
  });

  it('all UCDP Redis writers are covered by this guard', () => {
    assert.deepEqual(ucdpRedisWriterPaths(), EXPECTED_UCDP_WRITER_PATHS);
  });

  // The bootstrap tier reads the compact projection, and health watches its
  // own seed-meta. The backup cron skips while the canonical seed-meta is
  // fresh, so a writer that refreshes only the canonical key leaves the
  // projection to age past its 420 min budget (Sentry WORLDMONITOR-1DC).
  it('every UCDP writer also refreshes the bootstrap projection and its seed-meta', () => {
    for (const path of ucdpRedisWriterPaths()) {
      const text = readFileSync(path, 'utf8');
      assert.ok(/compactUcdpDashboardPayload\(/.test(text), `${path} must build the compact projection`);
      // Match the write call, not the name: an import alone must not pass.
      assert.ok(/(?:upstashSet\(|\['SET',\s*)UCDP_BOOTSTRAP_KEY,/.test(text), `${path} must write the projection key`);
      assert.ok(/(?:upstashSet\(|\['SET',\s*)UCDP_BOOTSTRAP_META_KEY,/.test(text), `${path} must write the projection seed-meta`);
    }
  });

  it('the shared projection keys are the ones bootstrap and health read', async () => {
    const { UCDP_BOOTSTRAP_KEY, UCDP_BOOTSTRAP_META_KEY } = await import('../scripts/_ucdp-dashboard.mjs');
    const tierKeys = readFileSync('api/_bootstrap-tier-keys.js', 'utf8');
    const health = readFileSync('api/health.js', 'utf8');
    assert.ok(tierKeys.includes(`ucdpEvents: '${UCDP_BOOTSTRAP_KEY}'`));
    assert.ok(health.includes(`ucdpEventsBootstrap: { key: '${UCDP_BOOTSTRAP_META_KEY}'`));
  });

  it('does not treat ephemeral repo-root tmp fixtures as UCDP writers', () => {
    const fixtureDir = 'tmp-ucdp-writer-scan-test';
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      join(fixtureDir, 'fake-writer.mjs'),
      `envelopeWrite('${UCDP_REDIS_KEY}', '{}');\n`,
    );
    try {
      assert.deepEqual(ucdpRedisWriterPaths(), EXPECTED_UCDP_WRITER_PATHS);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('standalone cron discovery also requires non-empty Result for the same Redis key', async () => {
    assert.match(standaloneSrc, /const REDIS_KEY = 'conflict:ucdp-events:v1'/);
    const standaloneDiscover = standaloneSrc.slice(
      standaloneSrc.indexOf('async function discoverVersion('),
      standaloneSrc.indexOf('function parseDateMs('),
    );
    assert.match(
      standaloneDiscover,
      /!Array\.isArray\(page0\?\.Result\) \|\| page0\.Result\.length === 0/,
      'standalone UCDP seeder must not let an empty newer GED release win',
    );

    const pages = new Map([
      ['26.1', { Result: [], TotalPages: 1 }],
      ['25.1', { Result: [{ id: 'older-populated' }], TotalPages: 1 }],
    ]);
    const originalLog = console.log;
    console.log = () => {};
    try {
      const selected = await discoverStandaloneUcdpVersion(
        '',
        async (version) => pages.get(version),
        ['26.1', '25.1'],
      );
      assert.equal(selected.version, '25.1');
      assert.deepEqual(selected.page0.Result, [{ id: 'older-populated' }]);
    } finally {
      console.log = originalLog;
    }
  });
});

// A run whose candidate window failed is annual-only: its newest event is the
// annual release's last, up to a year behind. Publishing that re-anchors the
// CII's window there and collapses every UCDP term until the next good run.
describe('a run that cannot complete its window keeps the last good one', () => {
  const DAY_MS = 86_400_000;
  const NOW = Date.now();
  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  const ANNUAL_ROW_MS = NOW - 300 * DAY_MS;
  const annualRow = { id: 'annual-1', date_start: isoDay(ANNUAL_ROW_MS), date_end: isoDay(ANNUAL_ROW_MS), country: 'Mexico', best: 2, side_a: 'Government of Mexico', side_b: 'Rebels' };
  const goodWindow = (endMs) => ({ countryDays: { Ukraine: [[1, 1, 1]] }, window: { complete: true, endMs } });
  const recentGood = goodWindow(NOW - 30 * DAY_MS);

  describe('keepLastGoodUcdpWindow', () => {
    const run = { complete: false, endMs: 1_000 };
    const decide = (existing, window = run) => ucdpCandidate.keepLastGoodUcdpWindow(async () => existing, window);

    it('keeps a complete cached window that ends later than this incomplete run', async () => {
      assert.equal(await decide({ window: { complete: true, endMs: 1_001 } }), true);
    });

    it('keeps a complete cached window that ends on the same date as this incomplete run', async () => {
      assert.equal(await decide({ window: { complete: true, endMs: 1_000 } }), true);
    });

    it('keeps a newer complete cached frontier even when discovery reports a complete older run', async () => {
      let reads = 0;
      const keep = await ucdpCandidate.keepLastGoodUcdpWindow(async () => { reads += 1; return recentGood; }, { complete: true, endMs: 1_000 });
      assert.equal(keep, true);
      assert.equal(reads, 1);
    });

    it('never publishes an unparseable frontier, even if labelled complete', async () => {
      for (const endMs of [NaN, null, undefined]) {
        assert.equal(await decide(null, { complete: true, endMs }), true);
      }
    });

    it('publishes complete runs at the same or a newer frontier', async () => {
      for (const endMs of [1_000, 1_001]) {
        assert.equal(await decide({ window: { complete: true, endMs: 1_000 } }, { complete: true, endMs }), false);
      }
    });

    it('publishes an incomplete run when there is nothing better to keep', async () => {
      assert.equal(await decide(null), false, 'no cached value');
      assert.equal(await decide({ events: [] }), false, 'a pre-window payload has no window to protect');
      assert.equal(await decide({ window: { complete: false, endMs: 9_999 } }), false, 'cached window is incomplete');
      assert.equal(await decide({ window: { complete: true, endMs: 999 } }), false, 'cached window ends earlier');
      assert.equal(await decide({ window: { complete: true } }), false, 'cached window has no end');
    });

    it('keeps the cache when it cannot be read: overwriting blind is the failure this guards', async () => {
      assert.equal(await ucdpCandidate.keepLastGoodUcdpWindow(async () => { throw new Error('timeout'); }, run), true);
    });
  });

  describe('seed-ucdp-events.mjs writer', () => {
    // Runs the real script with fetch replaced (no network): annual pages
    // answer one row, every candidate release 400s, so discovery returns null.
    function runStandalone(existing, exhaustBudget = false, nullAnnualRow = false, annualStatus = null, expectedStatus = 0) {
      const dir = mkdtempSync(join(tmpdir(), 'ucdp-writer-'));
      const preload = join(dir, 'preload.mjs');
      const outPath = join(dir, 'calls.json');
      writeFileSync(preload, `
import { writeFileSync } from 'node:fs';
const existing = ${JSON.stringify(existing)};
const annualRow = ${JSON.stringify(annualRow)};
const calls = { sets: [], expires: [], payloads: [] };
let clock = ${NOW};
if (${exhaustBudget}) Date.now = () => clock;
process.on('exit', () => writeFileSync(${JSON.stringify(outPath)}, JSON.stringify(calls)));
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('/api/gedevents/')) {
    if (${exhaustBudget}) { clock += 250_000; throw new Error('upstream timeout'); }
    if (${annualStatus} !== null) return Response.json({}, { status: ${annualStatus} });
    const version = u.split('/api/gedevents/')[1].split('?')[0];
    if (version.includes('.0.')) return new Response('{}', { status: 400 });
    return Response.json({ TotalPages: 1, Result: ${nullAnnualRow ? '[null, annualRow]' : '[annualRow]'} });
  }
  if (u.toLowerCase().includes('/get/')) return Response.json({ result: existing === null ? null : JSON.stringify(existing) });
  if (!init?.body) return Response.json({ result: null });
  const [command, key, value] = JSON.parse(init.body);
  if (command === 'GET') return Response.json({ result: existing === null ? null : JSON.stringify(existing) });
  if (command === 'SET' && key === 'conflict:ucdp-events:v1') calls.payloads.push(JSON.parse(value));
  (command === 'SET' ? calls.sets : calls.expires).push(key);
  return Response.json({ result: command === 'SET' ? 'OK' : 1 });
};
`);
      try {
        const run = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, 'scripts/seed-ucdp-events.mjs'], {
          encoding: 'utf8',
          timeout: 60_000,
          env: { ...process.env, NODE_ENV: 'test', UCDP_ACCESS_TOKEN: 'test-ucdp-token', UPSTASH_REDIS_REST_URL: 'https://redis.invalid', UPSTASH_REDIS_REST_TOKEN: 'test-token' },
        });
        assert.equal(run.status, expectedStatus, run.stderr);
        return JSON.parse(readFileSync(outPath, 'utf8'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('keeps a complete cached window that ends later, read through the relay\'s envelope', () => {
      const calls = runStandalone({ _seed: { fetchedAt: NOW, recordCount: 1, sourceVersion: 'ucdp', schemaVersion: 1, state: 'OK' }, data: recentGood });
      assert.ok(!calls.sets.includes(UCDP_REDIS_KEY), 'the annual-only payload must not replace the last good window');
      assert.ok(!calls.sets.includes('seed-meta:conflict:ucdp-events'), 'seed-meta must keep the age of the data actually served');
      assert.ok(calls.expires.includes(UCDP_REDIS_KEY));
    });

    it('still publishes an incomplete run when no complete, later window is cached', () => {
      const calls = runStandalone(goodWindow(ANNUAL_ROW_MS - DAY_MS), false, false, null, 1);
      assert.ok(calls.sets.includes(UCDP_REDIS_KEY));
      const payload = calls.payloads[0].data ?? calls.payloads[0];
      assert.deepEqual(payload.partyMonths, [{ country: 'Mexico', sideA: 'Government of Mexico', sideB: 'Rebels', month: isoDay(ANNUAL_ROW_MS).slice(0, 7), deaths: 2, events: 1 }]);
      assert.ok(calls.sets.includes('seed-meta:conflict:ucdp-events'));
      // A later projection error is surfaced to the bundle after publish, and
      // the published last-good key still gets its TTL extended.
      assert.ok(calls.expires.includes(UCDP_REDIS_KEY));
    });

    it('a null annual row cannot bypass last-good preservation', () => {
      const calls = runStandalone(recentGood, false, true);
      assert.deepEqual(calls.sets, []);
      assert.ok(calls.expires.includes(UCDP_REDIS_KEY));
    });

    it('uses the reserved budget to preserve last-good data after discovery exhausts the deadline', () => {
      const calls = runStandalone(recentGood, true, false, null, 1);
      assert.deepEqual(calls.sets, []);
      assert.ok(calls.expires.includes(UCDP_REDIS_KEY));
      assert.ok(calls.expires.includes('seed-meta:conflict:ucdp-events'));
    });

    it('reports an upstream authorization failure to the relay and extends last-good TTLs', () => {
      const calls = runStandalone(recentGood, false, false, 401, 1);
      assert.deepEqual(calls.sets, []);
      assert.ok(calls.expires.includes(UCDP_REDIS_KEY));
      assert.ok(calls.expires.includes('seed-meta:conflict:ucdp-events'));
    });
  });
});
