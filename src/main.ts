import './styles/base-layer.css';
import './bootstrap/zod-csp';
import './bootstrap/abort-signal-fallbacks';
import './bootstrap/dom-fallbacks';
import { SITE_VARIANT } from '@/config/variant';
import { installLcpAttributionDebug } from '@/bootstrap/lcp-attribution';
import { markLcpDebug } from '@/utils/lcp-debug';
import { registerWebMcpTools, type WebMcpAppBindings } from '@/services/webmcp';
import { safeStorageRemove } from '@/utils/safe-storage';
import { renderBootFailureScreen } from '@/bootstrap/boot-failure';
import { stripSensitiveParamsFromUrl } from '@/bootstrap/secondary-startup';
import { loadVariantThemeStylesheet } from '@/bootstrap/variant-theme';

if (SITE_VARIANT === 'happy') {
  // Keeps happy-theme.css off other variants' eager CSS graph. On happy, the
  // stylesheet applies asynchronously, so a brief base-theme flash is possible.
  // The import is fire-and-forget, so its rejection must be consumed: Vite's
  // preload helper rejects with `Unable to preload CSS for <url>` when the
  // injected <link> errors, and a bare `void import(...)` let that escape to
  // onunhandledrejection (WORLDMONITOR-XT). See bootstrap/variant-theme.ts.
  void loadVariantThemeStylesheet('happy', () => import('./styles/happy-theme.css'));
}

// Activate the deferred dashboard app stylesheet. The build
// (deferDashboardStylesheetLinks in vite.config.ts) emits the large dashboard
// CSS as <link media="print" data-wm-deferred-style="dashboard"> + a <noscript>
// blocking copy, so it does not block first paint; flipping media to "all" here
// applies it once main.js runs. The selector below MUST stay in lockstep with
// the attribute/value the build writes (data-wm-deferred-style="dashboard" +
// media="print"). No-JS users get the <noscript> fallback; if main.js fails to
// execute (e.g. an /assets 404 after a redeploy) the wm-sw-nuke handler in
// index.html reloads. Kept as the first body statement so it runs before the
// rest of startup.
function activateDeferredDashboardStyles(): void {
  document
    .querySelectorAll<HTMLLinkElement>('link[data-wm-deferred-style="dashboard"][media="print"]')
    .forEach((link) => {
      link.media = 'all';
    });
}

activateDeferredDashboardStyles();
installLcpAttributionDebug();

// Suppress NotAllowedError from YouTube IFrame API's internal play() — browser autoplay policy,
// not actionable. The YT IFrame API doesn't expose the play() promise so it leaks as unhandled.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.name === 'NotAllowedError') e.preventDefault();
});

import { debugGetCells, getCellCount } from '@/services/geo-convergence';
import { initMetaTags } from '@/services/meta-tags';
import { installRuntimeFetchPatch, installWebApiRedirect } from '@/services/runtime';
import { primeBootstrapFastTier } from '@/services/bootstrap-prefetch';
import { isDesktopRuntime } from '@/services/desktop-runtime';
import { loadDesktopSecrets } from '@/services/runtime-config';
import { applyStoredTheme } from '@/utils/theme-manager';
import { applyDeviceTierClass } from '@/utils/device-tier';
import { applyFont } from '@/services/font-settings';
import { applyFontScale, FONT_SCALE_STORAGE_KEY } from '@/services/font-scale-settings';
import { installChunkReloadGuard } from '@/bootstrap/chunk-reload';
import { installStaleBundleCheck } from '@/bootstrap/stale-bundle-check';
import { installBetaConsoleToggle } from '@/bootstrap/beta-console-toggle';

// Auto-reload once per build on stale chunk 404s after deployment (Vite fires
// `vite:preloadError` for failed dynamic imports and modulepreloads).
installChunkReloadGuard(__BUILD_HASH__);

// Drop secret-bearing params (email, license_key) nobody reads from the live URL.
stripSensitiveParamsFromUrl();

// Initialize dynamic meta tags for sharing
initMetaTags();

// In desktop mode, route /api/* calls to the local Tauri sidecar backend.
installRuntimeFetchPatch();
// In web production, route RPC calls through api.worldmonitor.app (Cloudflare edge).
installWebApiRedirect();
// Force-reload tabs running a stale bundle (catches the class of bug where
// users keep a tab open across a wire-shape change). Skips when build-hash
// is the 'dev' marker.
installStaleBundleCheck();
loadDesktopSecrets().catch(() => {});

