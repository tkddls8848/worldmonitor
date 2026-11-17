import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync as originalReadFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
function readFileSync(path, options) {
  const content = originalReadFileSync(path, options);
  if (typeof content === 'string') {
    return content.replace(/\r\n/g, '\n');
  }
  return content;
}

// Consecutive User-agent lines share one robots.txt group. A blank line, or a
// User-agent line after rules, starts a new group; comments do not end a group.
function parseRobotsGroups(source) {
  const groups = [];
  let current = null;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (line === '') {
      current = null;
      continue;
    }
    if (line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (key === 'allow' || key === 'disallow')) {
      current.rules.push(`${key}: ${value}`);
    }
  }
  return groups;
}
import { fileURLToPath } from 'node:url';
import {
  discoverContentCorpusPages,
} from '../scripts/discover-content-corpus-pages.mjs';
import { guardBuiltOutput, shouldSkipBuiltOutput } from './_lib/built-output-guard.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const viteConfigSource = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf-8');
const playwrightConfigSource = readFileSync(resolve(__dirname, '../playwright.config.ts'), 'utf-8');
const testWorkflowSource = readFileSync(resolve(__dirname, '../.github/workflows/test.yml'), 'utf-8');
const robotsSource = readFileSync(resolve(__dirname, '../public/robots.www.txt'), 'utf-8');

const variantDashboardSource = readFileSync(resolve(__dirname, '../src/config/variant-dashboard-html.ts'), 'utf-8');
const WEBMCP_PLAYWRIGHT_ENV_KEYS = [
  'WM_REQUIRE_WEBMCP',
  'WM_WEBMCP_PRODUCTION',
  'WM_WEBMCP_PRODUCTION_URL',
  'WM_WEBMCP_DEPLOYED_SHA',
  'WM_WEBMCP_CHROME_CHANNEL',
  'WM_WEBMCP_CHROME_EXECUTABLE_PATH',
];

