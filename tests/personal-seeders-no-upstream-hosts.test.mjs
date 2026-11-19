// This fork runs its collectors and its API on its own personal server. A
// seeder or server-side module that targets the upstream operator's hosts
// (any *.worldmonitor.app) sends our traffic to a third party, warms their
// cache, loads their analytics, and leaves our store empty. This guard:
//   - follows every seed-*.mjs (bundles included) through the relative
//     .js/.mjs/.cjs/.json modules it imports in scripts/, shared/, server/ and
//     api/ (TypeScript resolution is out of scope), and
//   - scans the server-side config of fetch targets and the server runtime:
//     every JSON file under shared/ and scripts/shared/ (the news catalog and
//     its mirror), the server/ TypeScript and JavaScript sources, the
//     scripts/local/ personal-server modules, and the api/ handlers (tracked
//     sources; tests and gitignored build outputs are skipped),
// and fails on any worldmonitor.app host in code. It matches hosts, not file
// names, so a new seeder or catalog entry with the same target fails too.
// The few lines that name the host without sending it a request are listed in
// ALLOWED, one exact line each, by reason.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const CLOSURE_ROOTS = ['scripts', 'shared', 'server', 'api'].map((dir) => path.join(ROOT, dir) + path.sep);

// Any host under the upstream operator's domain: the API, the relay, the
// analytics collector (abacus.), the map tiles (maps.), www. and the apex.
const UPSTREAM_TARGET = /\b(?:[a-z0-9-]+\.)*worldmonitor\.app\b/i;

