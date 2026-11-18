// A personal-mode browser must not send requests to the upstream operator's
// hosts (*.worldmonitor.app). Each module is bundled the way the personal build
// sees it (VITE_PERSONAL_MODE=true), with its other imports stubbed, and driven
// down the path that used to leave the personal server.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const ROOT = process.cwd();
const UPSTREAM = /(^|\.)worldmonitor\.app$/i;

// Bundles `entry` with `import.meta.env` = env. Imports listed in `stubs`
// (specifier -> module source) are replaced; `@/config/personal-mode` stays real.
async function load(entry, env, stubs) {
  const result = await build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent',
    define: { 'import.meta.env': JSON.stringify(env) },
    plugins: [{
      name: 'stub-imports',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          if (args.path === '@/config/personal-mode') return { path: path.join(ROOT, 'src/config/personal-mode.ts') };
          if (Object.hasOwn(stubs, args.path)) return { path: args.path, namespace: 'stub' };
          if (args.kind === 'entry-point') return undefined;
          if (args.path.startsWith('.') || args.path.startsWith('@/')) {
            throw new Error(`unstubbed import ${args.path} from ${args.importer}`);
          }
          return { path: args.path, external: true };
        });
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({ contents: stubs[args.path], loader: 'js' }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

const PERSONAL = { VITE_PERSONAL_MODE: 'true' };

test('widget agent URLs stay same-origin in personal mode, even where the page looks like desktop', async () => {
  // https://localhost (an HTTPS proxy in front of the personal server) makes
  // isDesktopRuntime() true, which used to send the widget agent straight to
  // the upstream relay.
  const mod = await load('src/utils/proxy.ts', PERSONAL, {
    '../services/runtime': 'export const isDesktopRuntime = () => true; export const toApiUrl = (p) => p; export const toRuntimeUrl = (p) => p;',
    '../services/persistent-cache': 'export const getPersistentCache = async () => null; export const setPersistentCache = async () => {};',
    '../services/timeout-signal': 'export const createRequestTimeoutSignal = () => undefined;',
  });
  assert.equal(mod.widgetAgentUrl(), '/api/widget-agent');
  assert.equal(mod.widgetAgentHealthUrl(), '/api/widget-agent');
});

test('the RSS proxy ignores the upstream direct-relay flag in personal mode', async () => {
  const mod = await load('src/utils/proxy.ts', { ...PERSONAL, VITE_RSS_DIRECT_TO_RELAY: 'true' }, {
    '../services/runtime': 'export const isDesktopRuntime = () => false; export const toApiUrl = (p) => p; export const toRuntimeUrl = (p) => p;',
    '../services/persistent-cache': 'export const getPersistentCache = async () => null; export const setPersistentCache = async () => {};',
    '../services/timeout-signal': 'export const createRequestTimeoutSignal = () => undefined;',
  });
  assert.equal(mod.rssProxyUrl('https://feeds.example.test/rss.xml'), '/api/rss-proxy?url=https%3A%2F%2Ffeeds.example.test%2Frss.xml');
});

test('the desktop updater never checks the upstream version endpoint in personal mode', async (t) => {
  const mod = await load('src/app/desktop-updater.ts', PERSONAL, {
    '@/services/tauri-bridge': 'export const invokeTauri = async () => ({});',
    '@/services/external-navigation': 'export const openExternalUrl = () => {};',
    '@/services/analytics': 'export const trackUpdateShown = () => {}; export const trackUpdateClicked = () => {}; export const trackUpdateDismissed = () => {};',
    '@/utils/sanitize': 'export const escapeHtml = (s) => s;',
    '@/utils/cross-domain-storage': 'export const getDismissed = () => false; export const setDismissed = () => {};',
    '@/utils/dom-utils': 'export const setTrustedHtml = () => {}; export const trustedHtml = (s) => s;',
    '@/utils/desktop-version': 'export const decideUpdateOutcome = () => "no_update";',
  });
  const scheduled = [];
  t.mock.method(globalThis, 'setTimeout', (_fn, ms) => { scheduled.push(ms); return 0; });
  t.mock.method(globalThis, 'setInterval', (_fn, ms) => { scheduled.push(ms); return 0; });
  const fetches = [];
  t.mock.method(globalThis, 'fetch', async (url) => { fetches.push(String(url)); return new Response('{}'); });
  const updater = new mod.DesktopUpdater({ isDesktopApp: true, isDestroyed: false });
  updater.init();
  assert.deepEqual({ scheduled, fetches }, { scheduled: [], fetches: [] });
});

test('country boundary overrides load from the personal server, not the upstream CDN', async (t) => {
  const mod = await load('src/services/country-geometry.ts', PERSONAL, {
    '@/utils/lcp-debug': 'export const markLcpDebug = () => {};',
    '@/config/static-asset-url': 'export const staticAssetUrl = (p) => p;',
  });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 });
  });
  await mod.preloadCountryGeometry();
  assert.deepEqual(requested, ['/data/countries.geojson', '/data/country-boundary-overrides.geojson']);
  for (const url of requested) {
    assert.ok(!UPSTREAM.test(new URL(url, 'http://127.0.0.1:3000').hostname), `${url} must not reach an upstream host`);
  }
});
