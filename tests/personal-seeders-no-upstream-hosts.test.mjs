// This fork runs its collectors and its API on its own personal server. A
// seeder or server-side config that targets the upstream operator's hosted API
// or relay sends our traffic to a third party, warms their cache and leaves our
// store empty. This guard:
//   - follows every seed-*.mjs (bundles included) through the relative
//     .js/.mjs/.cjs/.json modules it imports in scripts/, shared/, server/ and
//     api/ (TypeScript resolution is out of scope), and
//   - scans the server-side config of fetch targets: every JSON file under
//     shared/ and scripts/shared/ (the news catalog and its mirror) and the
//     server/ TypeScript sources,
// and fails on any upstream API/relay host in code. It matches hosts, not file
// names, so a new seeder or catalog entry with the same target fails too.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const CLOSURE_ROOTS = ['scripts', 'shared', 'server', 'api'].map((dir) => path.join(ROOT, dir) + path.sep);

// The upstream operator's API and relay hosts, plus any worldmonitor.app URL
// that addresses an API or RSS-relay path.
const UPSTREAM_TARGET = /\b(?:api|proxy)\.worldmonitor\.app\b|https?:\/\/(?:[a-z0-9-]+\.)*worldmonitor\.app\/(?:api|rss)(?=[/?#'"`]|$)/i;

// Single lines this guard does not judge, each with its reason. A line entry
// covers that line only, so the rest of the file is still scanned.
const ALLOWED_LINES = new Map([
  // ais-relay's classify loop default (the relay is not run in personal mode).
  // The one seeder that reaches this module, seed-news-digest via
  // lib/news-digest-warm.cjs, always passes env.API_BASE_URL = personalOrigin();
  // tests/personal-collect-news-digest.test.mjs proves its requests go to the
  // personal server.
  ['scripts/lib/classify-digest-request.cjs', "const DEFAULT_CLASSIFY_API_HOST = 'api.worldmonitor.app';"],
]);

// Server-side JSON that names hosts without fetching them.
const ATTRIBUTION_LEDGERS = new Map([
  ['shared/source-attribution-manifest.json', 'source-attribution ledger: lists every host the tree references, by design'],
]);

const IMPORT_PATTERNS = [
  /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
];
const EXTENSIONS = ['', '.mjs', '.cjs', '.js', '.json'];
const FOLLOWED = /\.(?:mjs|cjs|js|json)$/;

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function resolveImport(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (FOLLOWED.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
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
    if (file.endsWith('.json')) continue;
    const source = readFileSync(file, 'utf8');
    for (const pattern of IMPORT_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const target = resolveImport(file, match[1]);
        if (target && CLOSURE_ROOTS.some((dir) => target.startsWith(dir))) queue.push(target);
      }
    }
  }
  return { roots, files: [...seen] };
}

function walk(dir, keep) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__tests__') out.push(...walk(full, keep));
    } else if (keep(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function serverSideConfig() {
  return [
    ...walk(path.join(ROOT, 'shared'), (name) => name.endsWith('.json')),
    ...walk(path.join(ROOT, 'scripts', 'shared'), (name) => name.endsWith('.json')),
    ...walk(path.join(ROOT, 'server'), (name) => /\.ts$/.test(name) && !/\.(?:test|spec)\.ts$/.test(name) && !name.endsWith('.d.ts')),
  ];
}

function offendersIn(files) {
  const offenders = [];
  for (const file of files) {
    const allowed = ALLOWED_LINES.get(rel(file));
    for (const [lineNo, code] of codeLines(readFileSync(file, 'utf8'))) {
      if (!UPSTREAM_TARGET.test(code)) continue;
      if (allowed && code.trim() === allowed) continue;
      offenders.push(`${rel(file)}:${lineNo}: ${code.trim().slice(0, 160)}`);
    }
  }
  return offenders;
}

test('the guard reaches every seeder and the modules they import, across the repo', () => {
  const { roots, files } = seederClosure();
  assert.ok(roots.length > 200, `expected the full seeder set, found ${roots.length}`);
  const names = new Set(files.map(rel));
  for (const expected of ['scripts/_seed-utils.mjs', 'scripts/lib/news-digest-warm.cjs', 'scripts/seed-bundle-derived-signals.mjs']) {
    assert.ok(names.has(expected), `${expected} is part of the scanned closure`);
  }
  const outsideScripts = files.map(rel).filter((name) => !name.startsWith('scripts/'));
  assert.ok(outsideScripts.length > 0, 'the closure follows imports out of scripts/');
  assert.ok(!files.some((file) => /\.(?:ts|mts|tsx)$/.test(file)), 'TypeScript resolution stays out of scope');
  // Every exception must still be needed: on disk, reached, and matching.
  for (const [file, line] of ALLOWED_LINES) {
    assert.ok(names.has(file), `${file} is no longer in the seeder closure (prune it from ALLOWED_LINES)`);
    assert.ok(readFileSync(path.join(ROOT, file), 'utf8').split('\n').some((l) => l.trim() === line), `${file} no longer has the allowed line`);
  }
});

test('no seeder, or module a seeder imports, targets the upstream API or relay hosts', () => {
  const offenders = offendersIn(seederClosure().files);
  assert.deepEqual(offenders, [], `Seeders must call the personal server (personalOrigin) or a direct source, not the upstream cloud:\n${offenders.join('\n')}`);
});

test('no server-side config of fetch targets names the upstream API or relay hosts', () => {
  const files = serverSideConfig().filter((file) => !ATTRIBUTION_LEDGERS.has(rel(file)));
  const names = files.map(rel);
  assert.ok(names.includes('shared/news-catalog.json') && names.includes('scripts/shared/news-catalog.json'), 'the news catalog and its mirror are scanned');
  for (const file of ATTRIBUTION_LEDGERS.keys()) assert.ok(existsSync(path.join(ROOT, file)), `${file} is still on disk`);
  const offenders = offendersIn(files);
  assert.deepEqual(offenders, [], `Server-side fetch targets must be this fork's own routes or the real source:\n${offenders.join('\n')}`);
});

test('the host pattern catches the upstream API and relay defaults and ignores attribution strings', () => {
  assert.ok(UPSTREAM_TARGET.test("const API_BASE = process.env.API_BASE_URL || 'https://api.worldmonitor.app';"));
  assert.ok(UPSTREAM_TARGET.test("const RELAY_URL = process.env.RELAY_URL || 'https://proxy.worldmonitor.app';"));
  assert.ok(UPSTREAM_TARGET.test("fetch('https://www.worldmonitor.app/api/bootstrap')"));
  assert.ok(UPSTREAM_TARGET.test('"url": "https://api.worldmonitor.app/api/miit-news",'));
  assert.ok(!UPSTREAM_TARGET.test("const UA = 'WorldMonitor/1.0 (+https://www.worldmonitor.app)';"));
  assert.ok(!UPSTREAM_TARGET.test("headers: { Origin: 'https://worldmonitor.app' }"));
  assert.ok(!UPSTREAM_TARGET.test("const DEPRECATION_POLICY_URL = 'https://www.worldmonitor.app/api-versioning.md';"));
});