// Apply stored theme preference before app initialization (safety net for inline script)
applyStoredTheme();
applyDeviceTierClass(document.documentElement);
applyFont();
applyFontScale();
window.addEventListener('storage', (event) => {
  if (event.key === FONT_SCALE_STORAGE_KEY) applyFontScale();
});

// Set data-variant on <html> so CSS theme overrides activate
if (SITE_VARIANT && SITE_VARIANT !== 'full') {
  document.documentElement.dataset.variant = SITE_VARIANT;

  // Swap favicons to variant-specific versions before browser finishes fetching defaults
  document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(link => {
    link.href = link.href
      .replace(/\/favico\/android-chrome-96x96\.png$/, `/favico/${SITE_VARIANT}/android-chrome-192x192.png`)
      .replace(/\/favico\/favicon/g, `/favico/${SITE_VARIANT}/favicon`)
      .replace(/\/favico\/apple-touch-icon/g, `/favico/${SITE_VARIANT}/apple-touch-icon`);
  });
}

// Remove no-transition class after first paint to enable smooth theme transitions
requestAnimationFrame(() => {
  document.documentElement.classList.remove('no-transition');
});

// Clear stale settings-open flag (survives ungraceful shutdown)
safeStorageRemove('wm-settings-open');

// Standalone windows: ?settings=1 = panel display settings, ?live-channels=1 = channel management
// Both need i18n initialized so t() does not return undefined.
const urlParams = new URLSearchParams(location.search);
if (urlParams.get('settings') === '1') {
  void Promise.all([import('./services/i18n'), import('./settings-window')]).then(
    async ([i18n, m]) => {
      await i18n.initI18n();
      m.initSettingsWindow();
    }
  );
} else if (urlParams.get('live-channels') === '1') {
  void Promise.all([import('./services/i18n'), import('./live-channels-window')]).then(
    async ([i18n, m]) => {
      await i18n.initI18n();
      m.initLiveChannelsWindow();
    }
  );
} else {
  // Start the first dashboard data now instead of after the App chunk loads.
  primeBootstrapFastTier();
  let resolveBindings!: (bindings: WebMcpAppBindings) => void;
  let rejectBindings!: (error: unknown) => void;
  const bindings = new Promise<WebMcpAppBindings>((resolve, reject) => {
    resolveBindings = resolve;
    rejectBindings = reject;
  });
  const webMcpController = registerWebMcpTools(bindings);
  // Import and constructor failures must reach the global startup error monitors.
  void import('./App').then(({ App }) => {
    markLcpDebug('wm:boot:app-construct');
    const app = new App('app');
    resolveBindings(app.getWebMcpBindings());
    app
      .init(webMcpController)
      .catch((error: unknown) => {
        console.error(error);
        try {
          // init() owns the WebMCP controller before its first await. A failed
          // boot must run normal teardown so the browser cannot retain tools
          // bound to an App that will never become ready.
          app.destroy();
        } catch (cleanupError) {
          // Cleanup is best-effort on a partially initialised App; never replace
          // the original boot failure with an unhandled teardown rejection.
          console.error('[App] Failed to clean up after initialization failure:', cleanupError);
        }
        // After teardown, so the dead skeleton / half-rendered dashboard cannot
        // paint over it. A render failure must not mask the boot error above.
        try {
          renderBootFailureScreen(error);
        } catch (renderError) {
          console.error('[App] Failed to render the boot-failure screen:', renderError);
        }
      });
  }).catch((error: unknown) => {
    rejectBindings(error);
    webMcpController?.abort();
    throw error;
  });
}

// Debug helpers for geo-convergence testing (remove in production)
(window as unknown as Record<string, unknown>).geoDebug = {
  cells: debugGetCells,
  count: getCellCount,
};

installBetaConsoleToggle(window);

// Suppress native WKWebView context menu in Tauri — allows custom JS context menus.
// isDesktopRuntime(), not the raw bridge globals: a Tauri window can paint before
// __TAURI_INTERNALS__ is attached, and the flag-forced desktop build has no
// globals at all in a browser (#5912).
if (isDesktopRuntime()) {
  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement;
    // Allow native menu on text inputs/textareas for copy/paste
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    e.preventDefault();
  });
}