// Header values that name the host without sending it a request. The host is
// stripped from a code line only inside a match, so the same line that also
// fetches an upstream URL still fails. Each pattern must still match at least
// one scanned line (see the unused-exception check).
const HEADER_VALUES = [
  // User-Agent strings: a WorldMonitor product token with a parenthesized
  // contact comment, sent to a real data source. Nothing is sent to the host.
  ['user-agent', /(['"`])world-?monitor[^'"`()\n]*\([^'"`()\n]*\)\1/gi],
  // Any value written directly as a User-Agent header (browser-style tokens).
  ['user-agent', /(['"])User-Agent\1\s*:\s*(['"`])[^'"`\n]*\2/g],
  // HTTP-Referer: OpenRouter's app-attribution header on calls to OpenRouter.
  ['http-referer', /(['"])HTTP-Referer\1\s*:\s*(['"])https:\/\/worldmonitor\.app\2/g],
  // Origin request header: what the warm-ping seeders and the opt-in cloud
  // pass-through send (personal-api.mjs drops it for the personal server).
  ['origin', /\bOrigin['"]?\s*[:,]\s*(['"])https:\/\/worldmonitor\.app\1/g],
];

// Single lines this guard does not judge, each with its reason. An entry
// covers that one line in that one file, so the rest of the file is still
// scanned. Every entry must still be needed (see the unused-exception check).
const ALLOWED = [
  // Origin response values: CORS fallbacks the API answers with. They name
  // the origin a browser may read the response from; nothing is requested.
  ['origin', 'api/_cors.js', "const allowOrigin = isAllowedOrigin(origin) ? origin : 'https://worldmonitor.app';"],
  ['origin', 'api/_cors.js', "'Access-Control-Allow-Origin': origin || 'https://worldmonitor.app',"],
  ['origin', 'api/youtube/embed.js', "return sanitizeAllowedOrigin(raw, 'https://worldmonitor.app', ALLOWED_ORIGINS);"],
  ['origin', 'server/cors.ts', "const allowOrigin = isAllowedOrigin(origin) ? origin : 'https://worldmonitor.app';"],
  ['origin', 'server/cors.ts', "'Access-Control-Allow-Origin': origin || 'https://worldmonitor.app',"],
  // The relay's CORS allowlist: browser origins it answers, not targets.
  ['origin', 'scripts/ais-relay.cjs', "'https://worldmonitor.app',"],
  ['origin', 'scripts/ais-relay.cjs', "'https://tech.worldmonitor.app',"],
  ['origin', 'scripts/ais-relay.cjs', "'https://finance.worldmonitor.app',"],
  ['origin', 'scripts/ais-relay.cjs', "if (url.hostname.endsWith('.worldmonitor.app') && url.protocol === 'https:') return origin;"],
  // HDX HAPI's app_identifier: the client name and contact address the
  // conflict seeders send to HAPI, like a User-Agent. Nothing is sent to it.
  ['user-agent', 'shared/hapi-app-identifier.json', '"email": "monitor@worldmonitor.app"'],
  ['user-agent', 'scripts/shared/hapi-app-identifier.json', '"email": "monitor@worldmonitor.app"'],
  // Documentation-only: text and links a person may read or click. The
  // server never requests them and the page never loads them.
  ['documentation', 'api/brief/[userId]/[issueDate].ts', `+ '<p><a href="https://worldmonitor.app">Return to WorldMonitor</a></p>'`],
  ['documentation', 'api/brief/public/[hash].ts', `+ '<p><a href="https://worldmonitor.app/pro">Start your own WorldMonitor Brief</a></p>'`],
  ['documentation', 'api/not-found.ts', "hint: 'Check the endpoint path against the OpenAPI spec at https://www.worldmonitor.app/openapi.yaml or the API reference at https://www.worldmonitor.app/docs/api-reference.',"],
  ['documentation', 'api/not-found.ts', "documentation: 'https://www.worldmonitor.app/docs/api-reference',"],
  ['documentation', 'server/_shared/deprecation-policy.ts', "export const DEPRECATION_POLICY_URL = 'https://www.worldmonitor.app/api-versioning.md';"],
  // Base of the reference links the country brief's evidence items carry
  // (forecast scorecard, chokepoint pages). The server never requests them.
  ['documentation', 'server/worldmonitor/intelligence/v1/_country-brief-evidence.ts', "const SITE_ORIGIN = 'https://www.worldmonitor.app';"],
  ['documentation', 'shared/agent-request-policy.json', '"hint": "Use a descriptive User-Agent and an X-WorldMonitor-Key API key. See https://www.worldmonitor.app/auth.md."'],
  ['documentation', 'scripts/shared/agent-request-policy.json', '"hint": "Use a descriptive User-Agent and an X-WorldMonitor-Key API key. See https://www.worldmonitor.app/auth.md."'],
  ['documentation', 'server/_shared/brief-render.js', "? `https://worldmonitor.app/pro${refCode ? `?ref=${encodeURIComponent(refCode)}` : ''}`"],
  ['documentation', 'server/_shared/brief-render.js', ": 'https://worldmonitor.app';"],
  ['documentation', 'server/_shared/brief-render.js', `: '<span class="mono">worldmonitor.app</span>';`],
  ['documentation', 'server/_shared/brief-render.js', `? '<span class="mono">worldmonitor.app</span>'`],
  ['documentation', 'server/_shared/brief-render.js', "const publicStripHref = `https://worldmonitor.app/pro${refCode ? `?ref=${encodeURIComponent(refCode)}` : ''}`;"],
];
const ALLOWED_KINDS = new Set(['user-agent', 'http-referer', 'origin', 'documentation']);
const ALLOWED_LINES = new Map();
for (const [, file, line] of ALLOWED) {
  if (!ALLOWED_LINES.has(file)) ALLOWED_LINES.set(file, new Set());
  ALLOWED_LINES.get(file).add(line);
}

// Server-side JSON that names hosts without fetching them, skipped whole.
// Documentation-only: each must still exist (checked below).
const ATTRIBUTION_LEDGERS = new Map([
  ['shared/source-attribution-manifest.json', 'source-attribution ledger: lists every host the tree references, by design'],
  // Generated product facts (scripts/generate-derived.mjs): the upstream
  // site's page and pricing links as marketing copy. No code fetches them.
  ['shared/product-catalog.generated.json', 'product facts: page links, never fetched'],
  ['scripts/shared/product-catalog.generated.json', 'product facts mirror: page links, never fetched'],
  ['shared/product-facts.generated.json', 'product facts: page links, never fetched'],
  ['scripts/shared/product-facts.generated.json', 'product facts mirror: page links, never fetched'],
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
  return importClosure(roots);
}

// The AIS relay (a long-running collector) and every module it requires.
function relayClosure() {
  return importClosure([path.join(SCRIPTS, 'ais-relay.cjs')]);
}

function importClosure(roots) {
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

// Gitignored api/ build outputs (see .gitignore): the sebuf gateway and domain
// handler bundles, the personal edge bundles written next to their .ts source,
// and the generated inventory facts. Their sources are scanned instead.
function isApiBuildOutput(file) {
  const name = path.basename(file);
  if (name === '[rpc].js' || name.startsWith('[[')) return true;
  if (rel(file) === 'api/_inventory-facts.generated.js') return true;
  return name.endsWith('.js') && existsSync(file.replace(/\.js$/, '.ts'));
}

function apiHandlers() {
  return walk(path.join(ROOT, 'api'), (name) => /\.(?:ts|js|mjs|cjs)$/.test(name)
    && !/\.(?:test|spec)\.[cm]?[jt]s$/.test(name) && !name.endsWith('.d.ts'))
    .filter((file) => !isApiBuildOutput(file));
}

const isSource = (name) => /\.(?:ts|js|mjs|cjs)$/.test(name) && !/\.(?:test|spec)\.[cm]?[jt]s$/.test(name) && !name.endsWith('.d.ts');

// The personal server's own modules (the API host, the embedded store and its
// REST proxy, the handler builder): top level of scripts/local/ only.
function personalServerModules() {
  const dir = path.join(ROOT, 'scripts', 'local');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs') && isSource(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

function serverSideConfig() {
  return [
    ...walk(path.join(ROOT, 'shared'), (name) => name.endsWith('.json')),
    ...walk(path.join(ROOT, 'scripts', 'shared'), (name) => name.endsWith('.json')),
    ...walk(path.join(ROOT, 'server'), (name) => /\.(?:ts|js)$/.test(name) && isSource(name)),
    ...personalServerModules(),
    ...apiHandlers(),
  ];
}

// Removes the allowed header values from a code line; returns the rest and
// the indexes of the HEADER_VALUES patterns that hid a host.
function stripHeaderValues(code) {
  const used = [];
  let rest = code;
  HEADER_VALUES.forEach(([, pattern], index) => {
    const next = rest.replace(pattern, (match) => (UPSTREAM_TARGET.test(match) ? '' : match));
    if (next !== rest) used.push(index);
    rest = next;
  });
  return { rest, used };
}

function offendersIn(files) {
  const offenders = [];
  for (const file of files) {
    const allowed = ALLOWED_LINES.get(rel(file));
    for (const [lineNo, code] of codeLines(readFileSync(file, 'utf8'))) {
      if (!UPSTREAM_TARGET.test(code)) continue;
      if (allowed?.has(code.trim())) continue;
      if (!UPSTREAM_TARGET.test(stripHeaderValues(code).rest)) continue;
      offenders.push(`${rel(file)}:${lineNo}: ${code.trim().slice(0, 160)}`);
    }
  }
  return offenders;
}

function scannedFiles() {
  return [...new Set([...seederClosure().files, ...relayClosure().files, ...serverSideConfig()])]
    .filter((file) => !ATTRIBUTION_LEDGERS.has(rel(file)));
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
});

test('every allowed line is still needed: a known reason, a scanned file, a present line that matches', () => {
  const scanned = new Set(scannedFiles().map(rel));
  for (const [kind, file, line] of ALLOWED) {
    assert.ok(ALLOWED_KINDS.has(kind), `${file}: unknown allowance reason ${kind}`);
    assert.ok(scanned.has(file), `${file} is no longer scanned (prune it from ALLOWED)`);
    assert.ok(UPSTREAM_TARGET.test(line), `${file}: the allowed line no longer names the host (prune it)`);
    const present = codeLines(readFileSync(path.join(ROOT, file), 'utf8')).some(([, code]) => code.trim() === line);
    assert.ok(present, `${file} no longer has the allowed line (prune it from ALLOWED): ${line}`);
  }
  const usedPatterns = new Set();
  for (const file of scanned) {
    for (const [, code] of codeLines(readFileSync(path.join(ROOT, file), 'utf8'))) {
      if (UPSTREAM_TARGET.test(code)) for (const index of stripHeaderValues(code).used) usedPatterns.add(index);
    }
  }
  HEADER_VALUES.forEach(([kind, pattern], index) => {
    assert.ok(ALLOWED_KINDS.has(kind), `unknown header allowance reason ${kind}`);
    assert.ok(usedPatterns.has(index), `the ${kind} header pattern ${pattern} no longer matches any scanned line (prune it)`);
  });
});

test('a header value hides the host only inside the header, not elsewhere on the line', () => {
  const ua = "headers: { 'User-Agent': 'WorldMonitor/1.0 (+https://worldmonitor.app)' }";
  assert.ok(!UPSTREAM_TARGET.test(stripHeaderValues(ua).rest));
  assert.ok(!UPSTREAM_TARGET.test(stripHeaderValues("'HTTP-Referer': 'https://worldmonitor.app',").rest));
  assert.ok(!UPSTREAM_TARGET.test(stripHeaderValues("headers.set('Origin', 'https://worldmonitor.app');").rest));
  assert.ok(!UPSTREAM_TARGET.test(stripHeaderValues("Origin: 'https://worldmonitor.app',").rest));
  const mixed = "fetch('https://api.worldmonitor.app/x', { headers: { Origin: 'https://worldmonitor.app' } })";
  assert.ok(UPSTREAM_TARGET.test(stripHeaderValues(mixed).rest), 'the fetch target still fails');
  assert.ok(UPSTREAM_TARGET.test(stripHeaderValues("Origin: 'https://api.worldmonitor.app',").rest), 'only the apex origin is a header value');
});

test('no seeder, or module a seeder imports, targets the upstream operator hosts', () => {
  const offenders = offendersIn(seederClosure().files);
  assert.deepEqual(offenders, [], `Seeders must call the personal server (personalOrigin) or a direct source, not the upstream cloud:\n${offenders.join('\n')}`);
});

test('the AIS relay, and every module it requires, targets no upstream operator host', () => {
  const { files } = relayClosure();
  const names = new Set(files.map(rel));
  for (const expected of ['scripts/ais-relay.cjs', 'scripts/_widget-data-policy.cjs', 'scripts/lib/classify-digest-request.cjs']) {
    assert.ok(names.has(expected), `${expected} is part of the relay closure`);
  }
  const offenders = offendersIn(files.filter((file) => !ATTRIBUTION_LEDGERS.has(rel(file))));
  assert.deepEqual(offenders, [], `The relay must call the personal server or a direct source, never *.worldmonitor.app:\n${offenders.join('\n')}`);
});

test('no server-side module or fetch-target config names the upstream operator hosts', () => {
  const files = serverSideConfig().filter((file) => !ATTRIBUTION_LEDGERS.has(rel(file)));
  const names = files.map(rel);
  assert.ok(names.includes('shared/news-catalog.json') && names.includes('scripts/shared/news-catalog.json'), 'the news catalog and its mirror are scanned');
  // The digest's feed fetcher (own-API path feeds, relay fallback) is scanned.
  assert.ok(names.includes('server/worldmonitor/news/v1/list-feed-digest.ts'), 'list-feed-digest.ts is scanned');
  // server/ JavaScript (the brief magazine renderer) and the personal server's
  // own modules are scanned.
  for (const expected of [
    'server/_shared/brief-render.js',
    'scripts/local/local-api-server.mjs',
    'scripts/local/embedded-store.mjs',
    'scripts/local/redis-rest-proxy.mjs',
  ]) {
    assert.ok(names.includes(expected), `${expected} is scanned`);
  }
  // The api/ handlers are scanned, including the Trip Assessment route and the
  // MCP travel-risk modules it still runs; tests and build outputs are not.
  for (const expected of [
    'api/travel-risk-assessment.ts',
    'api/mcp/registry/travel-risk-tool.ts',
    'api/mcp/registry/analysis-tools.ts',
    'api/bootstrap.js',
    'api/miit-news.js',
    'api/youtube/live.js',
  ]) {
    assert.ok(names.includes(expected), `${expected} is scanned`);
  }
  assert.ok(!names.some((name) => /\.test\./.test(name)), 'tests are not scanned');
  assert.ok(!names.some((name) => /\[rpc\]\.js$/.test(name)), 'api/ build outputs are not scanned');
  for (const file of ATTRIBUTION_LEDGERS.keys()) assert.ok(existsSync(path.join(ROOT, file)), `${file} is still on disk`);
  const offenders = offendersIn(files);
  assert.deepEqual(offenders, [], `Server-side code must call this fork's own routes or the real source, never *.worldmonitor.app:\n${offenders.join('\n')}`);
});

test('the api/ build-output filter skips only generated bundles', () => {
  const at = (p) => path.join(ROOT, p);
  assert.ok(isApiBuildOutput(at('api/market/v1/[rpc].js')));
  assert.ok(isApiBuildOutput(at('api/[[...path]].js')));
  assert.ok(isApiBuildOutput(at('api/_inventory-facts.generated.js')));
  assert.ok(isApiBuildOutput(at('api/travel-risk-assessment.js')), 'a .js next to its .ts source is a personal edge bundle');
  assert.ok(!isApiBuildOutput(at('api/bootstrap.js')));
  assert.ok(!isApiBuildOutput(at('api/_cii-coverage-baseline.generated.js')), 'tracked generated modules stay scanned');
});

test('the host pattern catches every upstream host, not only the API and relay', () => {
  for (const line of [
    "const API_BASE = process.env.API_BASE_URL || 'https://api.worldmonitor.app';",
    "const RELAY_URL = process.env.RELAY_URL || 'https://proxy.worldmonitor.app';",
    "fetch('https://www.worldmonitor.app/api/bootstrap')",
    '"url": "https://api.worldmonitor.app/api/miit-news",',
    '<script async src="https://abacus.worldmonitor.app/script.js"></script>',
    "const TILES = 'https://maps.worldmonitor.app/{z}/{x}/{y}.pbf';",
    "await fetch('https://worldmonitor.app/api/youtube/live');",
    "const WEBHOOK_BASE = 'https://api.worldmonitor.app/api/v2/shipping';",
  ]) {
    assert.ok(UPSTREAM_TARGET.test(line), line);
  }
  // The pattern itself has no exceptions: attribution strings match too and
  // are allowed only line by line in ALLOWED.
  assert.ok(UPSTREAM_TARGET.test("const UA = 'WorldMonitor/1.0 (+https://www.worldmonitor.app)';"));
  assert.ok(!UPSTREAM_TARGET.test("const UA = 'WorldMonitor/1.0';"));
  assert.ok(!UPSTREAM_TARGET.test("const HOST = 'worldmonitor.application.example';"));
});
