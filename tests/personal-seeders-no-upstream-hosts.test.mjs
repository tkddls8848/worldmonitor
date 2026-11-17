// This fork runs its collectors against its own personal server. A seeder that
// defaults to the upstream operator's hosted API or relay sends our traffic to
// a third party, warms their cache and leaves our store empty. This guard
// follows every seed-*.mjs (bundles included) through the scripts/ modules it
// imports and fails on any upstream API/relay host in code. It matches hosts,
// not seeder names, so a new seeder with the same default fails too.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');

// The upstream operator's API and relay hosts, plus any worldmonitor.app URL
// that addresses an API or RSS-relay path.
const UPSTREAM_TARGET = /\b(?:api|proxy)\.worldmonitor\.app\b|https?:\/\/(?:[a-z0-9-]+\.)*worldmonitor\.app\/(?:api|rss)\b/i;

// Files this guard does not judge. Each is outside the seeder fix by decision.
const OUT_OF_SCOPE = new Map([
  // The relay service and its relay-only helpers; personal mode does not run it.
  ['scripts/ais-relay.cjs', 'relay process, not run in personal mode'],
  ['scripts/_widget-data-policy.cjs', 'imported only by ais-relay.cjs'],
  // Relay-owned default (ais-relay's classify loop). Its one seeder caller,
  // seed-news-digest via lib/news-digest-warm.cjs, always passes
  // API_BASE_URL = personalOrigin(); tests/personal-collect-news-digest.test.mjs
  // proves those requests go to the personal server.
  ['scripts/lib/classify-digest-request.cjs', 'relay default; seeder caller passes the personal origin'],
  // Desktop sidecar cloud fallback; personal-server forces LOCAL_API_MODE=docker
  // and LOCAL_API_CLOUD_FALLBACK=false.
  ['scripts/local/local-api-server.mjs', 'desktop cloud fallback, disabled by personal-server'],
  // One-off maintenance and CI scripts, not seeders.
  ['scripts/post-pr3427-force-refresh.mjs', 'maintenance script'],
  ['scripts/post-pr3487-force-refresh.mjs', 'maintenance script'],
  ['scripts/audit-resilience-cohorts.mjs', 'maintenance script'],
  ['scripts/freeze-resilience-ranking.mjs', 'maintenance script'],
  ['scripts/verify-import-hhi-coverage.mjs', 'maintenance script'],
  ['scripts/validate-rss-feeds.mjs', 'maintenance script'],
  ['scripts/validate-seed-migration.mjs', 'maintenance script'],
  ['scripts/generate-sandbox-fixtures.mjs', 'maintenance script'],
  ['scripts/openapi-inject-servers.mjs', 'maintenance script'],
  ['scripts/source-attribution.mjs', 'maintenance script'],
  ['scripts/shipping-webhook-worker.mjs', 'not a seeder'],
]);

const IMPORT_PATTERNS = [
  /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
];
const EXTENSIONS = ['', '.mjs', '.cjs', '.js', '.json'];

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function resolveImport(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate) && !candidate.endsWith(path.sep)) return candidate;
  }
  return null;
}

// Comments may name the upstream hosts (history, rationale); code may not.
function codeLines(source) {
  return source.split('\n').map((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return [index + 1, ''];
    return [index + 1, line.replace(/(^|\s)\/\/.*$/, '$1')];
  });
}

function seederClosure() {
  const roots = readdirSync(SCRIPTS).filter((name) => /^seed-.*\.mjs$/.test(name)).map((name) => path.join(SCRIPTS, name));
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.endsWith('.json')) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of IMPORT_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
          const target = resolveImport(file, match[1]);
          // Only the scripts/ tree is in scope (seeders, scripts/lib, scripts/_*).
          if (target && target.startsWith(SCRIPTS + path.sep)) queue.push(target);
        }
      }
    }
  }
  return { roots, files: [...seen] };
}

test('the guard reaches every seeder and the scripts/ modules they import', () => {
  const { roots, files } = seederClosure();
  assert.ok(roots.length > 200, `expected the full seeder set, found ${roots.length}`);
  const names = new Set(files.map(rel));
  for (const expected of ['scripts/_seed-utils.mjs', 'scripts/lib/news-digest-warm.cjs', 'scripts/seed-bundle-derived-signals.mjs']) {
    assert.ok(names.has(expected), `${expected} is part of the scanned closure`);
  }
  for (const file of OUT_OF_SCOPE.keys()) {
    assert.ok(existsSync(path.join(ROOT, file)), `${file} is still on disk (prune it from OUT_OF_SCOPE)`);
  }
});

test('no seeder, or scripts/ module a seeder imports, targets the upstream API or relay hosts', () => {
  const offenders = [];
  for (const file of seederClosure().files) {
    if (OUT_OF_SCOPE.has(rel(file))) continue;
    for (const [lineNo, code] of codeLines(readFileSync(file, 'utf8'))) {
      if (UPSTREAM_TARGET.test(code)) offenders.push(`${rel(file)}:${lineNo}: ${code.trim().slice(0, 160)}`);
    }
  }
  assert.deepEqual(offenders, [], `Seeders must call the personal server (personalOrigin) or a direct source, not the upstream cloud:\n${offenders.join('\n')}`);
});

test('the host pattern catches the upstream API and relay defaults and ignores attribution strings', () => {
  assert.ok(UPSTREAM_TARGET.test("const API_BASE = process.env.API_BASE_URL || 'https://api.worldmonitor.app';"));
  assert.ok(UPSTREAM_TARGET.test("const RELAY_URL = process.env.RELAY_URL || 'https://proxy.worldmonitor.app';"));
  assert.ok(UPSTREAM_TARGET.test("fetch('https://www.worldmonitor.app/api/bootstrap')"));
  assert.ok(!UPSTREAM_TARGET.test("const UA = 'WorldMonitor/1.0 (+https://www.worldmonitor.app)';"));
  assert.ok(!UPSTREAM_TARGET.test("headers: { Origin: 'https://worldmonitor.app' }"));
});