function probePlaywrightWebMcpEnvironment(overrides = {}) {
  const env = { ...process.env, NODE_NO_WARNINGS: '1' };
  for (const key of WEBMCP_PLAYWRIGHT_ENV_KEYS) delete env[key];
  Object.assign(env, overrides);

  const probe = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      [
        "const { default: config } = await import('./playwright.config.ts');",
        "const chromium = config.projects?.find(({ name }) => name === 'chromium');",
        'console.log(JSON.stringify({',
        '  baseURL: config.use?.baseURL ?? null,',
        '  hasWebServer: Boolean(config.webServer),',
        '  launchArgs: chromium?.use?.launchOptions?.args ?? [],',
        '  testMatch: config.testMatch ?? null,',
        '}));',
      ].join('\n'),
    ],
    {
      cwd: resolve(__dirname, '..'),
      encoding: 'utf8',
      env,
    },
  );
  assert.ifError(probe.error);
  return probe;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getVariantUrls = () => {
  const variantMetaSource = readFileSync(resolve(__dirname, '../src/config/variant-meta.ts'), 'utf-8');
  return Object.fromEntries(
    [...variantMetaSource.matchAll(/\n\s{2}([a-z]+):\s*\{[\s\S]*?url:\s*'([^']+)'/g)]
      .map((match) => [match[1], match[2]])
  );
};

describe('crawlable content corpus deployment contracts', () => {
  const staticCorpusPaths = [
    '/countries/ukraine/',
    '/chokepoints/suez-canal/',
    '/research/strait-of-hormuz-transit-report-2026-07/',
    '/crises/ukraine-war/',
    '/tools/natural-hazard-pulse/',
    '/reference/changelog/page/2/',
  ];

  const writeFixturePage = (publicDir, relativePath, head = '') => {
    const target = join(publicDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '<!doctype html><html><head>' + head + '</head><body>fixture</body></html>');
  };

  it('keeps robots.txt advertising root, blog, and Mintlify docs sitemaps', () => {
    assert.match(robotsSource, /^Sitemap: https:\/\/www\.worldmonitor\.app\/sitemap\.xml$/m);
    assert.match(robotsSource, /^Sitemap: https:\/\/www\.worldmonitor\.app\/blog\/sitemap-index\.xml$/m);
    assert.match(robotsSource, /^Sitemap: https:\/\/www\.worldmonitor\.app\/docs\/sitemap\.xml$/m);
  });

  it('discovers canonical generated corpus pages and validates changelog pagination links', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-content-corpus-'));
    const publicDir = join(tempRoot, 'public');
    try {
      writeFixturePage(
        publicDir,
        'countries/ukraine/index.html',
        '<link rel="canonical" href="https://www.worldmonitor.app/countries/ukraine/" /><meta name="lastmod" content="2026-07-08" />'
      );
      writeFixturePage(
        publicDir,
        'chokepoints/suez-canal/index.html',
        '<link rel="canonical" href="https://www.worldmonitor.app/chokepoints/suez-canal/" />'
      );
      writeFixturePage(
        publicDir,
        'crises/ukraine-war/index.html',
        '<link rel="canonical" href="https://www.worldmonitor.app/crises/ukraine-war/" />'
      );
      writeFixturePage(
        publicDir,
        'tools/natural-hazard-pulse/index.html',
        '<link rel="canonical" href="https://www.worldmonitor.app/tools/natural-hazard-pulse/" />'
      );
      writeFixturePage(
        publicDir,
        'reference/changelog/index.html',
        '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" /><link rel="canonical" href="https://www.worldmonitor.app/reference/changelog/" /><link rel="next" href="https://www.worldmonitor.app/reference/changelog/page/2/" />'
      );
      writeFixturePage(
        publicDir,
        'reference/changelog/page/2/index.html',
        '<meta name="robots" content="noindex, follow" /><link rel="canonical" href="https://www.worldmonitor.app/reference/changelog/page/2/" /><link rel="prev" href="https://www.worldmonitor.app/reference/changelog/" />'
      );

      const pages = discoverContentCorpusPages({ publicDir });
      const locations = pages.map((page) => page.loc).sort();
      assert.deepEqual(locations, [
        'https://www.worldmonitor.app/reference/changelog/',
        'https://www.worldmonitor.app/chokepoints/suez-canal/',
        'https://www.worldmonitor.app/crises/ukraine-war/',
        'https://www.worldmonitor.app/countries/ukraine/',
        'https://www.worldmonitor.app/tools/natural-hazard-pulse/',
      ].sort());
      assert.ok(
        !locations.some((loc) => loc.includes('/changelog/page/')),
        'paginated changelog URLs must be omitted from the sitemap inventory',
      );

      writeFixturePage(
        publicDir,
        'reference/changelog/page/3/index.html',
        '<meta name="robots" content="noindex, follow" /><link rel="canonical" href="https://www.worldmonitor.app/reference/changelog/page/3/" />'
      );
      assert.throws(
        () => discoverContentCorpusPages({ publicDir }),
        /missing rel="(?:prev|next)" pagination link/
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects noindex changelog pagination whose canonical path does not match the file', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-content-corpus-'));
    const publicDir = join(tempRoot, 'public');
    try {
      writeFixturePage(
        publicDir,
        'reference/changelog/index.html',
        '<meta name="robots" content="index, follow" /><link rel="canonical" href="https://www.worldmonitor.app/reference/changelog/" /><link rel="next" href="https://www.worldmonitor.app/reference/changelog/page/2/" />'
      );
      writeFixturePage(
        publicDir,
        'reference/changelog/page/2/index.html',
        '<meta name="robots" content="noindex, follow" /><link rel="canonical" href="https://www.worldmonitor.app/reference/changelog/page/3/" /><link rel="prev" href="https://www.worldmonitor.app/reference/changelog/" />'
      );

      assert.throws(
        () => discoverContentCorpusPages({ publicDir }),
        /canonical \/reference\/changelog\/page\/3\/ does not match raw static path \/reference\/changelog\/page\/2\//
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('deploy/cache configuration guardrails', () => {

  it('keeps PWA precache glob free of HTML files', () => {
    assert.match(viteConfigSource, /includeManifestIcons:\s*false/);
    assert.match(
      viteConfigSource,
      /globPatterns:\s*\['assets\/\*\*\/\*\.\{js,css\}'\]/
    );
    assert.match(viteConfigSource, /manifestTransforms:\s*\[dashboardPrecache\.manifestTransform\]/);
  });

  it('routes sourcemap output through the policy that keeps production maps Sentry-only (#7382)', () => {
    assert.match(viteConfigSource, /const emitPublicSourceMaps = shouldEmitPublicSourceMaps\(process\.env\)/);
    assert.match(viteConfigSource, /sourcemap:\s*viteSourcemapSetting\(process\.env\)/);
    assert.match(viteConfigSource, /emitPublicSourceMaps \? \[\] : \[stripPrivateSourceMapsPlugin\(\)\]/);
  });

  it('assigns a stable chunk name to the Clerk SDK', () => {
    assert.match(
      viteConfigSource,
      /if\s*\(\s*id\.includes\('\/@clerk\/clerk-js\/'\)\s*\)\s*\{[^{}]*\breturn 'clerk';\s*\}/
    );
  });

  const swPath = resolve(__dirname, '../dist/sw.js');
  guardBuiltOutput(swPath);
  function readPwaWorker() {
    let manifest;
    let appChunkCache;
    function workboxStub() {} // Used as both a constructor and an ordinary helper.
    const workbox = new Proxy({
      precacheAndRoute(entries) { manifest = entries; },
      ExpirationPlugin: class {
        constructor(options) { Object.assign(this, options); }
      },
      StaleWhileRevalidate: class {
        constructor(options) {
          if (options.cacheName === 'app-chunks') appChunkCache = options;
        }
      },
    }, { get: (target, name) => target[name] ?? workboxStub });
    const define = (_dependencies, factory) => factory(workbox);
    runInNewContext(readFileSync(swPath, 'utf8'), {
      define,
      self: { define, skipWaiting() {}, addEventListener() {} },
      importScripts() {},
    }, { timeout: 5_000 });
    assert.ok(Array.isArray(manifest) && manifest.length > 0, 'generated SW must register a precache');
    return { manifest, appChunkCache };
  }

  function assertPwaPrecache(manifest) {
    const urls = Array.from(manifest, ({ url }) => url);
    assert.ok(urls.length <= 32, `PWA precache has ${urls.length} entries; budget is 32`);
    let totalBytes = 0;
    const dist = dirname(swPath);
    for (const url of urls) {
      const path = resolve(dist, url);
      assert.ok(path.startsWith(`${dist}${sep}`), `precache URL escapes dist: ${url}`);
      totalBytes += statSync(path).size;
      assert.doesNotMatch(url, /^(?:pro|blog|textures|trust|research-assets)\//);
      if (!url.startsWith('favico/')) assert.doesNotMatch(url, /\.(?:woff2?|png|svg)$/i);
      assert.doesNotMatch(url, /(?:^|\/)(?:App-|MapContainer-|GlobeMap-|maplibre-|protomaps-|deck-stack-|h3-js-|UnifiedSettings-|settings-window-|checkout-|rpc-client-|panel-support-|panels-(?:economy|markets|risk|energy|defense|news|intel)-)/, `Optional chunk must stay out of precache: ${url}`);
      if (/\.html$/.test(url)) assert.equal(url, 'offline.html');
    }
    assert.ok(totalBytes <= 2 * 1024 * 1024, `PWA precache is ${totalBytes} bytes; budget is 2 MiB`);
    for (const url of ['offline.html', 'manifest.webmanifest', 'favico/favicon.ico', 'favico/apple-touch-icon.png', 'favico/favicon-32x32.png']) {
      assert.ok(urls.includes(url), `missing required precache file: ${url}`);
    }
    assert.ok(urls.some((url) => /^assets\/main-.*\.js$/.test(url)), 'dashboard entry is missing');
  }

  it('bounds the generated PWA precache and excludes optional/off-page assets (#5373)', {
    skip: shouldSkipBuiltOutput(swPath),
  }, () => {
    assertPwaPrecache(readPwaWorker().manifest);
  });

  it('keeps enough runtime-cache capacity for the emitted JS/CSS build (#5373)', {
    skip: shouldSkipBuiltOutput(swPath),
  }, () => {
    const { appChunkCache } = readPwaWorker();
    assert.ok(appChunkCache, 'generated SW must register the app chunk runtime cache');
    const expiration = appChunkCache.plugins.find((plugin) => Number.isFinite(plugin.maxEntries));
    assert.ok(expiration, 'app chunk runtime cache must have bounded capacity');
    // Counting every chunk is conservative: shell and locale routes own some of them.
    const assets = readdirSync(resolve(dirname(swPath), 'assets')).filter((name) => /\.(?:js|css)$/i.test(name));
    assert.ok(expiration.maxEntries >= assets.length,
      `Runtime cache holds ${expiration.maxEntries} entries but the build emits ${assets.length} JS/CSS files; normal use can evict the app entry`);
  });

  it('rejects forbidden map and panel chunks even when they fit the precache budgets (#5373)', {
    skip: shouldSkipBuiltOutput(swPath),
  }, () => {
    const { manifest } = readPwaWorker();
    const dist = dirname(swPath);
    const assets = readdirSync(resolve(dist, 'assets'));
    for (const prefix of [
      'protomaps-', 'h3-js-', 'UnifiedSettings-', 'settings-window-', 'checkout-',
      'panel-support-', 'panels-news-', 'panels-intel-',
    ]) {
      const asset = assets.find((name) => name.startsWith(prefix) && name.endsWith('.js'));
      assert.ok(asset, `missing built chunk for negative test: ${prefix}`);
      const polluted = [...manifest, { url: `assets/${asset}`, revision: null }];
      assert.ok(polluted.length <= 32, 'negative test must stay within the entry budget');
      const bytes = polluted.reduce((sum, { url }) => sum + statSync(resolve(dist, url)).size, 0);
      assert.ok(bytes <= 2 * 1024 * 1024, 'negative test must stay within the byte budget');
      assert.throws(() => assertPwaPrecache(polluted), /Optional chunk must stay out of precache/);
    }
  });

  it('explicitly disables navigateFallback when HTML is not precached', () => {
    assert.match(viteConfigSource, /navigateFallback:\s*null/);
    assert.doesNotMatch(viteConfigSource, /navigateFallbackDenylist:\s*\[/);
  });

  it('delegates navigation requests to the SW script with an offline fallback', () => {
    // Navigations are handled by public/sw-navigation.js: network-first with
    // NO cache write (a cached index.html outlives its hashed chunks across
    // deploys -> blank offline reloads), falling back to the precached
    // offline.html when the network is unreachable.
    assert.match(viteConfigSource, /importScripts:\s*\[[^\]]*'\/sw-navigation\.js'/);
    assert.doesNotMatch(viteConfigSource, /html-navigation/);
    const navScript = readFileSync(resolve(__dirname, '../public/sw-navigation.js'), 'utf-8');
    assert.match(navScript, /request\.mode !== 'navigate'/);
    assert.match(navScript, /OFFLINE_URL = '\/offline\.html'/);
    assert.match(navScript, /caches\.match\(OFFLINE_URL/);
  });

  it('contains variant-specific metadata fields used by html replacement and manifest', () => {
    const variantMetaSource = readFileSync(resolve(__dirname, '../src/config/variant-meta.ts'), 'utf-8');
    assert.match(variantMetaSource, /shortName:\s*'/);
    assert.match(variantMetaSource, /subject:\s*'/);
    assert.match(variantMetaSource, /classification:\s*'/);
    assert.match(variantMetaSource, /categories:\s*\[/);
    assert.match(
      viteConfigSource,
      /\.replace\(\/<meta name="subject" content="\.\*\?" \\\/>\/,\s*`<meta name="subject"/
    );
    assert.match(
      viteConfigSource,
      /\.replace\(\/<meta name="classification" content="\.\*\?" \\\/>\/,\s*`<meta name="classification"/
    );
  });
});

describe('welcome landing page routing', () => {

  // #4825: public/index.md became Vercel's DIRECTORY INDEX for `/` — filesystem
  // resolution beats the `/` → /pro/welcome.html rewrite, so the apex homepage
  // served raw text/markdown to browsers. No `index.*` file may exist in public/;
  // the markdown homepage twin is built at public/pro/home.md and keeps its scored URL
  // through the /index.md rewrite below.
  it('keeps public/ free of index.* files so filesystem resolution cannot hijack the / rewrite', () => {
    const publicDir = resolve(__dirname, '../public');
    const offenders = readdirSync(publicDir).filter((f) => /^index\./i.test(f));
    assert.deepEqual(offenders, [], `public/${offenders[0] ?? ''} would shadow the / welcome rewrite as a directory index`);
  });

  it('keeps variant canonicals aligned with the /dashboard routing strategy', () => {
    const variantUrls = getVariantUrls();
    assert.equal(variantUrls.full, 'https://www.worldmonitor.app/dashboard');

    const nonFullUrls = Object.entries(variantUrls).filter(([variant]) => variant !== 'full');
    assert.ok(nonFullUrls.length >= 5, 'expected non-full variant metadata entries');
    for (const [variant, url] of nonFullUrls) {
      assert.equal(
        new URL(url).pathname,
        '/dashboard',
        `${variant} canonical must point at /dashboard while the root serves welcome`
      );
    }
  });

  it('renames the web dashboard HTML output away from root index.html', () => {
    // Assert the build's OUTPUT, not the plugin's internals. Vercel's
    // filesystem precedence serves a root index.html at / ahead of every
    // rewrite above, so what matters is that the web build emits
    // dashboard.html and leaves no index.html behind — however the plugin
    // happens to accomplish it.
    const distDir = resolve(__dirname, '../dist');
    const dashboardHtml = join(distDir, 'dashboard.html');
    if (shouldSkipBuiltOutput(dashboardHtml)) return;
    guardBuiltOutput(dashboardHtml);

    assert.ok(existsSync(dashboardHtml), 'web build must emit dist/dashboard.html');
    assert.ok(
      !existsSync(join(distDir, 'index.html')),
      'web build must not leave a root dist/index.html — Vercel would serve it at / ahead of the dashboard rewrite',
    );
  });

  it('starts installed PWAs on /dashboard, not the public welcome page', () => {
    assert.match(viteConfigSource, /start_url:\s*'\/dashboard'/);
  });

});

describe('security header guardrails', () => {

  it('keeps local suites local unless the complete production-smoke environment is present', () => {
    const deployedSha = 'a'.repeat(40);
    const matrix = [
      {
        name: 'ordinary suite',
        env: {},
        expected: {
          baseURL: 'http://127.0.0.1:4173',
          hasWebServer: true,
          testingFlag: false,
          testMatch: null,
        },
      },
      {
        name: 'strict local WebMCP suite',
        env: { WM_REQUIRE_WEBMCP: '1' },
        expected: {
          baseURL: 'http://127.0.0.1:4173',
          hasWebServer: true,
          testingFlag: true,
          testMatch: null,
        },
      },
      {
        name: 'strict local WebMCP evidence with a deployed SHA',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_DEPLOYED_SHA: deployedSha,
        },
        expected: {
          baseURL: 'http://127.0.0.1:4173',
          hasWebServer: true,
          testingFlag: true,
          testMatch: null,
        },
      },
      {
        name: 'bounded production smoke',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_PRODUCTION: '1',
          WM_WEBMCP_PRODUCTION_URL: 'https://www.worldmonitor.app',
          WM_WEBMCP_DEPLOYED_SHA: deployedSha,
        },
        expected: {
          baseURL: 'https://www.worldmonitor.app',
          hasWebServer: false,
          testingFlag: false,
          testMatch: '**/webmcp.spec.ts',
        },
      },
    ];

    for (const entry of matrix) {
      const probe = probePlaywrightWebMcpEnvironment(entry.env);
      assert.equal(
        probe.status,
        0,
        `${entry.name} should load playwright.config.ts:\n${probe.stderr}`,
      );
      const resolved = JSON.parse(probe.stdout.trim());
      assert.equal(resolved.baseURL, entry.expected.baseURL, `${entry.name} baseURL`);
      assert.equal(resolved.hasWebServer, entry.expected.hasWebServer, `${entry.name} webServer`);
      assert.equal(resolved.testMatch, entry.expected.testMatch, `${entry.name} testMatch`);
      assert.equal(
        resolved.launchArgs.includes('--enable-features=WebMCPTesting,WebMCP'),
        entry.expected.testingFlag,
        `${entry.name} testing flag`,
      );
    }
  });

  it('rejects every incomplete or inconsistent WebMCP evidence environment', () => {
    const deployedSha = 'b'.repeat(40);
    const matrix = [
      {
        name: 'URL without production mode',
        env: { WM_WEBMCP_PRODUCTION_URL: 'https://www.worldmonitor.app' },
        error: /WM_WEBMCP_PRODUCTION_URL requires WM_WEBMCP_PRODUCTION=1/,
      },
      {
        name: 'local SHA without strict WebMCP mode',
        env: { WM_WEBMCP_DEPLOYED_SHA: deployedSha },
        error: /WM_WEBMCP_DEPLOYED_SHA requires WM_REQUIRE_WEBMCP=1 outside production mode/,
      },
      {
        name: 'explicit local mode with a remote URL',
        env: {
          WM_WEBMCP_PRODUCTION: '0',
          WM_WEBMCP_PRODUCTION_URL: 'https://www.worldmonitor.app',
        },
        error: /WM_WEBMCP_PRODUCTION_URL requires WM_WEBMCP_PRODUCTION=1/,
      },
      {
        name: 'strict local mode with a malformed deployed SHA',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_DEPLOYED_SHA: 'not-a-sha',
        },
        error: /WM_WEBMCP_DEPLOYED_SHA must record an exact 40-character hexadecimal SHA/,
      },
      {
        name: 'strict local mode with an empty deployed SHA',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_DEPLOYED_SHA: '',
        },
        error: /WM_WEBMCP_DEPLOYED_SHA must record an exact 40-character hexadecimal SHA/,
      },
      {
        name: 'strict local mode with a whitespace-only deployed SHA',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_DEPLOYED_SHA: '   ',
        },
        error: /WM_WEBMCP_DEPLOYED_SHA must record an exact 40-character hexadecimal SHA/,
      },
      {
        name: 'production mode without strict WebMCP mode',
        env: {
          WM_WEBMCP_PRODUCTION: '1',
          WM_WEBMCP_PRODUCTION_URL: 'https://www.worldmonitor.app',
          WM_WEBMCP_DEPLOYED_SHA: deployedSha,
        },
        error: /WM_WEBMCP_PRODUCTION=1 requires WM_REQUIRE_WEBMCP=1/,
      },
      {
        name: 'production mode without a URL',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_PRODUCTION: '1',
          WM_WEBMCP_DEPLOYED_SHA: deployedSha,
        },
        error: /WM_WEBMCP_PRODUCTION_URL must be https:\/\/www\.worldmonitor\.app/,
      },
      {
        name: 'production mode with a different URL',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_PRODUCTION: '1',
          WM_WEBMCP_PRODUCTION_URL: 'https://tech.worldmonitor.app',
          WM_WEBMCP_DEPLOYED_SHA: deployedSha,
        },
        error: /WM_WEBMCP_PRODUCTION_URL must be https:\/\/www\.worldmonitor\.app/,
      },
      {
        name: 'production mode without a deployed SHA',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_PRODUCTION: '1',
          WM_WEBMCP_PRODUCTION_URL: 'https://www.worldmonitor.app',
        },
        error: /WM_WEBMCP_DEPLOYED_SHA must record the exact 40-character SHA/,
      },
      {
        name: 'production mode with a malformed deployed SHA',
        env: {
          WM_REQUIRE_WEBMCP: '1',
          WM_WEBMCP_PRODUCTION: '1',
          WM_WEBMCP_PRODUCTION_URL: 'https://www.worldmonitor.app',
          WM_WEBMCP_DEPLOYED_SHA: 'not-a-sha',
        },
        error: /WM_WEBMCP_DEPLOYED_SHA must record the exact 40-character SHA/,
      },
    ];

    for (const entry of matrix) {
      const probe = probePlaywrightWebMcpEnvironment(entry.env);
      assert.notEqual(probe.status, 0, `${entry.name} must fail closed`);
      assert.match(`${probe.stdout}\n${probe.stderr}`, entry.error, entry.name);
    }
  });

  it('keeps the Zod parser off its JIT path from the first script import', () => {
    const mainSource = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf-8');
    const zodCspSource = readFileSync(resolve(__dirname, '../src/bootstrap/zod-csp.ts'), 'utf-8');
    assert.match(
      mainSource,
      /import '\.\/bootstrap\/zod-csp';/,
      'main.ts must apply the Zod CSP bootstrap before the app graph'
    );
    // Zod v4 runs its `new Function` probe when a z.object() is constructed,
    // so any script module evaluated before zod-csp could trip the CSP.
    // Spans lines so `import {\n  a,\n} from 'x';` counts as an import of 'x'.
    const scriptImportsOf = (source) =>
      [...source.matchAll(/^import\s(?:[^'";]*?\sfrom\s)?['"]([^'"]+)['"]/gm)]
        .map((match) => match[1])
        .filter((specifier) => !specifier.endsWith('.css'));
    assert.deepEqual(
      scriptImportsOf("import './a.css';\nimport {\n  one,\n  two,\n} from './early';\nimport type { T } from './t';\nimport './bootstrap/zod-csp';\n"),
      ['./early', './t', './bootstrap/zod-csp'],
      'the import scan must see multiline and type-only declarations'
    );
    const scriptImports = scriptImportsOf(mainSource);
    assert.equal(
      scriptImports[0],
      './bootstrap/zod-csp',
      'zod-csp must be the first script import in main.ts so no module graph evaluates before it'
    );
    assert.match(
      zodCspSource,
      /configureZod\(\{\s*jitless:\s*true\s*\}\)/,
      'Zod must stay on the non-JIT parser path under the hardened CSP'
    );
  });

  it('mirrors WebMCP origin isolation in local development without enrolling localhost', () => {
    const pluginSource = viteConfigSource.match(
      /function webMcpDevSecurityHeadersPlugin\(\): Plugin \{[\s\S]*?\n\}/,
    )?.[0] ?? '';
    assert.ok(pluginSource, 'Vite must define the local WebMCP security-header plugin');
    assert.match(pluginSource, /res\.setHeader\('Origin-Agent-Cluster', '\?1'\)/);
    assert.match(pluginSource, /res\.setHeader\('Permissions-Policy', 'tools=\(self\)'\)/);
    assert.doesNotMatch(pluginSource, /Origin-Trial/, 'localhost must use Chrome testing mode, not a trial token');
    assert.match(viteConfigSource, /\n\s+webMcpDevSecurityHeadersPlugin\(\),/);
  });

  it('security.txt exists in public/.well-known/', () => {
    const secTxt = readFileSync(resolve(__dirname, '../public/.well-known/security.txt'), 'utf-8');
    assert.match(secTxt, /^Contact:/m, 'security.txt must have a Contact field');
    assert.match(secTxt, /^Expires:/m, 'security.txt must have an Expires field');
  });

  it('security.txt points GitHub disclosures at the repository SECURITY.md names', () => {
    const secTxt = readFileSync(resolve(__dirname, '../public/.well-known/security.txt'), 'utf-8');
    const securityMd = readFileSync(resolve(__dirname, '../SECURITY.md'), 'utf-8');
    const policyRepo = securityMd.match(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/security\/advisories\/new/)?.[1];
    assert.ok(policyRepo, 'SECURITY.md must link the private vulnerability reporting form');

    const githubUrls = [...secTxt.matchAll(/https:\/\/github\.com\/[^\s]+/g)].map(([url]) => url);
    assert.ok(githubUrls.length > 0, 'security.txt must offer a GitHub disclosure channel');
    for (const url of githubUrls) {
      assert.ok(url.startsWith(`https://github.com/${policyRepo}/`), `${url} must name ${policyRepo}`);
    }
    assert.match(secTxt, new RegExp(`^Contact: https://github\\.com/${policyRepo}/security/advisories/new$`, 'm'));
    assert.match(secTxt, new RegExp(`^Policy: https://github\\.com/${policyRepo}/security/policy$`, 'm'));
  });
});

// Agent readiness: RFC 9727 API catalog at /.well-known/api-catalog and
// the build-time copy of the OpenAPI spec from docs/api/ into public/.
// These guardrails protect against:
//   (1) the status endpoint href drifting away from /api/health (the
//       real JSON endpoint; the apex /health serves the SPA HTML);
//   (2) variant build scripts dropping the `npm run build:openapi`
//       prefix and silently shipping web bundles without the spec;
//   (3) the openapi source under docs/ being deleted without a
//       matching removal of the build step;
//   (4) linkset[0] losing its RFC 9727 `item` enumeration (agent
//       crawlers read the catalog anchor's item links to find every API).
describe('agent readiness: api-catalog + openapi build', () => {
  const apiCatalog = JSON.parse(
    readFileSync(resolve(__dirname, '../public/.well-known/api-catalog'), 'utf-8')
  );
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

  const catalogEntry = apiCatalog.linkset[0];
  const apiEntry = apiCatalog.linkset.find((entry) => entry.anchor === 'https://api.worldmonitor.app/');

  it('linkset[0] is the catalog anchor and enumerates each API via RFC 9727 item links', () => {
    assert.equal(catalogEntry.anchor, 'https://worldmonitor.app/.well-known/api-catalog');
    assert.ok(Array.isArray(catalogEntry.item), 'linkset[0] must carry an "item" array (RFC 9727 §4)');
    assert.ok(catalogEntry.item.length > 0, 'linkset[0].item must enumerate at least one API');
    // Each item MUST resolve to a linkset context object that describes that API.
    const anchors = new Set(apiCatalog.linkset.map((entry) => entry.anchor));
    for (const item of catalogEntry.item) {
      assert.ok(item.href, 'each item entry must carry an href');
      assert.ok(
        anchors.has(item.href),
        `item href ${item.href} must match a linkset context anchor`
      );
    }
    const itemHrefs = catalogEntry.item.map((i) => i.href);
    assert.ok(itemHrefs.includes('https://api.worldmonitor.app/'), 'item list must enumerate the REST API host root');
    assert.ok(itemHrefs.includes('https://worldmonitor.app/mcp'), 'item list must enumerate the MCP server');
    assert.ok(
      itemHrefs.includes('https://www.worldmonitor.app/docs/mcp'),
      'item list must enumerate the docs MCP server (#4958 — it ran unadvertised for weeks)'
    );
  });

  // #4958 — Mintlify serves a working docs MCP server (search/retrieval over
  // the documentation) at /docs/mcp; it existed for weeks with zero
  // advertisement anywhere. Every agent-facing discovery surface must name it
  // so multi-surface MCP coverage is discoverable.
  it('advertises the docs MCP server on every discovery surface', () => {
    const docsMcpUrl = 'https://www.worldmonitor.app/docs/mcp';
    for (const surface of ['agents.md', 'api/llms.txt']) {
      const content = readFileSync(resolve(__dirname, `../public/${surface}`), 'utf-8');
      assert.ok(content.includes(docsMcpUrl), `public/${surface} must advertise the docs MCP server`);
    }
  });

  it('the docs MCP anchor describes itself with the first-party server-card (service-desc parity with product MCP)', () => {
    const docsAnchor = apiCatalog.linkset.find((e) => e.anchor === 'https://www.worldmonitor.app/docs/mcp');
    assert.ok(docsAnchor, 'api-catalog must carry a context object anchored at the docs MCP endpoint');
    const desc = docsAnchor['service-desc'] ?? [];
    // Must be the first-party card, NOT Mintlify's card (whose url 404s) — #4964 review.
    assert.ok(
      desc.some((d) => d.href === 'https://www.worldmonitor.app/.well-known/mcp/docs-server-card.json'),
      'docs MCP anchor must advertise the first-party server-card as service-desc'
    );
    assert.ok(
      !desc.some((d) => /\/docs\/\.well-known\/mcp\/server-card\.json/.test(d.href)),
      'docs MCP anchor must NOT advertise Mintlify\'s card (its url points at a dead mintlify.dev endpoint)'
    );
  });

  it('the first-party docs server-card advertises the working /docs/mcp endpoint, not the dead mintlify url', () => {
    // The whole point of #4964's fix: a card-following agent must land on an
    // endpoint that actually initializes. worldmonitor.mintlify.dev/mcp 404s;
    // www.worldmonitor.app/docs/mcp returns 200. The committed card must carry
    // the working facade URL and must not smuggle the mintlify.dev host.
    const card = JSON.parse(
      readFileSync(resolve(__dirname, '../public/.well-known/mcp/docs-server-card.json'), 'utf-8')
    );
    const WORKING = 'https://www.worldmonitor.app/docs/mcp';
    assert.equal(card.url, WORKING, 'docs card url must be the working /docs/mcp facade');
    assert.equal(card.serverUrl, WORKING, 'docs card serverUrl must be the working /docs/mcp facade');
    assert.ok(
      !JSON.stringify({ url: card.url, serverUrl: card.serverUrl }).includes('mintlify.dev'),
      'docs card endpoint fields must not point at the dead mintlify.dev host'
    );
    assert.deepEqual(card.remotes, [{ type: 'streamable-http', url: WORKING }], 'docs card remotes[].url must name the facade');
    // Under the v1 $schema the live tools/list is authoritative; the docs
    // server is anonymous, so a copied tools[] only goes stale.
    assert.equal(card.tools, undefined, 'docs card must not carry tools[]');
  });

  it('lists the docs server card in ai-catalog.json for card-following scanners', () => {
    // orank resolves a card per MCP server from ai-catalog.json entries or
    // <server URL>/server-card, matched on remotes[].url.
    const catalog = JSON.parse(readFileSync(resolve(__dirname, '../public/.well-known/ai-catalog.json'), 'utf-8'));
    const docsEntry = catalog.entries.find((e) => e.url === 'https://www.worldmonitor.app/.well-known/mcp/docs-server-card.json');
    assert.ok(docsEntry, 'ai-catalog must list the docs MCP server card');
    assert.equal(docsEntry.type, 'application/mcp-server-card+json');
  });

  it('the api host root has its own context object', () => {
    assert.ok(apiEntry, 'linkset must contain a context object anchored at https://api.worldmonitor.app/');
  });

  it('status href points at the KEYLESS compact form of /api/health', () => {
    // Two drift classes guarded here:
    //   (1) the SPA lives at /health — a bare-host href would 200 HTML and
    //       look healthy;
    //   (2) #4715 gated detailed /api/health behind an operator key, so the
    //       bare endpoint 401s keyless callers. An advertised status URL must
    //       return 2xx WITHOUT credentials — that is ?compact=1 (#4856; an
    //       agent-journey run read the stale bare-URL advertisement, got 401,
    //       and flagged the whole status surface as broken).
    const statusHref = apiEntry.status[0].href;
    assert.ok(
      statusHref.startsWith('https://api.worldmonitor.app'),
      `status href must be on api.worldmonitor.app, got: ${statusHref}`
    );
    assert.equal(
      statusHref,
      'https://api.worldmonitor.app/api/health?compact=1',
      'status href must be the keyless compact health form'
    );
  });

  it('service-desc points at /openapi.yaml with the OpenAPI media type', () => {
    const serviceDesc = apiEntry['service-desc'][0];
    assert.ok(
      serviceDesc.href.endsWith('/openapi.yaml'),
      `service-desc href must end with /openapi.yaml, got: ${serviceDesc.href}`
    );
    assert.equal(serviceDesc.type, 'application/vnd.oai.openapi');
  });

  it('also advertises a JSON service-desc at /openapi.json for JSON-only parsers', () => {
    // Some agent-readiness scanners (ora.ai / orank) run the spec straight
    // through a JSON parser; YAML input trips them ("found but failed to
    // parse"). The JSON mirror is a second service-desc so those scanners
    // have a parseable spec. YAML stays at [0] (human-readable canonical).
    // Read from apiEntry (the api.worldmonitor.app context object), not
    // linkset[0] — since #4691 added the RFC 9727 catalog anchor, linkset[0]
    // is the catalog itself (item enumeration, no service-desc). The sibling
    // /openapi.yaml assertion above already uses apiEntry for the same reason.
    const jsonDesc = apiEntry['service-desc'][1];
    assert.ok(jsonDesc, 'api anchor must have a second service-desc entry (JSON mirror)');
    assert.ok(
      jsonDesc.href.endsWith('/openapi.json'),
      `second service-desc href must end with /openapi.json, got: ${jsonDesc.href}`
    );
    assert.equal(jsonDesc.type, 'application/json');
  });

  it('has a second anchor for the MCP server-card', () => {
    const mcpEntry = apiCatalog.linkset.find((entry) => entry.anchor === 'https://worldmonitor.app/mcp');
    assert.ok(mcpEntry, 'linkset must contain an anchor for https://worldmonitor.app/mcp');
    const mcpServiceDesc = mcpEntry['service-desc']?.[0];
    assert.ok(mcpServiceDesc, 'mcp anchor must have a service-desc entry');
    assert.ok(
      mcpServiceDesc.href.endsWith('/.well-known/mcp/server-card.json'),
      `mcp service-desc href must end with /.well-known/mcp/server-card.json, got: ${mcpServiceDesc.href}`
    );
  });

  it('exposes a build:openapi script that copies docs/api → public/openapi.yaml AND emits public/openapi.json', () => {
    const buildOpenapi = pkg.scripts['build:openapi'];
    assert.ok(buildOpenapi, 'package.json must define scripts["build:openapi"]');
    assert.ok(
      buildOpenapi.includes('docs/api/worldmonitor.openapi.yaml'),
      `build:openapi must reference docs/api/worldmonitor.openapi.yaml, got: ${buildOpenapi}`
    );
    assert.ok(
      buildOpenapi.includes('public/openapi.yaml'),
      `build:openapi must write to public/openapi.yaml, got: ${buildOpenapi}`
    );
    // The JSON mirror (served at /openapi.json for JSON-only scanners) is
    // generated by scripts/build-openapi-json.mjs in the same step.
    assert.ok(
      buildOpenapi.includes('build-openapi-json.mjs'),
      `build:openapi must run scripts/build-openapi-json.mjs to emit public/openapi.json, got: ${buildOpenapi}`
    );
    assert.ok(
      existsSync(resolve(__dirname, '../scripts/build-openapi-json.mjs')),
      'scripts/build-openapi-json.mjs must exist'
    );
  });

  it('every web-variant build regenerates inventory facts and OpenAPI', () => {
    // build:desktop and build:pro are intentionally excluded — Tauri
    // sidecar builds and the standalone pro-test workspace don't ship
    // the OpenAPI spec.
    const declaredVariants = variantDashboardSource
      .match(/WEB_DASHBOARD_VARIANTS\s*=\s*\[([^\]]+)\]/)?.[1]
      .match(/'[^']+'/g)
      ?.map((value) => value.slice(1, -1));
    assert.ok(declaredVariants?.length, 'WEB_DASHBOARD_VARIANTS extraction must not be empty');

    for (const variant of ['full', ...declaredVariants]) {
      const buildName = `build:${variant}`;
      const prebuildName = `prebuild:${variant}`;
      const script = pkg.scripts[buildName];
      assert.ok(script, `package.json must define scripts["${buildName}"]`);
      assert.ok(
        script.includes('npm run build:openapi'),
        `scripts["${buildName}"] must chain "npm run build:openapi" so the web bundle ships the spec; got: ${script}`
      );
      // Inventory facts come from postinstall (npm run inventory:facts); the
      // personal build dropped the product-facts generator from every prebuild.
      assert.doesNotMatch(pkg.scripts[prebuildName] ?? '', /product:facts/);
    }
  });

  it('keeps a prebuild hook so the default `npm run build` path also copies the spec', () => {
    assert.doesNotMatch(pkg.scripts.prebuild ?? '', /product:facts/);
    assert.ok(
      pkg.scripts.prebuild?.includes('npm run build:openapi'),
      'package.json scripts["prebuild"] must copy the generated OpenAPI spec',
    );
  });

  it('openapi source exists at docs/api/worldmonitor.openapi.yaml', () => {
    // Catches the class of regression where someone cleans generated
    // artifacts and forgets to regenerate before committing — the
    // prebuild step would then fail silently at deploy time.
    const openapiPath = resolve(__dirname, '../docs/api/worldmonitor.openapi.yaml');
    assert.ok(
      existsSync(openapiPath),
      `docs/api/worldmonitor.openapi.yaml must exist — without it, build:openapi fails at deploy time`
    );
  });
});

// The MCP endpoint and OAuth protected-resource metadata must be
// self-consistent per host. The static file that used to live at
// public/.well-known/oauth-protected-resource was replaced with a
// dynamic edge function at api/oauth-protected-resource.ts that
// derives `resource` and `authorization_servers` from the request
// Host header, so every origin (apex / www / api) sees same-origin
// metadata regardless of which host the scanner entered from.
// Scanners like isitagentready.com (and Cloudflare's reference at
// mcp.cloudflare.com) enforce that `authorization_servers[*]` share
// origin with `resource` — this construction guarantees that.
describe('agent readiness: MCP/OAuth origin alignment', () => {
  it('oauth-protected-resource handler returns origin-matching metadata per host', async () => {
    // Runtime test (not source-regex): dynamically import the edge handler
    // and invoke it against synthetic Host headers to prove the response
    // is actually same-origin per host, with correct Vary + Content-Type.
    const mod = await import('../api/oauth-protected-resource.ts');
    const handler = mod.default;
    assert.equal(typeof handler, 'function', 'handler must be the default export');

    const hosts = ['worldmonitor.app', 'www.worldmonitor.app', 'api.worldmonitor.app'];
    for (const host of hosts) {
      const req = new Request(`https://${host}/.well-known/oauth-protected-resource`, {
        headers: { host },
      });
      const res = await handler(req);
      assert.equal(res.status, 200, `status 200 for ${host}`);
      assert.equal(res.headers.get('content-type'), 'application/json', `JSON for ${host}`);
      assert.equal(res.headers.get('vary'), 'Host', `Vary: Host for ${host}`);
      const json = await res.json();
      assert.equal(json.resource, `https://${host}`, `resource matches ${host}`);
      assert.deepEqual(json.authorization_servers, [`https://${host}`], `auth_servers match ${host}`);
      assert.deepEqual(json.bearer_methods_supported, ['header']);
      assert.deepEqual(json.scopes_supported, ['mcp']);
    }
  });

  it('MCP server card authentication.resource is a valid https URL on a known host', () => {
    const mcpCard = JSON.parse(
      readFileSync(resolve(__dirname, '../public/.well-known/mcp/server-card.json'), 'utf-8')
    );
    const u = new URL(mcpCard.authentication.resource);
    assert.equal(u.protocol, 'https:');
    assert.ok(
      ['worldmonitor.app', 'www.worldmonitor.app', 'api.worldmonitor.app'].includes(u.host),
      `unexpected host: ${u.host}`
    );
  });

  it('api/mcp.ts resource_metadata is host-derived, not hardcoded', () => {
    // After the structural split (refactor PR), the host-derivation
    // (`requestHost = req.headers.get('host') ?? ...`) lives in
    // api/mcp/handler.ts and the template-literal that emits
    // `resource_metadata="${url}"` lives in api/_www-authenticate.ts (the
    // `wwwAuthHeader` helper, re-exported by api/mcp/auth.ts since #4840 so
    // the gateway's API-key challenge lives alongside it). Concatenate all three so the sub-greps
    // below still see the same byte surface they did pre-split.
    const source = readFileSync(resolve(__dirname, '../api/mcp/handler.ts'), 'utf-8')
      + '\n'
      + readFileSync(resolve(__dirname, '../api/mcp/auth.ts'), 'utf-8')
      + '\n'
      + readFileSync(resolve(__dirname, '../api/_www-authenticate.ts'), 'utf-8');
    // Must NOT contain a hardcoded apex or api URL for resource_metadata —
    // that regressed once (PR #3351 review: apex pointer emitted from
    // api.worldmonitor.app/mcp 401s) and the grep-only test didn't catch it.
    assert.ok(
      !/resource_metadata="https:\/\/(?:api\.)?worldmonitor\.app\/\.well-known\//.test(source),
      'api/mcp.ts must not hardcode resource_metadata URL — derive from request host'
    );
    // Must contain a template-literal construction that uses a host variable.
    assert.match(
      source,
      /resource_metadata="\$\{[A-Za-z_][A-Za-z0-9_]*\}"|`[^`]*resource_metadata="\$\{[^}]+\}"/,
      'api/mcp.ts must construct resource_metadata from a host-derived variable'
    );
    // Must derive the origin from the request, through the shared resolver that
    // validates Host against the allowlist (api/_agent-metadata.ts). Reading the
    // raw header directly would reflect a spoofed Host into the discovery
    // pointer, and could name a host whose metadata document we never serve.
    assert.match(
      source,
      /resolveMetadataOrigin\(req(?:uest)?\)/,
      'api/mcp.ts must derive the resource_metadata origin via resolveMetadataOrigin'
    );
  });

  // RFC 8414 authorization-server metadata is ALSO a dynamic edge fn (was a
  // static file at public/.well-known/oauth-authorization-server). Host
  // derivation keeps `issuer` == the origin the PRM advertises, so ora.ai/orank
  // can cross-check that PRM `authorization_servers` resolves to an AS document
  // whose `issuer` matches — while same-origin also satisfies isitagentready.
  it('oauth-authorization-server handler returns host-derived RFC 8414 metadata + WorkOS agent_auth block', async () => {
    const mod = await import('../api/oauth-authorization-server.ts');
    const handler = mod.default;
    assert.equal(typeof handler, 'function', 'handler must be the default export');

    const hosts = ['worldmonitor.app', 'www.worldmonitor.app', 'api.worldmonitor.app'];
    for (const host of hosts) {
      const req = new Request(`https://${host}/.well-known/oauth-authorization-server`, {
        headers: { host },
      });
      const res = await handler(req);
      assert.equal(res.status, 200, `status 200 for ${host}`);
      assert.equal(res.headers.get('content-type'), 'application/json', `JSON for ${host}`);
      assert.equal(res.headers.get('vary'), 'Host', `Vary: Host for ${host}`);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=3600', `cacheable for ${host}`);
      const json = await res.json();

      // RFC 8414 issuer + endpoints are all self-origin.
      assert.equal(json.issuer, `https://${host}`, `issuer matches ${host}`);
      assert.equal(json.authorization_endpoint, `https://${host}/oauth/authorize`);
      assert.equal(json.token_endpoint, `https://${host}/oauth/token`);
      assert.equal(json.registration_endpoint, `https://${host}/oauth/register`);
      assert.deepEqual(json.code_challenge_methods_supported, ['S256']);
      assert.deepEqual(json.token_endpoint_auth_methods_supported, ['none']);
      assert.deepEqual(json.scopes_supported, ['mcp']);

      // WorkOS auth.md agent_auth discovery block (only `anonymous` is honest —
      // WM has no ID-JAG identity endpoint, so identity_assertion is not advertised).
      assert.ok(json.agent_auth, `agent_auth block present for ${host}`);
      // ora.ai compares skill with the /auth.md published on the scanned domain,
      // so every host names the apex copy. The apex serves it because /auth.md
      // is exempt from the Cloudflare apex→www 301 (ARCHITECTURE.md §2).
      assert.equal(json.agent_auth.skill, 'https://worldmonitor.app/auth.md', `skill is the apex /auth.md for ${host}`);
      assert.equal(json.agent_auth.register_uri, `https://${host}/oauth/register`);
      // auth.md v0.2's identity_endpoint takes {"type":"anonymous"} and returns
      // an identity_assertion; /oauth/register is RFC 7591 DCR, so it must not
      // be advertised under that key.
      assert.equal(json.agent_auth.identity_endpoint, undefined);
      assert.deepEqual(json.agent_auth.identity_types_supported, ['anonymous']);
      // Only `access_token` — an api_key is user-minted (carries a user
      // identity), so it is not an anonymous-registration credential.
      assert.deepEqual(
        json.agent_auth.anonymous.credential_types_supported,
        ['access_token'],
        `anonymous sibling block enumerates credential types for ${host}`
      );
      // The anonymous registration method requires a claim URI (readiness
      // scanners reject the method without it). Anonymous credentials are
      // claimed at authorization time, so claim_uri == the authorization
      // endpoint. Advertised both at the agent_auth top level (parallel to
      // register_uri) and inside the anonymous method object.
      assert.equal(
        json.agent_auth.claim_uri,
        `https://${host}/oauth/authorize`,
        `agent_auth.claim_uri = authorization endpoint for ${host}`
      );
      assert.equal(
        json.agent_auth.anonymous.claim_uri,
        `https://${host}/oauth/authorize`,
        `anonymous method advertises claim_uri for ${host}`
      );
    }
  });

  // The Host header is client-controlled; both discovery handlers derive their
  // origin through the shared allowlist (api/_agent-metadata.ts) so a spoofed
  // Host cannot be reflected into issuer/resource/endpoints. They also guard the
  // HTTP method (read-only docs).
  it('discovery handlers reject spoofed Host (apex fallback) and non-GET methods', async () => {
    const prm = (await import('../api/oauth-protected-resource.ts')).default;
    const as = (await import('../api/oauth-authorization-server.ts')).default;

    // Spoofed / unrecognized Host → apex fallback, never reflected.
    for (const host of ['evil.com', 'worldmonitor.app.evil.com', 'evilworldmonitor.app', 'x.y.worldmonitor.app']) {
      const prmRes = await prm(new Request('https://worldmonitor.app/.well-known/oauth-protected-resource', { headers: { host } }));
      const prmJson = await prmRes.json();
      assert.equal(prmJson.resource, 'https://worldmonitor.app', `PRM must not reflect spoofed host ${host}`);
      assert.deepEqual(prmJson.authorization_servers, ['https://worldmonitor.app']);

      const asRes = await as(new Request('https://worldmonitor.app/.well-known/oauth-authorization-server', { headers: { host } }));
      const asJson = await asRes.json();
      assert.equal(asJson.issuer, 'https://worldmonitor.app', `AS must not reflect spoofed host ${host}`);
      assert.equal(asJson.token_endpoint, 'https://worldmonitor.app/oauth/token', `AS token_endpoint must not carry spoofed host ${host}`);
      assert.equal(asJson.agent_auth.register_uri, 'https://worldmonitor.app/oauth/register');
      assert.equal(asJson.agent_auth.claim_uri, 'https://worldmonitor.app/oauth/authorize', `AS claim_uri must not carry spoofed host ${host}`);
      assert.equal(asJson.agent_auth.anonymous.claim_uri, 'https://worldmonitor.app/oauth/authorize');
    }

    // Legit subdomain still self-describes.
    const variant = await as(new Request('https://tech.worldmonitor.app/.well-known/oauth-authorization-server', { headers: { host: 'tech.worldmonitor.app' } }));
    assert.equal((await variant.json()).issuer, 'https://tech.worldmonitor.app');

    // Method guard: OPTIONS → 204 preflight, other verbs → 405 + Allow, GET → 200.
    for (const handler of [prm, as]) {
      const opt = await handler(new Request('https://worldmonitor.app/x', { method: 'OPTIONS', headers: { host: 'worldmonitor.app' } }));
      assert.equal(opt.status, 204, 'OPTIONS is a CORS preflight');
      assert.equal(opt.headers.get('access-control-allow-methods'), 'GET, HEAD, OPTIONS');

      const post = await handler(new Request('https://worldmonitor.app/x', { method: 'POST', headers: { host: 'worldmonitor.app' } }));
      assert.equal(post.status, 405, 'non-GET/HEAD is rejected');
      assert.equal(post.headers.get('allow'), 'GET, HEAD, OPTIONS');

      const get = await handler(new Request('https://worldmonitor.app/x', { headers: { host: 'worldmonitor.app' } }));
      assert.equal(get.status, 200, 'GET is served');
    }
  });
});

// Agent readiness: a WorkOS-spec /auth.md walkthrough that agents can fetch to
// learn the registration flow, cross-linked from the AS metadata agent_auth.skill.
describe('agent readiness: auth.md walkthrough', () => {
  const authMd = readFileSync(resolve(__dirname, '../public/auth.md'), 'utf-8');

  it('opens with its title and describes API key and OAuth authentication', () => {
    assert.match(
      authMd,
      /^# WorldMonitor — Agent Authentication \(auth\.md\)\n/,
      'auth.md must open directly with its H1 for scanner compatibility'
    );
    assert.match(authMd, /API keys?.*OAuth|OAuth.*API keys?/i);
  });

  it('publishes /auth.md with the WorkOS-prescribed sections', () => {
    for (const heading of ['Discover', 'Pick a method', 'Register', 'Claim', 'Use the credential', 'Errors', 'Revocation']) {
      assert.match(
        authMd,
        new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'm'),
        `auth.md must have a "## ${heading}" section`
      );
    }
  });

  it('references the auth.md spec and carries the spec anchor keywords', () => {
    assert.ok(authMd.includes('https://workos.com/auth-md'), 'auth.md must reference the WorkOS spec');
    for (const keyword of ['agent_auth', 'register_uri', 'claim_uri', 'identity_assertion', 'id-jag', 'WWW-Authenticate']) {
      assert.ok(authMd.includes(keyword), `auth.md must mention spec keyword: ${keyword}`);
    }
  });

  it('keeps every section header within the scanner read budget (~5 KB truncation)', () => {
    // isitagentready / ora.ai reads only the first ~5 KB of auth.md; any `## `
    // section header past that byte offset is dropped and the section reported
    // missing (regressing auth-md-structure). This has bitten us before, so
    // guard with a conservative ceiling — an edit that bloats an earlier
    // section fails HERE instead of silently regressing the live scan.
    const HEADER_BUDGET = 4800;
    let offset = 0;
    for (const line of authMd.split('\n')) {
      if (line.startsWith('## ')) {
        assert.ok(
          offset < HEADER_BUDGET,
          `"${line.trim()}" starts at byte ${offset}; must be < ${HEADER_BUDGET} to survive the ~5 KB scanner truncation`
        );
      }
      offset += Buffer.byteLength(line, 'utf8') + 1; // + the newline that split() dropped
    }
  });

  it('advertises a register endpoint that resolves (matches the agent_auth register_uri path)', () => {
    assert.match(
      authMd,
      /https:\/\/(?:api\.)?worldmonitor\.app\/oauth\/register/,
      'auth.md must document the reachable /oauth/register endpoint so the discovery chain is not stale'
    );
  });
});

// orank "Markdown URL fallback": homepage /index.md already returns markdown,
// but the scanner sampled GET /api/download as the content page and then
// requested /api/download.md. That path used to hit api/[...notfound].ts as
// JSON 404. Cloudflare Markdown for Agents cannot fill this gap — it converts
// HTML only when Accept: text/markdown, and /api/download is a 302, not HTML.
describe('agent readiness: /api/download.md URL twin', () => {
  const downloadMdPath = resolve(__dirname, '../public/api/download.md');
  const downloadMd = readFileSync(downloadMdPath, 'utf-8');

  it('publishes heading-led markdown at public/api/download.md', () => {
    assert.ok(existsSync(downloadMdPath), 'expected public/api/download.md (markdown twin of GET /api/download)');
    assert.match(downloadMd, /^# /m, '/api/download.md must open with a heading so scanners accept a non-HTML body');
    assert.match(downloadMd, /platform=windows-exe/);
    assert.match(downloadMd, /platform=macos-arm64/);
    assert.match(downloadMd, /platform=linux-appimage/);
  });
});

// #4952 — a named `User-agent` group replaces the `*` group for that crawler.
// Autonomous search crawlers restate the full `*` rule set. User-triggered
// fetchers keep the bounded path protections but can open shared map links.
// Autonomous AI crawlers (search indexers AND training crawlers of vendors
// whose assistants cite us) share one group. The bulk-scraper group stays a
// hard `Disallow: /`.
describe('agent readiness: robots.txt AI crawler policy', () => {
  const robotsSource = readFileSync(resolve(__dirname, '../public/robots.www.txt'), 'utf-8');

  const groups = parseRobotsGroups(robotsSource);
  const starGroup = groups.find((g) => g.agents.includes('*'));
  const aiAllowGroup = groups.find((g) => g.agents.includes('gptbot'));
  const userFetchGroup = groups.find((g) => g.agents.includes('chatgpt-user'));
  const trainingBlockGroup = groups.find((g) => g.agents.includes('ccbot'));

  const REQUIRED_AI_SEARCH_AGENTS = [
    'oai-searchbot',
    'claude-searchbot',
    'perplexitybot',
    'duckassistbot',
  ];
  // Training crawlers / training-control tokens. Allowed because ai-train=yes.
  const REQUIRED_AI_TRAINING_AGENTS = [
    'gptbot',
    'claudebot',
    'google-extended',
    'applebot-extended',
  ];
  const REQUIRED_USER_FETCH_AGENTS = [
    'chatgpt-user',
    'claude-user',
    'perplexity-user',
    'mistralai-user',
  ];
  const BLOCKED_TRAINING_AGENTS = ['ccbot', 'bytespider'];

  it('explicitly allows the AI search and training crawlers in one named group', () => {
    assert.ok(aiAllowGroup, 'robots.txt must have a named AI crawler group (GPTBot et al.)');
    for (const agent of [...REQUIRED_AI_SEARCH_AGENTS, ...REQUIRED_AI_TRAINING_AGENTS]) {
      assert.ok(
        aiAllowGroup.agents.includes(agent),
        `AI crawler group must include User-agent: ${agent}`
      );
    }
    assert.ok(
      aiAllowGroup.rules.includes('allow: /'),
      'AI search group must Allow: /'
    );
  });

  it('keeps the AI allow-group rules in parity with the `*` group', () => {
    assert.ok(starGroup, 'robots.txt must have a `User-agent: *` group');
    assert.deepStrictEqual(
      [...aiAllowGroup.rules].sort(),
      [...starGroup.rules].sort(),
      'the AI allow-group must restate the exact `*` rule set — named groups do not inherit, so a drift here silently opens /api/ (or blocks paths) for AI crawlers'
    );
  });

  it('keeps user-triggered fetchers in their own crawl-permitting group', () => {
    assert.ok(userFetchGroup, 'robots.txt must have a user-triggered assistant group');
    for (const agent of REQUIRED_USER_FETCH_AGENTS) {
      assert.ok(userFetchGroup.agents.includes(agent), `user fetch group must include User-agent: ${agent}`);
      assert.ok(!aiAllowGroup.agents.includes(agent), `${agent} must not inherit autonomous crawl limits`);
    }
    assert.ok(userFetchGroup.rules.includes('allow: /'), 'user fetch group must Allow: /');
  });

  it('disallows the bulk training-only scrapers entirely', () => {
    assert.ok(trainingBlockGroup, 'robots.txt must have a training-scraper block group (CCBot et al.)');
    for (const agent of BLOCKED_TRAINING_AGENTS) {
      assert.ok(
        trainingBlockGroup.agents.includes(agent),
        `training block group must include User-agent: ${agent}`
      );
    }
    assert.deepStrictEqual(
      trainingBlockGroup.rules,
      ['disallow: /'],
      'training-only scrapers must be blocked with exactly `Disallow: /`'
    );
  });

  it('never lists an allowed AI agent in the blocked group (and vice versa)', () => {
    for (const agent of [
      ...REQUIRED_AI_SEARCH_AGENTS,
      ...REQUIRED_AI_TRAINING_AGENTS,
      ...REQUIRED_USER_FETCH_AGENTS,
    ]) {
      assert.ok(
        !trainingBlockGroup.agents.includes(agent),
        `${agent} drives citations and must not be in the blocked group`
      );
    }
    for (const agent of BLOCKED_TRAINING_AGENTS) {
      assert.ok(
        !aiAllowGroup.agents.includes(agent),
        `${agent} is training-only and must not be in the allow group`
      );
    }
  });

  it('every crawl-permitting group keeps /api/ protected', () => {
    for (const group of groups) {
      if (group.rules.includes('allow: /')) {
        assert.ok(
          group.rules.includes('disallow: /api/'),
          `group [${group.agents.join(', ')}] allows crawling but does not restate Disallow: /api/`
        );
      }
    }
  });
});

// #7660: autonomous crawl groups block unbounded coordinate state and /tmp/
// paths. User-triggered fetchers can follow shared map links.
describe('agent readiness: crawl-budget disallows (#7660)', () => {
  const CRAWL_BUDGET_DISALLOWS = [
    'disallow: /tmp/',
    'disallow: /*?*lat=',
    'disallow: /*?*lon=',
    'disallow: /*?*zoom=',
  ];

  // The inverse half of the contract, and the more important one. robots.txt is
  // a crawl control, not a canonicalization tool: a disallowed URL is never
  // fetched, so Google reads neither its rel=canonical nor its redirect. These
  // families already consolidate — middleware 308s a crawler off ref/
  // wm_referral/utm_* (a 308 passes the link equity that affiliates' pasted
  // /pro?ref=… URLs carry), and wm_content_* answers 200 with a canonical.
  // Blocking them would replace a working mechanism with a worse one.
  const MUST_STAY_CRAWLABLE = [
    'disallow: /*?*ref=',
    'disallow: /*?*wm_referral=',
    'disallow: /*?*wm_content_',
    'disallow: /*?*utm_',
    // `layers` looks like map state but is not what makes the space unbounded.
    // src/utils/urlState.ts sets `zoom` unconditionally on every share URL, so
    // `/*?*zoom=` already catches the whole family; `layers` added no coverage
    // and disallowed the bounded dashboard CTAs build-use-cases.mjs publishes
    // with layers and no coordinates (PR #7689 review).
    'disallow: /*?*layers=',
  ];

  for (const file of ['robots.www.txt', 'robots.variant.txt']) {
    it(`${file} lets user-triggered assistant fetchers open shared map links`, () => {
      const groups = parseRobotsGroups(readFileSync(resolve(__dirname, `../public/${file}`), 'utf-8'));
      const starGroup = groups.find((group) => group.agents.includes('*'));
      const userFetchGroup = groups.find((group) => group.agents.includes('chatgpt-user'));
      assert.ok(starGroup, `${file} must have a default group`);
      assert.ok(userFetchGroup, `${file} must have a user-triggered assistant group`);
      for (const agent of ['chatgpt-user', 'claude-user', 'perplexity-user', 'mistralai-user']) {
        assert.ok(userFetchGroup.agents.includes(agent), `${file} must include ${agent}`);
      }
      const coordinateRules = new Set(CRAWL_BUDGET_DISALLOWS.slice(1));
      const expectedRules = starGroup.rules.filter((rule) => !coordinateRules.has(rule));
      assert.deepStrictEqual(
        [...userFetchGroup.rules].sort(),
        [...expectedRules].sort(),
        `${file} user-triggered fetchers must omit only the coordinate rules`
      );
    });

    it(`${file} carries every crawl-budget disallow in every autonomous crawl group`, () => {
      const groups = parseRobotsGroups(readFileSync(resolve(__dirname, `../public/${file}`), 'utf-8'));
      const crawling = groups.filter((g) => g.rules.includes('allow: /'));
      const autonomous = crawling.filter((g) => !g.agents.includes('chatgpt-user'));
      assert.ok(autonomous.length >= 2, `${file} must have a * group and a named AI group that crawl`);
      for (const group of autonomous) {
        for (const rule of CRAWL_BUDGET_DISALLOWS) {
          assert.ok(
            group.rules.includes(rule),
            `${file} group [${group.agents.join(', ')}] is missing \`${rule.replace('disallow:', 'Disallow:')}\` — ` +
              'robots groups do not inherit, so this crawler still burns budget on the space the others no longer crawl'
          );
        }
      }
      for (const group of crawling) {
        for (const rule of MUST_STAY_CRAWLABLE) {
          assert.ok(
            !group.rules.includes(rule),
            `${file} group [${group.agents.join(', ')}] added \`${rule.replace('disallow:', 'Disallow:')}\` — ` +
              'that family already consolidates via a 308 or a rel=canonical, and a disallowed URL is never ' +
              'fetched, so blocking it strands the signal instead of folding it'
          );
        }
      }
    });
  }

  it('leaves the canonical param-free documents crawlable', () => {
    // The disallows are query-scoped on purpose: `/dashboard` and `/pro` are
    // the consolidation targets the canonicals point at, so blocking the bare
    // paths would delete the pages this change exists to protect.
    for (const file of ['robots.www.txt', 'robots.variant.txt']) {
      const body = readFileSync(resolve(__dirname, `../public/${file}`), 'utf-8');
      assert.doesNotMatch(body, /^Disallow: \/dashboard$/m, `${file} must keep /dashboard crawlable`);
      assert.doesNotMatch(body, /^Disallow: \/docs$/m, `${file} must keep /docs crawlable`);
      for (const line of body.split('\n')) {
        const match = /^Disallow: (\/\*.*)$/.exec(line.trim());
        if (!match) continue;
        assert.match(
          match[1],
          /^\/\*\?\*/,
          `${line.trim()} must be query-scoped (\`/*?*\`) — a bare wildcard would block the canonical document too`
        );
      }
    }
  });

  // Rule presence is not the contract — what the rules MATCH is. This resolves
  // real request paths against the `*` group using Google's documented
  // semantics (`*` = any sequence, `$` = end of URL, longest match wins,
  // Allow beats an equal-length Disallow) so a future edit that quietly
  // narrows or widens a pattern fails here rather than in Search Console.
  describe('resolved against the paths Search Console actually reported', () => {
    const escapeRe = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Google's robots.txt path matching: `*` is any sequence, a trailing `$`
    // anchors the end of the URL (query string included), everything else is
    // a literal prefix match.
    const pathMatches = (pattern, path) => {
      const source = pattern.endsWith('$')
        ? `^${pattern.slice(0, -1).split('*').map(escapeRe).join('.*')}$`
        : `^${pattern.split('*').map(escapeRe).join('.*')}`;
      return new RegExp(source).test(path);
    };

    const ruleCache = new Map();
    const starGroupRules = (file) => {
      if (!ruleCache.has(file)) {
        const groups = parseRobotsGroups(readFileSync(resolve(__dirname, `../public/${file}`), 'utf-8'));
        const star = groups.find((g) => g.agents.includes('*'));
        assert.ok(star, `${file} must have a * group`);
        ruleCache.set(
          file,
          star.rules.map((rule) => {
            const [key, ...rest] = rule.split(': ');
            return { allow: key === 'allow', pattern: rest.join(': ') };
          })
        );
      }
      return ruleCache.get(file);
    };

    const isCrawlable = (file, path) => {
      let best = null;
      for (const rule of starGroupRules(file)) {
        if (!pathMatches(rule.pattern, path)) continue;
        if (!best || rule.pattern.length > best.pattern.length) best = rule;
        else if (rule.pattern.length === best.pattern.length && rule.allow) best = rule;
      }
      return best ? best.allow : true;
    };

    // Verbatim shapes from the 2026-09-04 GSC "Page with redirect" and
    // "Not found (404)" exports.
    const BLOCKED = [
      '/?lat=20.0000&lon=0.0000&zoom=1.00&view=global&timeRange=7d&layers=conflicts,bases',
      '/index?lat=NaN&lon=NaN&zoom=2.50&view=america&timeRange=7d&layers=conflicts',
      '/dashboard?lat=20.0000&lon=0.0000&zoom=1.00',
      '/tmp/gem-pipelines.json',
    ];
    const CRAWLABLE = [
      '/',
      '/dashboard',
      '/pro',
      '/countries/iran/',
      '/compare/iran-vs-israel/',
      '/docs/mcp-overview',
      // #7660 proposed Disallow: /docs/_next/ for the 139 stale hashed chunks
      // that 404 after every Mintlify redeploy. Measured instead: a live
      // /docs/* page pulls 76 assets from that prefix, JS and CSS both, and
      // the current deploy's assets carry the same `?dpl=` pin as the stale
      // ones — no pattern separates them. Blocking it would hide every render
      // resource from Googlebot on the pages already stuck in "crawled -
      // currently not indexed", which costs more than a cheap 404.
      '/docs/_next/static/chunks/462bacc63bed9960.css?dpl=dpl_6TpKozpvfbf2eKSzPrrzWSvEC9fx',
      // docs/embed-live-map.mdx documents this exact iframe src. The map-param
      // rules would otherwise stop Googlebot fetching our widget while it
      // renders a partner's page.
      '/embed?layers=conflicts,earthquakes,weather&center=20,0&zoom=1&theme=dark&variant=full',
      '/embed?panel=fear-greed&theme=dark',
      // Bounded, already-consolidating families: the middleware 308 and the
      // rel=canonical only work if the crawler is allowed to fetch them.
      '/pro?ref=affiliate',
      '/pro?wm_referral=abc123',
      '/pro?wm_content_source=use-cases&wm_content_medium=internal',
      '/countries/iran/?utm_source=newsletter',
      '/blog/',
      '/api/llms.txt',
    ];

    for (const file of ['robots.www.txt', 'robots.variant.txt']) {
      it(`${file} blocks the reported crawl-waste URLs`, () => {
        for (const path of BLOCKED) {
          assert.equal(isCrawlable(file, path), false, `${file} must block ${path}`);
        }
      });

      it(`${file} still allows the canonical corpus`, () => {
        for (const path of CRAWLABLE) {
          // /pro and its query forms are deliberately Disallowed on variant
          // hosts (#6835) — /pro/welcome.html stays 200 there.
          if (file === 'robots.variant.txt' && path.startsWith('/pro')) continue;
          assert.equal(isCrawlable(file, path), true, `${file} must keep ${path} crawlable`);
        }
      });
    }

  });
});

describe('vercel deployment excludes api test files', () => {
  // Vercel deploys every non-underscore file under api/ as a live serverless
  // function. A deployed *.test.mjs is a public endpoint that executes its
  // whole node:test suite (with production env + Sentry) on every request —
  // WORLDMONITOR-VD flooded Sentry with "Upstash Redis is not configured"
  // because wm-session.test.mjs deletes the Upstash env vars to exercise the
  // fail-closed path, and something polls /api/wm-session.test every ~2 min.
  const vercelignore = readFileSync(resolve(__dirname, '../.vercelignore'), 'utf-8');
  const ignoreRules = vercelignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  const collectApiTestFiles = (dir) => {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) found.push(...collectApiTestFiles(full));
      else if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) found.push(full);
    }
    return found;
  };
  const apiTestFiles = collectApiTestFiles(resolve(__dirname, '../api'));

  it('.vercelignore excludes api/**/*.test.mjs', () => {
    assert.ok(
      ignoreRules.includes('api/**/*.test.mjs'),
      '.vercelignore must contain "api/**/*.test.mjs" — without it every api test file deploys as a live production function'
    );
  });

  it('every api test file uses the .test.mjs extension the ignore rule covers', () => {
    assert.ok(apiTestFiles.length > 0, 'expected api test files to exist (walker broke?)');
    for (const file of apiTestFiles) {
      assert.match(
        file,
        /\.test\.mjs$/,
        `${file}: api test files must end in .test.mjs so the .vercelignore rule excludes them from deployment — extend both if introducing a new extension`
      );
    }
  });
});

// Registry branding + ARD catalog (ora.ai Discovery checks). The MCP
// server-card must carry the full branding trio (name, icon, description —
// `registry-branding`), and /.well-known/ai-catalog.json publishes the ARD
// manifest (`ard-catalog` bonus): host identity plus domain-anchored
// urn:air: entries, each with a media type, URL, and trust manifest —
// mirroring ora's own /api/ard/catalog dialect, which is what their parser
// reads.
describe('agent readiness: registry branding + ARD catalog', () => {
  const serverCard = JSON.parse(
    readFileSync(resolve(__dirname, '../public/.well-known/mcp/server-card.json'), 'utf-8')
  );
  const aiCatalog = JSON.parse(
    readFileSync(resolve(__dirname, '../public/.well-known/ai-catalog.json'), 'utf-8')
  );

  it('server-card carries the full branding trio and the icon asset exists', () => {
    assert.ok(serverCard.name, 'server-card must have a name');
    assert.ok(serverCard.description, 'server-card must have a description');
    assert.match(
      serverCard.icon ?? '',
      /^https:\/\/(www\.)?worldmonitor\.app\//,
      'server-card icon must be an absolute worldmonitor.app URL'
    );
    const iconPath = new URL(serverCard.icon).pathname;
    assert.ok(
      existsSync(resolve(__dirname, `../public${iconPath}`)),
      `server-card icon must point at a real public asset (public${iconPath})`
    );
  });

  it('ai-catalog.json declares the World Monitor host identity', () => {
    assert.strictEqual(aiCatalog.specVersion, '1.0');
    assert.strictEqual(aiCatalog.host?.displayName, 'World Monitor');
    assert.strictEqual(aiCatalog.host?.identifier, 'did:web:worldmonitor.app');
    assert.ok(Array.isArray(aiCatalog.entries) && aiCatalog.entries.length >= 2);
  });

  it('every ai-catalog entry is domain-anchored and complete', () => {
    for (const entry of aiCatalog.entries) {
      const label = `ai-catalog entry ${entry.identifier}`;
      assert.match(
        entry.identifier ?? '',
        /^urn:air:worldmonitor\.app:[a-z-]+:[a-z0-9-]+$/,
        `${label} must be a domain-anchored urn:air URN`
      );
      assert.ok(entry.displayName, `${label} needs a displayName`);
      assert.ok(entry.type, `${label} needs a media type`);
      assert.ok(entry.description, `${label} needs a description`);
      assert.match(
        entry.url ?? '',
        /^https:\/\/(www\.)?worldmonitor\.app\//,
        `${label} URL must be same-origin`
      );
      assert.strictEqual(
        entry.trustManifest?.identity,
        'did:web:worldmonitor.app',
        `${label} trust identity must be the domain DID`
      );
    }
  });

  it('the ai-catalog MCP entry points at the real server-card path', () => {
    const mcpEntry = aiCatalog.entries.find((e) => e.type === 'application/mcp-server-card+json');
    assert.ok(mcpEntry, 'ai-catalog must list the MCP server');
    assert.ok(
      mcpEntry.url.endsWith('/.well-known/mcp/server-card.json'),
      'MCP entry URL must target the published server-card'
    );
    assert.ok(
      existsSync(resolve(__dirname, '../public/.well-known/agent-skills/index.json')) ===
        aiCatalog.entries.some((e) => e.url.endsWith('/.well-known/agent-skills/index.json')),
      'agent-skills entry must exist iff the skills index is published'
    );
  });
});

describe('variant subdomain dashboard SEO (#4996)', () => {

  const variantHtmlSource = readFileSync(resolve(__dirname, '../src/config/variant-dashboard-html.ts'), 'utf-8');
  const generatorArrayMatch = variantHtmlSource.match(/WEB_DASHBOARD_VARIANTS = \[([^\]]+)\]/);
  const generatorVariants = (generatorArrayMatch?.[1] ?? '')
    .split(',')
    .map((s) => s.trim().replace(/['"]/g, ''))
    .filter(Boolean)
    .sort();

  it('vite build emits the variant dashboard files the rewrites point at (web full build only)', () => {
    assert.match(
      viteConfigSource,
      /!isDesktopBuild && activeVariant === 'full' && variantDashboardHtmlPlugin\(\)/,
      'variantDashboardHtmlPlugin must be registered for web full builds'
    );
  });
});

// NLWeb schemamap (orank "NLWeb Schema Feeds"): keep the file published and
// discoverable without advertising it through robots.txt. Lighthouse rejects
// the emerging `Schemamap:` directive as unknown, dropping SEO 100 -> 92 on
// every route; #4835 tracks the upstream safelist unblock. Every <loc> must
// still resolve to a tracked file or a live route — a schemamap pointing at a
// 404 is worse than none (same dead-pointer class as the deleted Wikidata QID
// incident).
describe('NLWeb schemamap (/schemamap.xml)', () => {
  const schemamapSource = readFileSync(resolve(__dirname, '../public/schemamap.xml'), 'utf-8');

  it('keeps the file published without an unsupported robots.txt directive', () => {
    assert.doesNotMatch(
      robotsSource,
      /^Schemamap:/mi,
      'Lighthouse rejects Schemamap as an unknown robots.txt directive; see #4835'
    );
    assert.match(schemamapSource, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.ok(
      schemamapSource.includes('<schemamap xmlns="http://www.nlweb.ai/schemas/schemamap/0.1">'),
      'schemamap must declare the NLWeb schemamap namespace'
    );
  });

  it('pairs every schemamap entry with a schema.org type', () => {
    const locs = [...schemamapSource.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.ok(locs.length >= 3, 'schemamap must index at least the homepage, blog, and RSS feed');
    // Line-anchored so the explanatory XML comment (which names the tags) doesn't count.
    const entries = schemamapSource.match(/^ {2}<url>$/gm) || [];
    const schemas = schemamapSource.match(/<schema>https:\/\/schema\.org\/[A-Za-z]+<\/schema>/g) || [];
    assert.equal(entries.length, locs.length);
    assert.equal(schemas.length, locs.length, 'every schemamap entry needs a schema.org type');
  });
});

// Docs MCP facade: /docs/mcp must hit api/docs-mcp.ts (which lifts the
// upstream's protocol-level tool-call failures into real JSON-RPC errors)
// BEFORE the catch-all /docs/:match* Mintlify rewrite — rewrites are
// first-match-wins, so ordering is load-bearing.
describe('docs MCP facade (/docs/mcp)', () => {

  it('the first-party docs server card still points at the facade URL', () => {
    const card = JSON.parse(
      readFileSync(resolve(__dirname, '../public/.well-known/mcp/docs-server-card.json'), 'utf-8')
    );
    assert.equal(card.url, 'https://www.worldmonitor.app/docs/mcp');
    assert.equal(card.serverUrl, 'https://www.worldmonitor.app/docs/mcp');
  });
});

// Modular llms.txt (orank "Modular llms.txt per product area"): section-scoped
// files must exist and the site-wide llms.txt must cross-link every section so
// agents can discover them without probing paths blind.
describe('section-scoped llms.txt files', () => {
  it('tracked section files exist', () => {
    for (const path of ['../public/api/llms.txt', '../public/developers/llms.txt', '../blog-site/src/pages/llms.txt.ts']) {
      assert.ok(existsSync(resolve(__dirname, path)), `${path} must exist`);
    }
  });

});

describe('skeleton brand text extraction (#5541)', () => {
  const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');

  it('.skeleton-brand raw textContent does not contain "WWorld"', () => {
    const match = indexHtml.match(/<div class="skeleton-brand">([\s\S]*?)<\/div>/);
    assert.ok(match, 'index.html must contain .skeleton-brand element');
    // Simulate raw textContent: strip all HTML tags
    const rawText = match[1].replace(/<[^>]+>/g, '');
    assert.doesNotMatch(rawText, /WWorld/, 'skeleton-brand raw text must not concatenate as "WWorld Monitor"');
    assert.match(rawText, /World Monitor/, 'skeleton-brand raw text must contain "World Monitor"');
  });

  it('.skeleton-brand-mark is aria-hidden and has no text content', () => {
    const markMatch = indexHtml.match(/<span class="skeleton-brand-mark"[^>]*>([\s\S]*?)<\/span>/);
    assert.ok(markMatch, 'index.html must contain .skeleton-brand-mark element');
    assert.match(markMatch[0], /aria-hidden="true"/, 'skeleton-brand-mark must be aria-hidden');
    const markText = markMatch[1].replace(/<[^>]+>/g, '').trim();
    assert.equal(markText, '', 'skeleton-brand-mark must have no text content (use CSS ::after instead)');
  });

  it('.skeleton-brand-mark renders "W" via CSS content pseudo-element', () => {
    assert.match(indexHtml, /\.skeleton-brand-mark::after\s*\{\s*content:\s*"W"\s*\}/, 'skeleton-brand-mark must render W via CSS ::after content');
  });
});

// #6832/#6833/#6834/#6835/#6836 — one Vercel project serves every host, so
// shared HTML/XML on tech/finance/commodity/happy/energy/api is crawled as
// alternates (or, for RSS, duplicates with no user-selected canonical).
describe('variant-host canonicalization (#6833–#6836)', () => {

  const SHARED_WWW_PREFIXES = [
    'blog',
    'country-instability-index',
    'countries',
    'chokepoints',
    'compare',
    'research',
    'tools',
    'crises',
    'use-cases',
    'reference',
    'sources',
  ];

  it('blog HTML autodiscovery points at the absolute www feed (#6834)', () => {
    const layout = readFileSync(resolve(__dirname, '../blog-site/src/layouts/Base.astro'), 'utf-8');
    assert.match(
      layout,
      /rel="alternate"[^>]*type="application\/rss\+xml"[^>]*href="https:\/\/www\.worldmonitor\.app\/blog\/rss\.xml"/
    );
    assert.doesNotMatch(
      layout,
      /rel="alternate"[^>]*href="\/blog\/rss\.xml"/,
      'relative /blog/rss.xml on a variant-host 200 teaches Google a new feed URL'
    );
    const rss = readFileSync(resolve(__dirname, '../blog-site/src/pages/rss.xml.ts'), 'utf-8');
    assert.match(rss, /atom:link href="https:\/\/www\.worldmonitor\.app\/blog\/rss\.xml" rel="self"/);
  });

  it('variant robots.txt keeps /dashboard crawlable and does not Disallow 308 families (#6835)', () => {
    const body = readFileSync(resolve(__dirname, '../public/robots.variant.txt'), 'utf-8');
    for (const path of [...SHARED_WWW_PREFIXES.map((p) => `/${p}`), '/docs', '/zh']) {
      assert.doesNotMatch(
        body,
        new RegExp(`^Disallow: ${path.replace('/', '\\/')}$`, 'm'),
        `Disallow ${path} would hide the 308 from a compliant crawler`
      );
    }
    for (const path of ['/pro', '/api/', '/tests/']) {
      assert.match(body, new RegExp(`^Disallow: ${path.replace('/', '\\/')}$`, 'm'), `variant robots must Disallow ${path}`);
    }
    // End-anchored since #7660. Unanchored, `/dashboard` is 10 characters and
    // out-ranks the 8-9 character `/*?*lat=`, `/*?*lon=`, `/*?*zoom=`,
    // `/*?*ref=` and `/*?*utm_` rules, so any map URL omitting `layers` slipped
    // straight through on the one path that generates the space. `$` keeps the
    // bare document explicitly crawlable without covering its query forms.
    assert.match(body, /^Allow: \/dashboard\$$/m);
    assert.doesNotMatch(body, /^Allow: \/dashboard$/m);
    assert.doesNotMatch(body, /^Disallow: \/dashboard\$?$/m);
    assert.match(body, /^Sitemap: https:\/\/www\.worldmonitor\.app\/sitemap\.xml$/m);
  });

  it('api robots.txt does not invite a marketing crawl of / (#6835)', () => {
    const body = readFileSync(resolve(__dirname, '../public/robots.api.txt'), 'utf-8');
    assert.match(body, /^Disallow: \/$/m);
    assert.match(body, /^Allow: \/api\/llms\.txt$/m);
    assert.match(body, /^Allow: \/api\/product-catalog$/m);
    assert.match(body, /^Allow: \/\.well-known\/$/m);
    assert.match(body, /^Allow: \/mcp$/m);
    assert.match(body, /^Allow: \/a2a$/m);
    assert.match(body, /^Allow: \/llms\.txt$/m);
    assert.match(body, /^Disallow: \/pro$/m);
  });

  it('variant and api robots keep AI-group rule parity with their own * group (#6835)', () => {
    for (const file of ['robots.variant.txt', 'robots.api.txt']) {
      const groups = parseRobotsGroups(readFileSync(resolve(__dirname, `../public/${file}`), 'utf-8'));
      const star = groups.find((g) => g.agents.includes('*'));
      const ai = groups.find((g) => g.agents.includes('gptbot'));
      const training = groups.find((g) => g.agents.includes('ccbot'));
      assert.ok(star, `${file} must have a * group`);
      assert.ok(ai, `${file} must restate the AI search/assistant group`);
      assert.deepStrictEqual(
        [...ai.rules].sort(),
        [...star.rules].sort(),
        `${file} AI group must restate the * rules`
      );
      assert.deepStrictEqual(training?.rules, ['disallow: /']);
    }
  });
});

describe('cold-load metric evidence reaches the CI artifact (#7837)', () => {
  const mapBudgetE2eSource = readFileSync(
    resolve(__dirname, '../e2e/map-overlay-marker-budget.spec.ts'),
    'utf-8',
  );

  // The failure this pins is SILENT. `testInfo.attach({ body })` keeps the
  // bytes in memory for a reporter to persist, and the `list` reporter this
  // project runs persists nothing — so the spec passed while its cold-load
  // metrics never reached the uploaded artifact (shard-1 of run 34144452921
  // contained zero files for this spec). Nothing goes red when that regresses;
  // the evidence simply stops existing, which is how #7837's own acceptance
  // criteria became unanswerable.
  it('attaches the cold-load metrics by path, never by body', () => {
    assert.match(mapBudgetE2eSource, /testInfo\.outputPath\('cold-dashboard-metrics\.json'\)/);
    assert.match(mapBudgetE2eSource, /await writeFile\(path, payload, 'utf8'\)/);
    assert.match(
      mapBudgetE2eSource,
      /testInfo\.attach\('cold-dashboard-metrics\.json', \{ path, contentType: 'application\/json' \}\)/,
    );
    assert.doesNotMatch(
      mapBudgetE2eSource,
      /attach\('cold-dashboard-metrics\.json', \{[\s\S]{0,80}?body:/,
      'a body attachment is dropped by the list reporter and never reaches test-results/',
    );
    // A path attachment only survives a PASSING test because output is kept.
    assert.match(playwrightConfigSource, /preserveOutput:\s*'always'/);
    // ...and test-results/ is what the smoke job uploads.
    assert.match(testWorkflowSource, /path: test-results\//);
  });

  // #7867 gives the first-paint sample its own CI-derived budget. The settled
  // diagnostic remains optional because hydration readiness is incomplete on CI.
  it('asserts the first-paint budgets against the first-paint sample only', () => {
    assert.match(
      mapBudgetE2eSource,
      /assertDashboardMetricBudgets\(samples\.map\(\(sample\) => sample\.firstPaint\.postGc\), FIRST_PAINT_METRIC_BUDGETS\)/,
    );
    assert.doesNotMatch(
      mapBudgetE2eSource,
      /assertDashboardMetricBudgets\(samples\.map\(\(sample\) => sample\.quiescence/,
      'the settled sample is recorded, never asserted (#7837)',
    );
  });
});

// #4953 / #4958: the static agent documents in public/ keep their content
// contracts (H1 naming the resource type; agent.txt when-to-use guidance).
describe('agent readiness: static agent documents', () => {
  it('public/agent.txt carries when-to-use guidance and points at the MCP server', () => {
    const agentTxt = readFileSync(resolve(__dirname, '../public/agent.txt'), 'utf-8');
    assert.match(agentTxt, /When to use/i, 'agent.txt must carry when-to-use guidance');
    assert.ok(agentTxt.includes('https://worldmonitor.app/mcp'), 'agent.txt must point at the MCP server');
  });

  const DEV_PAGES = [
    { file: 'developers.md', h1: '# World Monitor Developer Portal' },
    { file: 'mcp-server.md', h1: '# World Monitor MCP Server' },
    { file: 'openapi.md', h1: '# World Monitor OpenAPI Specification' },
    { file: 'sdks.md', h1: '# World Monitor SDKs' },
  ];

  for (const page of DEV_PAGES) {
    it(`public/${page.file} opens with the brand-named H1 "${page.h1}"`, () => {
      const body = readFileSync(resolve(__dirname, `../public/${page.file}`), 'utf-8');
      const content = body.replace(/^---\n[\s\S]*?\n---\n+/, '');
      assert.ok(content.startsWith(`${page.h1}\n`), `public/${page.file} must open with "${page.h1}" after metadata`);
    });
  }
});
