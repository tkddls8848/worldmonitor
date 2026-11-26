/**
 * AI Widget Builder — E2E / Static verification tests
 *
 * Covers:
 *   1. Relay security  — SSRF guard, auth gate, isPublicRoute, body limit, CORS
 *   2. Widget store    — constants, span-map keys, `cw-` prefix, history trim
 *   3. Title regex     — hyphens in titles (bug fixed: [^\n\-] → [^\n])
 *   5. Panel guardrails — cw- exclusion in UnifiedSettings, event-handlers
 *   6. SSE event types — html_complete, done, error, tool_call all present
 */

import { describe, it } from 'node:test';

import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { dirname, resolve } from 'node:path';

import { fileURLToPath } from 'node:url';

import vm from 'node:vm';

import crypto from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';


const __dirname = dirname(fileURLToPath(import.meta.url));

const root = resolve(__dirname, '..');


function src(relPath) {
  return readFileSync(resolve(root, relPath), 'utf-8');
}


// ---------------------------------------------------------------------------
// 2. Widget store
// ---------------------------------------------------------------------------
describe('widget-store — constants and logic', () => {
  const store = src('src/services/widget-store.ts');

  it('storage key is wm-custom-widgets', () => {
    assert.ok(
      store.includes("'wm-custom-widgets'"),
      "Storage key must be 'wm-custom-widgets'",
    );
  });

  it('MAX_WIDGETS is 10', () => {
    assert.ok(
      store.includes('MAX_WIDGETS') && store.includes('10'),
      'MAX_WIDGETS constant should be 10',
    );
    const match = store.match(/MAX_WIDGETS\s*=\s*(\d+)/);
    assert.ok(match, 'MAX_WIDGETS not found');
    assert.equal(Number(match[1]), 10, 'MAX_WIDGETS must be 10');
  });

  it('MAX_HTML_CHARS is 50000', () => {
    const match = store.match(/MAX_HTML_(?:CHARS|BYTES)\s*=\s*([\d_]+)/);
    assert.ok(match, 'MAX_HTML_CHARS/BYTES constant not found');
    const val = Number(match[1].replace(/_/g, ''));
    assert.equal(val, 50000, 'HTML size limit must be 50,000 chars');
  });

  it('MAX_HISTORY is 10', () => {
    const match = store.match(/MAX_HISTORY\s*=\s*(\d+)/);
    assert.ok(match, 'MAX_HISTORY constant not found');
    assert.equal(Number(match[1]), 10, 'MAX_HISTORY must be 10');
  });

  it('deleteWidget cleans worldmonitor-panel-spans (aggregate map)', () => {
    assert.ok(
      store.includes('clearPanelSpanEntry(id)'),
      'deleteWidget must clean row-span entries through the shared panel storage helper',
    );
  });

  it('deleteWidget cleans worldmonitor-panel-col-spans (aggregate map)', () => {
    assert.ok(
      store.includes('clearPanelColSpanEntry(id)'),
      'deleteWidget must clean column-span entries through the shared panel storage helper',
    );
  });

  it('saveWidget trims conversationHistory before write', () => {
    // Should call slice(-MAX_HISTORY) before persisting
    const saveIdx = store.indexOf('function saveWidget');
    assert.ok(saveIdx !== -1, 'saveWidget not found');
    const saveBody = store.slice(saveIdx, saveIdx + 800);
    assert.ok(
      saveBody.includes('.slice(-') || saveBody.includes('slice(-MAX_HISTORY'),
      'saveWidget must trim conversationHistory with .slice(-MAX_HISTORY)',
    );
  });

  it('saveWidget truncates html to MAX_HTML_CHARS before write', () => {
    const saveIdx = store.indexOf('function saveWidget');
    assert.ok(saveIdx !== -1);
    const saveBody = store.slice(saveIdx, saveIdx + 800);
    assert.ok(
      saveBody.includes('.slice(0, MAX_HTML'),
      'saveWidget must truncate html to MAX_HTML_CHARS',
    );
  });
});


