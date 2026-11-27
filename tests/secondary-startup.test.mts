import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dashboardFontFamilies } from '../src/bootstrap/secondary-startup.ts';
import { scheduleAfterFirstPaint } from '../src/utils/after-paint.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const activeMarkup = indexHtml.replace(/<!--[\s\S]*?-->/g, '');

describe('secondary dashboard startup', () => {
  it('keeps analytics, auth, Sentry, and font fetches out of index.html startup tags', () => {
    assert.equal(
      /<script\b[^>]+src=["']https:\/\/abacus\.worldmonitor\.app\/script\.js["']/i.test(activeMarkup),
      false,
      'Umami must be injected by the deferred dashboard loader, not index.html',
    );
    assert.equal(
      /<script\b[^>]+src=["']https:\/\/cdn\.debugbear\.com\/[^"']+\.js["']/i.test(activeMarkup),
      false,
      'DebugBear RUM must be injected by the dashboard loader, not index.html',
    );
    assert.equal(
      /<link\b[^>]+rel=["']preconnect["'][^>]+href=["']https:\/\/o4509927897890816\.ingest\.us\.sentry\.io["']/i.test(activeMarkup),
      false,
      'Sentry ingest preconnect must not compete with initial dashboard paint',
    );
    assert.equal(
      /<link\b[^>]+rel=["']dns-prefetch["'][^>]+href=["']https:\/\/clerk\.worldmonitor\.app["']/i.test(activeMarkup),
      false,
      'Clerk dns-prefetch must not run before the deferred Clerk loader',
    );
    assert.equal(
      /<link\b[^>]+href=["']https:\/\/fonts\.googleapis\.com\/css2\?/i.test(activeMarkup),
      false,
      'Google Fonts stylesheet must not be an eager head request',
    );
    assert.equal(
      /<link\b[^>]+rel=["']preconnect["'][^>]+href=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com["']/i.test(activeMarkup),
      false,
      'Google Fonts preconnects must be deferred with the narrowed font request',
    );
  });

  it('does not load any web font for the default English dashboard', () => {
    assert.deepEqual(dashboardFontFamilies({ variant: 'full', lang: 'en', dir: '' }), []);
  });


  it('loads only Tajawal for the Arabic dashboard, not happy fonts', () => {
    assert.deepEqual(dashboardFontFamilies({ variant: 'full', lang: 'ar', dir: 'rtl' }), ['tajawal']);
  });

});

describe('scheduleAfterFirstPaint', () => {
  it('runs the task via the load-event listener when readyState is not complete', () => {
    const loadHandlers: Array<() => void> = [];
    const frames: Array<() => void> = [];
    const idle: Array<() => void> = [];
    const fakeWindow = {
      requestAnimationFrame: (cb: () => void) => {
        frames.push(cb);
        return frames.length;
      },
      requestIdleCallback: (cb: () => void) => {
        idle.push(cb);
        return idle.length;
      },
      addEventListener: (type: string, cb: () => void) => {
        if (type === 'load') loadHandlers.push(cb);
      },
    };
    const fakeDocument = { readyState: 'loading' };
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
    try {
      let ran = 0;
      scheduleAfterFirstPaint(() => {
        ran += 1;
      });
      assert.equal(ran, 0, 'task must not run before the load event fires');
      assert.equal(loadHandlers.length, 1, 'a load listener must be registered');
      loadHandlers[0]!();
      assert.equal(ran, 0, 'load must leave a paint opportunity before the task');
      assert.equal(idle.length, 0, 'idle work must wait for the animation frames');
      assert.equal(frames.length, 1);
      frames.shift()!();
      assert.equal(ran, 0);
      assert.equal(idle.length, 0, 'one animation frame must leave another paint opportunity');
      assert.equal(frames.length, 1);
      frames.shift()!();
      assert.equal(ran, 0, 'the task must still wait for idle');
      assert.equal(frames.length, 0);
      assert.equal(idle.length, 1);
      idle.shift()!();
      assert.equal(ran, 1, 'task runs once after load, paint, and idle');
      loadHandlers[0]!();
      frames.shift()!();
      frames.shift()!();
      idle.shift()!();
      assert.equal(ran, 1, 'repeated scheduling must not run the task twice');
    } finally {
      if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
      else delete (globalThis as { document?: unknown }).document;
    }
  });

  it('falls back to setTimeout when requestIdleCallback is absent', () => {
    const timers: Array<() => void> = [];
    const fakeWindow = {
      requestAnimationFrame: (cb: () => void) => {
        cb();
        return 1;
      },
      addEventListener: () => {},
    };
    const fakeDocument = { readyState: 'complete' };
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const savedSetTimeout = Object.getOwnPropertyDescriptor(globalThis, 'setTimeout');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
    Object.defineProperty(globalThis, 'setTimeout', {
      configurable: true,
      value: (cb: () => void) => {
        timers.push(cb);
        return timers.length;
      },
    });
    try {
      let ran = 0;
      scheduleAfterFirstPaint(() => {
        ran += 1;
      });
      assert.equal(ran, 0, 'the fallback must defer the task');
      assert.equal(timers.length, 1);
      timers.shift()!();
      assert.equal(ran, 1, 'task runs via the setTimeout fallback when rIC is missing');
    } finally {
      if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument);
      else delete (globalThis as { document?: unknown }).document;
      if (savedSetTimeout) Object.defineProperty(globalThis, 'setTimeout', savedSetTimeout);
    }
  });
});
