#!/usr/bin/env node
// Personal-mode stand-in for the relay's digest warm cycle (seedDigestWarm in
// scripts/personal-providers.cjs). The `news:digest:v1:<edition>:<lang>` cells are
// written only by a list-feed-digest build, and a build runs only when that
// (edition, language) pair is requested. Upstream the relay requests every pair
// on a 17-minute loop; here nothing did unless the dashboard was open, so the
// country brief, chat analyst, news pool, insights and forecasts read no news.
//
// This requests the English cell of every edition through the running personal
// server, with the same request and outcome rules as the relay
// (scripts/lib/news-digest-warm.cjs), so the build, its feed fetches, the
// last-good gate and the cell write are the server's own code path. Other
// languages stay on demand: their feed rows are what readers use, and a pass
// that built all 32 cells would take the collector budget several times over.
// Like every collector it needs `npm run start:personal` running; the cells
// expire after 15 minutes, so keep them fresh with `collect:personal -- --watch`.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnvFile } from './_seed-utils.mjs';
import { personalOrigin } from './lib/classify-digest-request.cjs';

const require = createRequire(import.meta.url);
const { fetchDigestWarmCell, runDigestWarmCycle, summarizeDigestWarmCycle } = require('./lib/news-digest-warm.cjs');
const WARM_CELLS = require('./shared/news-digest-warm-cells.json');

export const PERSONAL_DIGEST_CELLS = WARM_CELLS.filter((cell) => cell.lang === 'en');
const USER_AGENT = 'WorldMonitor-Personal-Collect/1.0 (news-digest)';
// Readers that know one cell read this one.
const REQUIRED_CELL = 'full:en';

export async function warmPersonalDigest({
  env = process.env,
  fetchImpl = globalThis.fetch,
  cells = PERSONAL_DIGEST_CELLS,
  spreadMs = 5_000 * Math.max(0, cells.length - 1),
} = {}) {
  const origin = personalOrigin(env);
  const startedAt = Date.now();
  const results = await runDigestWarmCycle(cells, {
    spreadMs,
    fetchCell: (cell) => fetchDigestWarmCell(cell, {
      fetchImpl,
      env: { API_BASE_URL: origin },
      userAgent: USER_AGENT,
      includeFreshDigest: true,
    }),
  });
  const summary = summarizeDigestWarmCycle(results, { fetchedAt: Date.now(), durMs: Date.now() - startedAt });
  const required = results.find((result) => `${result.edition}:${result.lang}` === REQUIRED_CELL);
  // Keep the actual response even when its cache cell expires before the
  // staggered cycle finishes. Put the full English digest first for consumers.
  const digests = [required?.digest, ...results.filter((result) => result !== required).map((result) => result.digest)];
  return { ...summary, ok: required?.outcome === 'fresh', digests };
}

async function main() {
  loadEnvFile(import.meta.url);
  const summary = await warmPersonalDigest();
  console.log(
    `[news-digest] ${summary.cells} cells: ${summary.fresh} fresh, ${summary.stale} stale, ${summary.failed} failed ` +
      `in ${Math.round(summary.durMs / 1000)}s${summary.failures.length ? ` (${summary.failures.join(', ')})` : ''}`,
  );
  if (!summary.ok) {
    console.error(`[news-digest] ${REQUIRED_CELL} was not rebuilt; is npm run start:personal running?`);
    process.exitCode = 1;
  }
  return summary.ok;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const startedAt = Date.now();
  main().then(
    // Printed only after a successful pass, as its last act
    // (tests/railway-entrypoint-terminal-marker.test.mts).
    (ok) => { if (ok) console.log(`\n=== Done (${Date.now() - startedAt}ms) ===`); },
    (error) => { console.error(error.message); process.exitCode = 1; },
  );
}