// ---------------------------------------------------------------------------
// 4. HTML sanitizer
// ---------------------------------------------------------------------------
describe('widget-sanitizer — allowlist verification', () => {
  const san = src('src/utils/widget-sanitizer.ts');

  const REQUIRED_ALLOWED_TAGS = ['div', 'span', 'p', 'table', 'svg', 'path'];
  const REQUIRED_FORBIDDEN_TAGS = ['button', 'input', 'script', 'iframe', 'form'];
  const REQUIRED_ALLOWED_ATTRS = ['class', 'style', 'viewBox', 'fill', 'stroke'];

  for (const tag of REQUIRED_ALLOWED_TAGS) {
    it(`allowed tag '${tag}' is in ALLOWED_TAGS`, () => {
      assert.ok(
        san.includes(`'${tag}'`) || san.includes(`"${tag}"`),
        `Tag '${tag}' must be in ALLOWED_TAGS`,
      );
    });
  }

  for (const tag of REQUIRED_FORBIDDEN_TAGS) {
    it(`forbidden tag '${tag}' is in FORBID_TAGS`, () => {
      assert.ok(
        san.includes(`'${tag}'`) || san.includes(`"${tag}"`),
        `Tag '${tag}' must be in FORBID_TAGS`,
      );
    });
  }

  for (const attr of REQUIRED_ALLOWED_ATTRS) {
    it(`attribute '${attr}' is in ALLOWED_ATTR`, () => {
      assert.ok(
        san.includes(`'${attr}'`) || san.includes(`"${attr}"`),
        `Attr '${attr}' must be in ALLOWED_ATTR`,
      );
    });
  }

  it('FORCE_BODY is true (prevents <html> wrapper)', () => {
    assert.ok(san.includes('FORCE_BODY: true'), 'FORCE_BODY must be true');
  });

  it('style attributes are rebuilt by the declaration allowlist', () => {
    assert.match(san, /sanitizeWidgetStyle\(/);
  });
});


// ---------------------------------------------------------------------------
// 5. Panel guardrails — cw- exclusions
// ---------------------------------------------------------------------------
describe('panel guardrails — cw- prefix handling', () => {
  const settings = src('src/components/UnifiedSettings.ts');
  const events = src('src/app/event-handlers.ts');
  const layout = src('src/app/panel-layout.ts');

  it('UnifiedSettings filters out cw- panels from settings list', () => {
    assert.ok(
      settings.includes("startsWith('cw-')"),
      "UnifiedSettings must filter panels with id.startsWith('cw-')",
    );
  });

  it('event-handlers confirms before deleting cw- panels', () => {
    assert.ok(
      events.includes("startsWith('cw-')"),
      "event-handlers must detect cw- prefix for custom widget panels",
    );
    assert.ok(
      events.includes("t('widgets.confirmDelete')"),
      'Custom widget delete confirmation must use localized widgets.confirmDelete copy',
    );
    assert.ok(
      events.includes('confirm') || events.includes('window.confirm'),
      'Must show a confirm dialog before deleting custom widgets',
    );
  });

  it('event-handlers calls deleteWidget for cw- panels', () => {
    assert.ok(
      events.includes('deleteWidget'),
      'Must call deleteWidget() when removing a custom widget panel',
    );
  });

  it('panel-layout loads widgets when feature is enabled', () => {
    assert.ok(
      layout.includes('loadWidgets'),
      'panel-layout must call loadWidgets() to restore persisted widgets',
    );
  });

  it('panel-layout DEV warning excludes cw- panels', () => {
    assert.ok(
      layout.includes("startsWith('cw-')"),
      "DEV warning must exclude panels with id.startsWith('cw-')",
    );
  });
});


// ---------------------------------------------------------------------------
// 7. WidgetChatModal — client-side SSE handling
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 8. Vite proxy + URL helper
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 9. i18n completeness
// ---------------------------------------------------------------------------
describe('i18n — widgets section completeness', () => {
  const en = JSON.parse(src('src/locales/en.json'));

  const REQUIRED_KEYS = [
    'confirmDelete',
    'chatTitle',
    'modifyTitle',
    'inputPlaceholder',
    'addToDashboard',
    'applyChanges',
    'send',
    'modifyWithAi',
    'ready',
    'fetching',
    'requestTimedOut',
    'serverError',
    'unknownError',
    'generatedWidget',
    'checkingConnection',
    'preflightConnected',
    'preflightInvalidKey',
    'preflightUnavailable',
    'preflightAiUnavailable',
    'saveFailed',
    'readyToGenerate',
    'readyToApply',
    'modifyHint',
    'generating',
    'examplesTitle',
    'previewTitle',
    'phaseChecking',
    'phaseReadyToPrompt',
    'phaseFetching',
    'phaseComposing',
    'phaseComplete',
    'phaseError',
    'previewCheckingHeading',
    'previewReadyHeading',
    'previewFetchingHeading',
    'previewComposingHeading',
    'previewErrorHeading',
    'previewCheckingCopy',
    'previewReadyCopy',
    'previewFetchingCopy',
    'previewComposingCopy',
    'previewErrorCopy',
  ];

  for (const key of REQUIRED_KEYS) {
    it(`widgets.${key} is defined and non-empty`, () => {
      assert.ok(
        en.widgets && typeof en.widgets[key] === 'string' && en.widgets[key].length > 0,
        `en.json must have non-empty widgets.${key}`,
      );
    });
  }

  it('confirmDelete text sounds permanent (not just hide)', () => {
    assert.ok(
      en.widgets.confirmDelete.toLowerCase().includes('remove') ||
      en.widgets.confirmDelete.toLowerCase().includes('delete') ||
      en.widgets.confirmDelete.toLowerCase().includes('permanent'),
      'confirmDelete must convey permanence — not just hide',
    );
  });

  it('widget UI sources labels from i18n keys instead of hardcoded English copy', () => {
    const events = src('src/app/event-handlers.ts');
    assert.ok(events.includes("t('widgets.confirmDelete')"), 'Delete confirmation must use widgets.confirmDelete');
  });

  it('prompt examples are defined and non-empty', () => {
    const exampleKeys = ['oilGold', 'cryptoMovers', 'flightDelays', 'conflictHotspots'];
    for (const key of exampleKeys) {
      assert.ok(
        typeof en.widgets.examples[key] === 'string' && en.widgets.examples[key].length > 0,
        `en.json must have non-empty widgets.examples.${key}`,
      );
    }
  });
});


// ---------------------------------------------------------------------------
// 10. CustomWidgetPanel
// ---------------------------------------------------------------------------
describe('CustomWidgetPanel — header buttons and events', () => {
  const panel = src('src/components/CustomWidgetPanel.ts');
  const sanitizer = src('src/utils/widget-sanitizer.ts');

  it('applies --widget-accent CSS variable', () => {
    assert.ok(
      panel.includes('--widget-accent'),
      'CustomWidgetPanel must apply --widget-accent CSS variable',
    );
  });

  it('renderWidget uses shared wrapped widget HTML helper', () => {
    assert.ok(
      panel.includes('wrapWidgetHtml'),
      'renderWidget must use wrapWidgetHtml() for shell + sanitization',
    );
    assert.ok(
      sanitizer.includes('sanitizeWidgetHtml'),
      'wrapWidgetHtml() must sanitize HTML internally',
    );
    assert.ok(
      sanitizer.includes('wm-widget-generated'),
      'wrapWidgetHtml() must provide a contained generated-widget wrapper',
    );
  });

  it('extends Panel (display-only widget with panel infrastructure)', () => {
    assert.ok(
      panel.includes('extends Panel'),
      'CustomWidgetPanel must extend Panel',
    );
  });

  it('renderWidget branches on tier — PRO uses wrapProWidgetHtml', () => {
    assert.ok(
      panel.includes('wrapProWidgetHtml'),
      "renderWidget must call wrapProWidgetHtml() for PRO tier",
    );
  });

});


// ---------------------------------------------------------------------------
// 12. PRO widget — store and sanitizer
// ---------------------------------------------------------------------------
describe('PRO widget — store and sanitizer', () => {
  const store = src('src/services/widget-store.ts');
  const san = src('src/utils/widget-sanitizer.ts');
  const sandbox = src('public/wm-widget-sandbox.html');

  it('MAX_HTML_CHARS_PRO is 80000', () => {
    const match = store.match(/MAX_HTML_CHARS_PRO\s*=\s*([\d_]+)/);
    assert.ok(match, 'MAX_HTML_CHARS_PRO constant not found');
    const val = Number(match[1].replace(/_/g, ''));
    assert.equal(val, 80000, 'MAX_HTML_CHARS_PRO must be 80,000');
  });

  it('legacy wm-pro-html-{id} key remains supported for old PRO widgets', () => {
    assert.ok(
      store.includes('wm-pro-html-'),
      "PRO HTML must still know the legacy 'wm-pro-html-{id}' localStorage key",
    );
  });

  it('loadWidgets can hydrate legacy PRO HTML from the side key', () => {
    const loadIdx = store.indexOf('function materializeWidgets');
    assert.ok(loadIdx !== -1, 'shared widget materializer not found');
    const loadBody = store.slice(loadIdx, loadIdx + 2_000);
    assert.ok(
      // Accessor-agnostic: #7833 moved this read onto safeStorageGet, and what
      // the assertion is actually about is that the side key is consulted at
      // all — pinning the spelling just re-breaks on the next migration.
      /(?:localStorage\.getItem|safeStorageGet)\(proHtmlKey\(w\.id\)\)/.test(loadBody),
      'loadWidgets must read legacy PRO HTML from the side key',
    );
  });

  it('loadWidgets treats canonical PRO HTML as primary before legacy side key', () => {
    const loadIdx = store.indexOf('function materializeWidgets');
    const loadBody = store.slice(loadIdx, loadIdx + 2_000);
    assert.ok(
      loadBody.includes('storedHtml || sideKeyHtml'),
      'loadWidgets must prefer canonical widget HTML before the legacy side key',
    );
  });

  it('loadWidgets drops PRO entry only when no persisted HTML remains', () => {
    const loadIdx = store.indexOf('function materializeWidgets');
    const loadBody = store.slice(loadIdx, loadIdx + 2_000);
    assert.ok(
      loadBody.includes('if (!proHtml)') && loadBody.includes('continue'),
      'loadWidgets must skip/drop PRO entries only when no HTML exists in either storage path',
    );
  });

  it('saveWidget for PRO uses raw localStorage.setItem (not saveToStorage helper)', () => {
    const saveIdx = store.indexOf('function saveWidget');
    assert.ok(saveIdx !== -1, 'saveWidget not found');
    const saveBody = store.slice(saveIdx, saveIdx + 800);
    assert.ok(
      saveBody.includes('localStorage.setItem'),
      'PRO saveWidget must use raw localStorage.setItem for atomicity-safe writes',
    );
  });

  it('saveWidget for PRO does not duplicate HTML into the legacy side key', () => {
    const saveIdx = store.indexOf('function saveWidget');
    const saveBody = store.slice(saveIdx, saveIdx + 800);
    assert.ok(
      !saveBody.includes('localStorage.setItem(proHtmlKey'),
      'saveWidget must not write duplicate PRO HTML to the legacy side key',
    );
    assert.ok(
      saveBody.includes('localStorage.removeItem(proHtmlKey'),
      'saveWidget should clean up legacy PRO HTML side keys after a canonical save',
    );
  });

  it('deleteWidget removes wm-pro-html-{id} key', () => {
    const deleteIdx = store.indexOf('function deleteWidget');
    assert.ok(deleteIdx !== -1, 'deleteWidget not found');
    const deleteBody = store.slice(deleteIdx, deleteIdx + 400);
    assert.ok(
      deleteBody.includes('wm-pro-html') || deleteBody.includes('proHtmlKey'),
      'deleteWidget must also remove the wm-pro-html-{id} key',
    );
  });

  it('wrapProWidgetHtml returns iframe with sandbox="allow-scripts" only', () => {
    assert.ok(san.includes('wrapProWidgetHtml'), 'wrapProWidgetHtml must be exported');
    // Use 1500 chars to cover the full function body including the long CSP meta tag
    const fnIdx = san.indexOf('wrapProWidgetHtml');
    const fnBody = san.slice(fnIdx, fnIdx + 1500);
    assert.ok(
      fnBody.includes('sandbox="allow-scripts"') || fnBody.includes("sandbox='allow-scripts'"),
      'iframe sandbox must be exactly "allow-scripts" — no allow-same-origin',
    );
    assert.ok(
      !fnBody.includes('allow-same-origin'),
      'sandbox must NOT include allow-same-origin',
    );
  });

  it('widget document builder places CSP as first head child (client-owned skeleton)', () => {
    assert.ok(
      san.includes('Content-Security-Policy'),
      'widget sanitizer must embed CSP in the document head',
    );
    // CSP meta should come before any style tag
    const cspPos = san.indexOf('Content-Security-Policy');
    const stylePos = san.indexOf('<style>');
    assert.ok(
      cspPos < stylePos,
      'CSP meta must appear before <style> in the generated HTML skeleton',
    );
  });

  it('widget document builder CSP restricts connect-src to cdn.jsdelivr.net only', () => {
    assert.ok(
      san.includes('connect-src https://cdn.jsdelivr.net'),
      'CSP connect-src must allow only cdn.jsdelivr.net (for Chart.js source maps) and nothing else',
    );
    assert.ok(
      !san.includes("connect-src 'none'") && !san.includes('connect-src *'),
      'CSP connect-src must not be wildcard or none',
    );
  });

  it('wrapProWidgetHtml uses sandbox page src (not srcdoc) for CSP isolation', () => {
    const fnIdx = san.indexOf('wrapProWidgetHtml');
    const fnBody = san.slice(fnIdx, fnIdx + 500);
    assert.ok(
      fnBody.includes('wm-widget-sandbox.html'),
      'wrapProWidgetHtml must load the dedicated sandbox page (not srcdoc) to get its own CSP',
    );
    assert.ok(
      !fnBody.includes('srcdoc'),
      'wrapProWidgetHtml must NOT use srcdoc — srcdoc inherits parent CSP',
    );
  });

  it('PRO widget iframe uses nonce handshake before posting HTML', () => {
    assert.ok(
      san.includes('data-wm-token') && san.includes('wm-widget-ready'),
      'parent must mint a per-widget token and wait for sandbox readiness',
    );
    assert.ok(
      san.includes('event.source !== iframe.contentWindow'),
      'parent must bind ready messages to the mounted iframe window',
    );
    assert.ok(
      san.includes('event.data.id !== mounted.id')
        && san.includes('event.data.token !== mounted.token'),
      'parent must verify ready message id and token before sending HTML',
    );
    assert.ok(
      sandbox.includes('e.source !== window.parent') && sandbox.includes('e.data.token !== widgetToken'),
      'sandbox must only accept HTML from its parent with the expected token',
    );
  });

  it('PRO widget postMessage targetOrigins match the opaque sandbox model', () => {
    const parentDelivery = san.match(
      /iframe\.contentWindow\?\.postMessage\(\s*\{[\s\S]*?type:\s*['"]wm-html['"][\s\S]*?\},\s*(['"])\*\1,\s*\)/,
    );
    assert.ok(
      parentDelivery,
      'parent-to-sandbox HTML delivery must use "*" because sandbox="allow-scripts" gives the iframe an opaque origin',
    );
    assert.ok(
      san.includes('origin is opaque') && san.includes('per-widget id/token'),
      'wildcard targetOrigin must be documented as required after source and nonce gating',
    );

    const readyDelivery = sandbox.match(
      /window\.parent\.postMessage\(\s*\{[\s\S]*?type:\s*['"]wm-widget-ready['"][\s\S]*?\},\s*parentOrigin,\s*\)/,
    );
    assert.ok(
      readyDelivery,
      'sandbox-to-parent readiness must target the parsed parentOrigin, not a wildcard',
    );
    assert.ok(
      !/window\.parent\.postMessage\(\s*\{[\s\S]*?type:\s*['"]wm-widget-ready['"][\s\S]*?\},\s*(['"])\*\1/.test(sandbox),
      'sandbox readiness postMessage must not use wildcard targetOrigin',
    );
  });

  it('widget sandbox trusts worldmonitor.app hosts and never a vercel.app name pattern', () => {
    assert.ok(
      sandbox.includes("url.hostname === 'worldmonitor.app'")
        && sandbox.includes("url.hostname.endsWith('.worldmonitor.app')"),
      'sandbox must parse hostname and allow the worldmonitor.app apex/subdomains only',
    );
    assert.ok(
      !sandbox.includes("endsWith('worldmonitor.app')") && !sandbox.includes('endsWith("worldmonitor.app")'),
      'sandbox must not use raw suffix checks that allow evilworldmonitor.app',
    );
    // `<project>.vercel.app` goes to whichever Vercel account claims the name
    // first, so a team-slug suffix proves nothing. Previews are trusted only
    // as the deployment that served the sandbox (same origin).
    assert.ok(!/vercel\\?\.app/.test(sandbox), 'sandbox must not match vercel.app hosts by pattern');
    assert.ok(!sandbox.includes('ALLOWED_VERCEL_TEAM_SLUGS'), 'team-slug allowlist must stay retired');
  });

  it('widget sandbox behavior accepts its own Vercel preview and blocks foreign and spoofed parents', () => {
    const script = sandbox.match(/<script>\r?\n([\s\S]*?)\r?\n<\/script>/)?.[1];
    assert.ok(script, 'sandbox inline script not found');

    const ownPreview = 'https://worldmonitor-git-feature-eliewm.vercel.app';
    function runSandbox(referrer, sandboxOrigin = ownPreview) {
      const readyMessages = [];
      const writes = [];
      const listeners = new Map();
      const parent = {
        postMessage(payload, targetOrigin) {
          readyMessages.push({ payload, targetOrigin });
        },
      };
      function FakeEventTarget() {}
      FakeEventTarget.prototype.addEventListener = (type, listener) => {
        listeners.set(type, listener);
      };
      function FakeEvent() {}
      FakeEvent.prototype.stopImmediatePropagation = () => {};
      const sandboxWindow = new FakeEventTarget();
      sandboxWindow.location = { hash: '#id=wm-1&token=test-token', origin: sandboxOrigin };
      sandboxWindow.parent = parent;
      const context = {
        URL,
        URLSearchParams,
        Event: FakeEvent,
        EventTarget: FakeEventTarget,
        document: {
          referrer,
          open() {},
          write(html) {
            writes.push(html);
          },
          close() {},
        },
        window: sandboxWindow,
      };
      vm.runInNewContext(script, context);
      const message = listeners.get('message');
      assert.equal(typeof message, 'function', 'message listener must be registered');
      return { parent, readyMessages, writes, message };
    }

    const allowed = runSandbox('https://worldmonitor-git-feature-eliewm.vercel.app/dashboard');
    assert.equal(allowed.readyMessages.length, 1);
    assert.equal(allowed.readyMessages[0].targetOrigin, 'https://worldmonitor-git-feature-eliewm.vercel.app');
    assert.deepEqual(JSON.parse(JSON.stringify(allowed.readyMessages[0].payload)), {
      type: 'wm-widget-ready',
      id: 'wm-1',
      token: 'test-token',
    });
    allowed.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>ok</p>' },
      origin: 'https://worldmonitor-git-feature-eliewm.vercel.app',
      source: allowed.parent,
    });
    assert.deepEqual(allowed.writes, ['<p>ok</p>']);
    allowed.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>second</p>' },
      origin: 'https://worldmonitor-git-feature-eliewm.vercel.app',
      source: allowed.parent,
    });
    assert.deepEqual(allowed.writes, ['<p>ok</p>'], 'only the first accepted message may write');

    const invalidMessages = [
      {
        data: { type: 'other', id: 'wm-1', token: 'test-token', html: '<p>bad type</p>' },
        origin: 'https://worldmonitor.app',
      },
      {
        data: { type: 'wm-html', id: 'wrong-id', token: 'test-token', html: '<p>bad id</p>' },
        origin: 'https://worldmonitor.app',
      },
      {
        data: { type: 'wm-html', id: 'wm-1', token: 'wrong-token', html: '<p>bad token</p>' },
        origin: 'https://worldmonitor.app',
      },
    ];
    for (const invalidMessage of invalidMessages) {
      const rejected = runSandbox('https://worldmonitor.app/dashboard');
      rejected.message({ ...invalidMessage, source: rejected.parent });
      assert.deepEqual(rejected.writes, []);
    }

    const wrongSource = runSandbox('https://worldmonitor.app/dashboard');
    wrongSource.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>bad source</p>' },
      origin: 'https://worldmonitor.app',
      source: {},
    });
    assert.deepEqual(wrongSource.writes, []);

    // A third party's look-alike preview embedding a different deployment's
    // sandbox (or the production sandbox) must be rejected.
    for (const [referrer, sandboxOrigin] of [
      ['https://worldmonitor-attacker-eliewm.vercel.app/', ownPreview],
      ['https://worldmonitor-attacker-eliewm.vercel.app/', 'https://worldmonitor.app'],
    ]) {
      const foreign = runSandbox(referrer, sandboxOrigin);
      assert.deepEqual(foreign.readyMessages, [], `${referrer} -> ${sandboxOrigin}`);
      foreign.message({
        data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>bad</p>' },
        origin: 'https://worldmonitor-attacker-eliewm.vercel.app',
        source: foreign.parent,
      });
      assert.deepEqual(foreign.writes, [], `${referrer} -> ${sandboxOrigin}`);
    }

    const spoofed = runSandbox('https://worldmonitor-git-feature-eliewm.vercel.app.evil.com/');
    assert.deepEqual(spoofed.readyMessages, []);
    spoofed.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>bad</p>' },
      origin: 'https://worldmonitor-git-feature-eliewm.vercel.app.evil.com',
      source: spoofed.parent,
    });
    assert.deepEqual(spoofed.writes, []);
  });

  it('widget sandbox trusts a localhost referrer only when the sandbox itself is also running on localhost', () => {
    // This file (public/wm-widget-sandbox.html) ships byte-for-byte to
    // production -- there is no build-time dev/prod flag available inside
    // it. Anyone can run their own local HTTP server and set
    // document.referrer to http://localhost freely, so trusting that
    // referrer alone would let such a page embed the PRODUCTION sandbox
    // and receive real widget HTML. The fix requires window.location
    // (the sandbox's own, unspoofable origin) to also be localhost.
    const script = sandbox.match(/<script>\r?\n([\s\S]*?)\r?\n<\/script>/)?.[1];
    assert.ok(script, 'sandbox inline script not found');

    function runSandboxAt(selfHostname, referrer, selfOrigin = `${new URL(referrer).protocol}//${selfHostname}:5173`) {
      const readyMessages = [];
      const writes = [];
      const listeners = new Map();
      const parent = {
        postMessage(payload, targetOrigin) {
          readyMessages.push({ payload, targetOrigin });
        },
      };
      function FakeEventTarget() {}
      FakeEventTarget.prototype.addEventListener = (type, listener) => {
        listeners.set(type, listener);
      };
      function FakeEvent() {}
      FakeEvent.prototype.stopImmediatePropagation = () => {};
      const sandboxWindow = new FakeEventTarget();
      sandboxWindow.location = { hash: '#id=wm-1&token=test-token', hostname: selfHostname, origin: selfOrigin };
      sandboxWindow.parent = parent;
      const context = {
        URL,
        URLSearchParams,
        Event: FakeEvent,
        EventTarget: FakeEventTarget,
        document: {
          referrer,
          open() {},
          write(html) {
            writes.push(html);
          },
          close() {},
        },
        window: sandboxWindow,
      };
      vm.runInNewContext(script, context);
      const message = listeners.get('message');
      assert.equal(typeof message, 'function', 'message listener must be registered');
      return { parent, readyMessages, writes, message };
    }

    // Production sandbox (window.location.hostname === worldmonitor.app)
    // embedded by a page whose referrer claims http://localhost: must be
    // rejected outright, both for the initial readiness ping and for a
    // forged wm-html delivery attempt.
    const prodAgainstLocalhostReferrer = runSandboxAt('worldmonitor.app', 'http://localhost:5173/dashboard');
    assert.deepEqual(
      prodAgainstLocalhostReferrer.readyMessages,
      [],
      'production sandbox must not send the readiness ping to a localhost-claiming referrer',
    );
    prodAgainstLocalhostReferrer.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>should not render</p>' },
      origin: 'http://localhost:5173',
      source: prodAgainstLocalhostReferrer.parent,
    });
    assert.deepEqual(
      prodAgainstLocalhostReferrer.writes,
      [],
      'production sandbox must not accept HTML claiming to come from localhost',
    );

    // Same check for 127.0.0.1.
    const prodAgainst127Referrer = runSandboxAt('worldmonitor.app', 'http://127.0.0.1:5173/dashboard');
    assert.deepEqual(prodAgainst127Referrer.readyMessages, []);

    // Legitimate local dev: both the sandbox page itself and the embedding
    // page run on localhost (e.g. `npm run dev`). This must keep working.
    const devSandbox = runSandboxAt('localhost', 'http://localhost:5173/dashboard');
    const foreignPort = runSandboxAt('localhost', 'http://localhost:4000/attack', 'http://localhost:5173');
    assert.deepEqual(foreignPort.readyMessages, []);
    foreignPort.message({ source: foreignPort.parent, origin: 'http://localhost:4000',
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<script>attack()</script>' } });
    assert.deepEqual(foreignPort.writes, []);
    assert.equal(devSandbox.readyMessages.length, 1, 'dev sandbox on localhost must still trust a localhost parent');
    assert.equal(devSandbox.readyMessages[0].targetOrigin, 'http://localhost:5173');
    devSandbox.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>dev ok</p>' },
      origin: 'http://localhost:5173',
      source: devSandbox.parent,
    });
    assert.deepEqual(devSandbox.writes, ['<p>dev ok</p>']);

    // 127.0.0.1 sandbox self-origin (some dev setups bind there instead).
    const dev127Sandbox = runSandboxAt('127.0.0.1', 'http://127.0.0.1:5173/dashboard');
    assert.equal(dev127Sandbox.readyMessages.length, 1, '127.0.0.1 dev sandbox must trust a 127.0.0.1 parent');

    // HTTPS variants — same hostname gate, protocol-agnostic for localhost.
    const prodHttpsLocalhost = runSandboxAt('worldmonitor.app', 'https://localhost:5173/dashboard');
    assert.deepEqual(prodHttpsLocalhost.readyMessages, [], 'prod must block https localhost too');
    prodHttpsLocalhost.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>should not render</p>' },
      origin: 'https://localhost:5173',
      source: prodHttpsLocalhost.parent,
    });
    assert.deepEqual(prodHttpsLocalhost.writes, []);
    const prodHttps127 = runSandboxAt('worldmonitor.app', 'https://127.0.0.1:5173/dashboard');
    assert.deepEqual(prodHttps127.readyMessages, []);
    const devHttpsLocalhost = runSandboxAt('localhost', 'https://localhost:5173/dashboard');
    assert.equal(devHttpsLocalhost.readyMessages.length, 1, 'dev localhost must trust https localhost parent');
    assert.equal(devHttpsLocalhost.readyMessages[0].targetOrigin, 'https://localhost:5173');
    devHttpsLocalhost.message({
      data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: '<p>dev https ok</p>' },
      origin: 'https://localhost:5173',
      source: devHttpsLocalhost.parent,
    });
    assert.deepEqual(devHttpsLocalhost.writes, ['<p>dev https ok</p>']);
    const devHttps127 = runSandboxAt('127.0.0.1', 'https://127.0.0.1:5173/dashboard');
    assert.equal(devHttps127.readyMessages.length, 1, '127.0.0.1 dev must trust https 127.0.0.1 parent');
  });

  it('widget sandbox blocks beforeunload without breaking normal events before widget execution', () => {
    const script = sandbox.match(/<script>\r?\n([\s\S]*?)\r?\n<\/script>/)?.[1];
    assert.ok(script, 'sandbox inline script not found');

    function FakeEvent(type) {
      this.type = type;
      this.immediatePropagationStopped = false;
    }

    FakeEvent.prototype.stopImmediatePropagation = function () {
      this.immediatePropagationStopped = true;
    };

    function FakeEventTarget() {
      this.listeners = new Map();
    }

    FakeEventTarget.prototype.addEventListener = function (type, listener, options) {
      const entries = this.listeners.get(type) ?? [];
      entries.push({ listener, options });
      this.listeners.set(type, entries);
    };

    FakeEventTarget.prototype.dispatchEvent = function (event) {
      const entries = [...(this.listeners.get(event.type) ?? [])];
      for (const entry of entries) {
        if (typeof entry.listener === 'function') {
          entry.listener.call(this, event);
        } else {
          entry.listener.handleEvent.call(entry.listener, event);
        }
        if (event.immediatePropagationStopped) break;
        if (entry.options?.once) {
          const current = this.listeners.get(event.type) ?? [];
          this.listeners.set(event.type, current.filter((candidate) => candidate !== entry));
        }
      }
      return true;
    };

    const parent = { postMessage() {} };
    const sandboxWindow = new FakeEventTarget();
    sandboxWindow.location = { hash: '#id=wm-1&token=test-token' };
    sandboxWindow.parent = parent;

    let guardedAtWrite = false;
    let vmContext;
    const document = {
      referrer: 'https://worldmonitor.app/dashboard',
      open() {
        // Real document.open() clears Window listeners. The guard must restore
        // its stopper after this reset and before widget HTML begins parsing.
        sandboxWindow.listeners.clear();
      },
      write(html) {
        sandboxWindow.onbeforeunload = () => 'too late';
        sandboxWindow.addEventListener('beforeunload', () => {
          sandboxWindow.beforeUnloadCalls++;
        });
        guardedAtWrite = sandboxWindow.onbeforeunload === null
          && (sandboxWindow.listeners.get('beforeunload')?.length ?? 0) === 1;

        for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/gi)) {
          vm.runInContext(match[1], vmContext);
        }
      },
      close() {},
    };

    vmContext = vm.createContext({
      URL,
      URLSearchParams,
      Event: FakeEvent,
      EventTarget: FakeEventTarget,
      document,
      window: sandboxWindow,
    });
    vm.runInContext(script, vmContext);

    const message = sandboxWindow.listeners.get('message')?.[0]?.listener;
    assert.equal(typeof message, 'function', 'message listener must be registered');

    const widgetHtml = `<script>
window.beforeUnloadCalls = 0;
window.clickCalls = 0;
window.onbeforeunload = function () {
  window.beforeUnloadCalls++;
  return 'blocked';
};
window.addEventListener('beforeunload', function () {
  window.beforeUnloadCalls++;
});
EventTarget.prototype.addEventListener.call(window, 'beforeunload', function () {
  window.beforeUnloadCalls++;
});
window.addEventListener('click', {
  handleEvent: function () {
    window.clickCalls++;
  }
}, { once: true, passive: true });
window.dispatchEvent(new Event('beforeunload'));
window.dispatchEvent(new Event('click'));
window.dispatchEvent(new Event('click'));
</script>`;

    assert.doesNotThrow(() => {
      message.call(sandboxWindow, {
        data: { type: 'wm-html', id: 'wm-1', token: 'test-token', html: widgetHtml },
        origin: 'https://worldmonitor.app',
        source: parent,
      });
    });

    assert.equal(guardedAtWrite, true, 'beforeunload guard must be active when document.write starts');
    assert.equal(sandboxWindow.onbeforeunload, null, 'onbeforeunload assignments must remain inert');
    sandboxWindow.onbeforeunload = () => 'still blocked';
    assert.equal(sandboxWindow.onbeforeunload, null, 'ordinary reassignment must not restore onbeforeunload');
    assert.equal(sandboxWindow.beforeUnloadCalls, 0, 'the native stopper must block later beforeunload handlers');
    assert.equal(sandboxWindow.clickCalls, 1, 'listener objects and normal event options must still work');
  });

  it('PRO widget message listener has AbortController cleanup wired to iframe removal', () => {
    // P1 (greptile #3912): the global `message` listener registered by
    // mountProWidget would otherwise retain a strong reference to the
    // iframe (and its ~80 KB HTML payload) for the lifetime of the page,
    // even after the iframe is removed from the DOM — a real leak in any
    // dashboard session that adds/removes widgets repeatedly. The fix is
    // an AbortController per iframe + a MutationObserver `removedNodes`
    // pass that calls `unmountProWidget`, which aborts the listener and
    // clears every per-iframe WeakMap entry.
    assert.ok(
      san.includes('iframeAbortStore') && san.includes('new AbortController()'),
      'mountProWidget must create an AbortController per iframe and store it',
    );
    assert.ok(
      san.includes("{ signal: controller.signal }"),
      'message listener must be registered with the AbortController signal so abort() removes it',
    );
    assert.ok(
      san.includes('function unmountProWidget') && san.includes('controller.abort')
        || (san.includes('function unmountProWidget') && san.includes('iframeAbortStore.get(iframe)?.abort()')),
      'unmountProWidget must abort the controller (tearing down the listener)',
    );
    assert.ok(
      san.includes('iframeAbortStore.delete(iframe)')
        && san.includes('iframeTokenStore.delete(iframe)')
        && san.includes('iframeHtmlStore.delete(iframe)'),
      'unmountProWidget must clear every per-iframe WeakMap entry to release the HTML payload',
    );
    assert.ok(
      san.includes('mut.removedNodes') && san.includes('unmountProWidget'),
      'MutationObserver must scan removedNodes and call unmountProWidget so the cleanup actually fires when widgets are removed',
    );
  });

  it('PRO widget re-deliveries are rate-limited to bound document.write storms', () => {
    // P2 (greptile #3912): a malicious widget that re-reads its token from
    // window.location.hash and re-posts wm-widget-ready could trigger an
    // unbounded document.write loop (parent responds → write replaces doc
    // → new doc re-posts ready → parent responds again). Rate-limiting
    // deliveries to once per second per iframe is the smallest fix that
    // bounds the loop while preserving legitimate drag/drop re-navigation
    // (which is human-paced and trivially clears the floor). Greptile's
    // suggested verbatim fix (delete iframeTokenStore after first delivery)
    // would break the documented re-navigation use case at the call site,
    // so we keep the token alive and gate on time instead.
    assert.ok(
      san.includes('MIN_DELIVERY_INTERVAL_MS') && san.includes('iframeLastDeliveryMs'),
      'must declare a per-iframe last-delivery timestamp store and a minimum interval',
    );
    const intervalMatch = san.match(/MIN_DELIVERY_INTERVAL_MS\s*=\s*(\d+)/);
    assert.ok(intervalMatch, 'MIN_DELIVERY_INTERVAL_MS must be a numeric literal');
    const interval = Number(intervalMatch[1]);
    assert.ok(
      interval >= 500 && interval <= 5000,
      `MIN_DELIVERY_INTERVAL_MS must be between 500ms and 5s (got ${interval}) — too low fails to bound a loop, too high breaks drag/drop`,
    );
    assert.ok(
      san.includes('now - last < MIN_DELIVERY_INTERVAL_MS'),
      'message handler must return early when called within the throttle window',
    );
    assert.ok(
      san.includes('iframeLastDeliveryMs.set(iframe, now)'),
      'message handler must record the delivery time so the next call is throttled',
    );
  });

  it('widget document builder injects panel CSS classes for design-system alignment', () => {
    assert.ok(san.includes('.panel-header'), 'must define .panel-header');
    assert.ok(san.includes('.panel-title'), 'must define .panel-title');
    assert.ok(san.includes('.panel-tabs'), 'must define .panel-tabs');
    assert.ok(san.includes('.panel-tab'), 'must define .panel-tab');
    assert.ok(san.includes('.disp-stats-grid'), 'must define .disp-stats-grid');
    assert.ok(san.includes('.disp-stat-box'), 'must define .disp-stat-box');
    assert.ok(san.includes('--accent'), 'must define --accent CSS variable');
  });

  it('widget document builder injects Chart.js from jsdelivr so new Chart() is available', () => {
    assert.ok(
      san.includes('cdn.jsdelivr.net') && san.includes('chart.js'),
      'widget sanitizer must inject Chart.js CDN script so widgets can call new Chart(...)',
    );
    // Script must appear before <body> so Chart is defined when body scripts run
    const scriptPos = san.indexOf('chart.js');
    const bodyPos = san.indexOf('<body>');
    assert.ok(
      scriptPos < bodyPos,
      'Chart.js script tag must be in <head>, before <body>',
    );
  });
});


// ---------------------------------------------------------------------------
// 13. PRO widget — modal and layout
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 14. PRO widget — i18n and CSS
// ---------------------------------------------------------------------------
describe('PRO widget — i18n keys and CSS', () => {
  const en = JSON.parse(src('src/locales/en.json'));
  const css = src('src/styles/main.css');

  const PRO_REQUIRED_KEYS = [
    'createInteractive',
    'proBadge',
    'preflightProUnavailable',
  ];

  for (const key of PRO_REQUIRED_KEYS) {
    it(`widgets.${key} is defined and non-empty`, () => {
      assert.ok(
        en.widgets && typeof en.widgets[key] === 'string' && en.widgets[key].length > 0,
        `en.json must have non-empty widgets.${key}`,
      );
    });
  }

  it('widgets.proExamples has all 4 example keys', () => {
    const exKeys = ['interactiveChart', 'sortableTable', 'animatedCounters', 'tabbedComparison'];
    for (const key of exKeys) {
      assert.ok(
        en.widgets?.proExamples?.[key] && en.widgets.proExamples[key].length > 0,
        `en.json must have non-empty widgets.proExamples.${key}`,
      );
    }
  });

  it('.widget-pro-badge CSS class defined', () => {
    assert.ok(
      css.includes('.widget-pro-badge'),
      'CSS must define .widget-pro-badge class for PRO pill badge',
    );
  });

  it('.wm-widget-pro iframe CSS sets 400px height', () => {
    assert.ok(
      css.includes('.wm-widget-pro'),
      'CSS must target .wm-widget-pro for PRO iframe container',
    );
    const proIdx = css.indexOf('.wm-widget-pro');
    const proRegion = css.slice(proIdx, proIdx + 300);
    assert.ok(
      proRegion.includes('400px') || css.includes('400px'),
      'PRO iframe must have 400px height defined in CSS',
    );
  });
});


// ---------------------------------------------------------------------------
// panel-layout — Pro CTAs must re-evaluate on Convex entitlement updates
// ---------------------------------------------------------------------------
//
// "Create Interactive Widget" (proBlock) and "Connect MCP" (mcpBlock) are
// gated by applyProBlockGating(hasPremiumAccess(...)). For a paying Dodo
// subscriber whose Clerk publicMetadata.plan is never written, hasPremiumAccess
// only flips true once the Convex entitlement snapshot lands via
// onEntitlementChange — NOT via subscribeAuthState. Subscribing only to
// subscribeAuthState (the prior shape) meant the CTAs stayed display:none for
// the entire page lifetime for paying users. Lock the dual-subscription.
describe('panel-layout — Pro add-block gating reacts to entitlement updates', () => {
  const layout = src('src/app/panel-layout.ts');

});