/**
 * Tests for the country chip picker (FocusEditor's country scope).
 *
 * Two test surfaces:
 *  1. Source-grep on src/utils/country-chip-picker.ts: the followed list is
 *     read from the window registry, synchronously.
 *  2. Behavioural unit tests on the pure helpers
 *     (normalizeIso2, mountCountryChipPicker via a minimal DOM stub,
 *     loadFollowedCountriesSafe via a window-registry stub).
 *
 * No JSDOM dependency: we hand-roll a tiny element stub sufficient to drive
 * the picker's render + click logic.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeIso2,
  mountCountryChipPicker,
  loadFollowedCountriesSafe,
  COUNTRY_CHIP_PICKER_MAX,
} from '../src/utils/country-chip-picker.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pickerSrc = readFileSync(
  resolve(__dirname, '..', 'src', 'utils', 'country-chip-picker.ts'),
  'utf-8',
);

// ---------------------------------------------------------------------------
// Source-grep contract — country-chip-picker.ts (window-registry pattern)
// ---------------------------------------------------------------------------

describe('country-chip-picker.ts — window-registry pattern (no dynamic import)', () => {
  it('reads from window.__wmFollowedCountries instead of dynamic-importing PR A', () => {
    // The window-registry pattern decouples PR A and PR #3632 shipping
    // cadence: PR A self-registers, PR #3632 reads-if-present. No Vite
    // alias coupling, no @vite-ignore tricks.
    assert.match(
      pickerSrc,
      /window\.__wmFollowedCountries|__wmFollowedCountries/,
      'loadFollowedCountriesSafe must read from window.__wmFollowedCountries',
    );
  });

  it('does NOT use dynamic import for followed-countries (legacy approach removed)', () => {
    // The legacy approach used `import(/* @vite-ignore */ path)` which
    // leaves the unresolvable `@/services/followed-countries` alias in the
    // browser bundle. We replaced it with the window-registry pattern.
    assert.doesNotMatch(
      pickerSrc,
      /import\s*\(\s*\/\*\s*@vite-ignore\s*\*\/\s*path\s*\)/,
      'must not use legacy dynamic-import-with-@vite-ignore approach',
    );
    assert.doesNotMatch(
      pickerSrc,
      /const\s+path\s*=\s*['"]@\/services\/followed-countries['"]/,
      'must not stash followed-countries alias in a string variable',
    );
  });

  it('loadFollowedCountriesSafe is synchronous (no async / no Promise return)', () => {
    // The function signature was changed from `async function` /
    // `Promise<string[]>` to a synchronous `string[]` return so callers
    // don't need to await. This avoids accidentally serializing first paint
    // on a cache hit.
    assert.match(
      pickerSrc,
      /export\s+function\s+loadFollowedCountriesSafe\s*\(\s*\)\s*:\s*string\[\]/,
      'loadFollowedCountriesSafe must be synchronous and return string[]',
    );
    assert.doesNotMatch(
      pickerSrc,
      /export\s+async\s+function\s+loadFollowedCountriesSafe/,
      'must not be async',
    );
  });
});

// ---------------------------------------------------------------------------
// Behavioural — normalizeIso2
// ---------------------------------------------------------------------------

describe('normalizeIso2', () => {
  it('accepts uppercase 2-letter codes', () => {
    assert.equal(normalizeIso2('US'), 'US');
    assert.equal(normalizeIso2('GB'), 'GB');
  });

  it('uppercases lowercase input', () => {
    assert.equal(normalizeIso2('us'), 'US');
    assert.equal(normalizeIso2('gb'), 'GB');
  });

  it('trims whitespace', () => {
    assert.equal(normalizeIso2('  IR  '), 'IR');
  });

  it('rejects non-2-letter shapes', () => {
    assert.equal(normalizeIso2('USA'), null);
    assert.equal(normalizeIso2('U'), null);
    assert.equal(normalizeIso2(''), null);
    assert.equal(normalizeIso2('US123'), null);
    assert.equal(normalizeIso2('United States'), null);
    assert.equal(normalizeIso2('1A'), null);
  });
});

// ---------------------------------------------------------------------------
// Behavioural — loadFollowedCountriesSafe (window registry)
// ---------------------------------------------------------------------------

describe('loadFollowedCountriesSafe — window-registry stub', () => {
  // The picker module reads `window.__wmFollowedCountries` at call time;
  // we mutate `globalThis.window` per-test to drive the registry.
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = {};
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it('returns [] when window.__wmFollowedCountries is absent (PR A not loaded)', () => {
    // Default degraded behavior — picker shows nothing pre-checked.
    assert.deepEqual(loadFollowedCountriesSafe(), []);
  });

  it('returns the registry value when PR A self-registered', () => {
    (globalThis as { window: { __wmFollowedCountries?: unknown } }).window.__wmFollowedCountries = {
      getFollowed: () => ['US', 'GB'],
    };
    assert.deepEqual(loadFollowedCountriesSafe(), ['US', 'GB']);
  });

  it('normalizes registry values (lowercase → uppercase, trim, drop bad shapes)', () => {
    (globalThis as { window: { __wmFollowedCountries?: unknown } }).window.__wmFollowedCountries = {
      getFollowed: () => ['us', '  GB  ', 'United States', 'Z'],
    };
    assert.deepEqual(loadFollowedCountriesSafe(), ['US', 'GB']);
  });

  it('returns [] when getFollowed throws', () => {
    (globalThis as { window: { __wmFollowedCountries?: unknown } }).window.__wmFollowedCountries = {
      getFollowed: () => { throw new Error('boom'); },
    };
    assert.deepEqual(loadFollowedCountriesSafe(), []);
  });

  it('returns [] when getFollowed returns a non-array', () => {
    (globalThis as { window: { __wmFollowedCountries?: unknown } }).window.__wmFollowedCountries = {
      getFollowed: () => 'not-an-array',
    };
    assert.deepEqual(loadFollowedCountriesSafe(), []);
  });

  it('returns [] when getFollowed is missing', () => {
    (globalThis as { window: { __wmFollowedCountries?: unknown } }).window.__wmFollowedCountries = {};
    assert.deepEqual(loadFollowedCountriesSafe(), []);
  });
});

// ---------------------------------------------------------------------------
// Behavioural — mountCountryChipPicker via minimal DOM stub
// ---------------------------------------------------------------------------

// Minimal DOM stub. Only the methods/properties the picker touches:
//  - innerHTML (read after render to inspect output)
//  - querySelector / querySelectorAll (against the rendered HTML)
//  - addEventListener / removeEventListener
//  - dispatchEvent (so we can trigger click handlers)
//
// This is much smaller than pulling in JSDOM/happy-dom for one test file.
// Trade-off: we re-render text, then re-parse the HTML each time we want to
// inspect — fine for a handful of assertions.

interface FakeElement {
  innerHTML: string;
  __listeners: Map<string, Set<(e: any) => void>>;
  querySelector: <T = FakeElement>(selector: string) => T | null;
  querySelectorAll: <T = FakeElement>(selector: string) => T[];
  addEventListener: (type: string, handler: (e: any) => void) => void;
  removeEventListener: (type: string, handler: (e: any) => void) => void;
  dispatchEvent: (e: any) => void;
}

function makeFakeElement(): FakeElement {
  const el: FakeElement = {
    innerHTML: '',
    __listeners: new Map(),
    addEventListener(type: string, handler: (e: any) => void) {
      let s = this.__listeners.get(type);
      if (!s) {
        s = new Set();
        this.__listeners.set(type, s);
      }
      s.add(handler);
    },
    removeEventListener(type: string, handler: (e: any) => void) {
      this.__listeners.get(type)?.delete(handler);
    },
    dispatchEvent(e: any) {
      const handlers = this.__listeners.get(e.type) ?? new Set();
      for (const h of handlers) h(e);
    },
    querySelector<T = FakeElement>(_selector: string): T | null {
      // Picker only needs querySelector for the input + add button after a
      // re-render. Returning null is fine for assertions that don't depend on
      // those elements.
      return null;
    },
    querySelectorAll<T = FakeElement>(_selector: string): T[] {
      return [];
    },
  };
  return el;
}

function chipMarkup(html: string, code: string): string {
  const match = html.match(new RegExp('<button[^>]*data-code="' + code + '"[^>]*>[\\s\\S]*?<\\/button>'));
  assert.ok(match, `expected ${code} chip markup`);
  return match[0];
}

function cssRuleBody(css: string, selector: string): string {
  const selectorPattern = selector.replace(/\./g, '\\.');
  const match = css.match(new RegExp(selectorPattern + '\\s*\\{([\\s\\S]*?)\\}'));
  assert.ok(match, `expected ${selector} CSS rule`);
  return match[1];
}

describe('mountCountryChipPicker', () => {
  it('renders chips for the initial selection', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    const picker = mountCountryChipPicker(root, { initial: ['US', 'GB'] });
    assert.match(root.innerHTML, /data-code="US"/, 'must render US chip');
    assert.match(root.innerHTML, /data-code="GB"/, 'must render GB chip');
    assert.match(
      root.innerHTML,
      /data-code="US"[^>]*aria-pressed="true"/,
      'US chip must be pressed',
    );
    assert.match(
      root.innerHTML,
      /data-code="GB"[^>]*aria-pressed="true"/,
      'GB chip must be pressed',
    );
    assert.deepEqual(picker.getValue(), ['US', 'GB']);
    picker.destroy();
  });

  it('initial=[] renders all chips unpressed (= all countries)', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    const picker = mountCountryChipPicker(root, { initial: [] });
    assert.deepEqual(picker.getValue(), []);
    // No aria-pressed="true" should appear when nothing is selected.
    assert.doesNotMatch(
      root.innerHTML,
      /aria-pressed="true"/,
      'no chips should be pressed when initial=[]',
    );
    picker.destroy();
  });

  it('normalizes initial values (lowercase, whitespace, dedupe, drop bad shapes)', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    const picker = mountCountryChipPicker(root, {
      initial: ['us', '  GB  ', 'US', 'United States', 'Z'],
    });
    assert.deepEqual(picker.getValue(), ['US', 'GB']);
    picker.destroy();
  });

  it('caps initial and setValue selections at 50 countries', () => {
    const codes: string[] = [];
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    outer: for (let i = 0; i < letters.length; i++) {
      for (let j = 0; j < letters.length; j++) {
        codes.push(letters[i] + letters[j]);
        if (codes.length >= COUNTRY_CHIP_PICKER_MAX + 10) break outer;
      }
    }

    const root = makeFakeElement() as unknown as HTMLElement;
    const picker = mountCountryChipPicker(root, { initial: codes });
    assert.equal(picker.getValue().length, COUNTRY_CHIP_PICKER_MAX);

    picker.setValue(codes.reverse());
    assert.equal(picker.getValue().length, COUNTRY_CHIP_PICKER_MAX);
    picker.destroy();
  });

  it('setValue replaces the selection and emits onChange', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    const events: string[][] = [];
    const picker = mountCountryChipPicker(root, {
      initial: ['US'],
      onChange: (codes) => { events.push(codes); },
    });
    picker.setValue(['fr', 'DE']);
    assert.deepEqual(picker.getValue(), ['FR', 'DE']);
    assert.deepEqual(events.at(-1), ['FR', 'DE']);
    picker.destroy();
  });

  it('chip toggle: clicking a pressed chip removes it', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    let lastEmit: string[] = [];
    const picker = mountCountryChipPicker(root, {
      initial: ['US', 'GB'],
      onChange: (codes) => { lastEmit = codes; },
    });
    // Simulate a click on the US chip. The picker delegates via root's
    // 'click' event; our fake supports dispatchEvent. We emulate the
    // target.closest('.us-notif-country-chip') by handing a stub target.
    const fakeChip = {
      dataset: { code: 'US' },
      closest(sel: string) {
        return sel === '.us-notif-country-chip' ? this : null;
      },
      matches(_sel: string) { return false; },
    };
    root.dispatchEvent({ type: 'click', target: fakeChip });
    assert.deepEqual(picker.getValue(), ['GB']);
    assert.deepEqual(lastEmit, ['GB']);
    picker.destroy();
  });

  it('chip toggle: clicking an unpressed chip adds it', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    let lastEmit: string[] = [];
    const picker = mountCountryChipPicker(root, {
      initial: [],
      onChange: (codes) => { lastEmit = codes; },
    });
    const fakeChip = {
      dataset: { code: 'FR' },
      closest(sel: string) {
        return sel === '.us-notif-country-chip' ? this : null;
      },
      matches(_sel: string) { return false; },
    };
    root.dispatchEvent({ type: 'click', target: fakeChip });
    assert.deepEqual(picker.getValue(), ['FR']);
    assert.deepEqual(lastEmit, ['FR']);
    picker.destroy();
  });

  it('destroy clears innerHTML and detaches listeners', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    let emitted = false;
    const picker = mountCountryChipPicker(root, {
      initial: ['US'],
      onChange: () => { emitted = true; },
    });
    picker.destroy();
    assert.equal(root.innerHTML, '', 'innerHTML cleared on destroy');
    // Sanity: post-destroy click is a no-op (listener removed).
    picker.destroy(); // idempotent
    const fakeChip = {
      dataset: { code: 'GB' },
      closest(sel: string) {
        return sel === '.us-notif-country-chip' ? this : null;
      },
      matches(_sel: string) { return false; },
    };
    root.dispatchEvent({ type: 'click', target: fakeChip });
    assert.equal(emitted, false);
  });
});

// ---------------------------------------------------------------------------
// Regression — selected-chip removal affordance (visible ✕ + selected-state CSS)
//
// Field report: a Pro user could not remove default country chips — "chips do
// not show an X and clicking them does not remove them." Root cause was purely
// presentational: the toggle worked (see tests above), but the `-on` state had
// NO CSS (a selected chip looked identical to an unselected one, so toggling
// off appeared to do nothing) and there was no ✕ affordance. Guard both so the
// widget can never regress back to an invisible selected state.
// ---------------------------------------------------------------------------

describe('country picker — removal affordance (regression)', () => {
  it('selected chips render a ✕ remove glyph; unselected chips do not', () => {
    const selected = makeFakeElement() as unknown as HTMLElement;
    mountCountryChipPicker(selected, { initial: ['US'] });
    const selectedUs = chipMarkup(selected.innerHTML, 'US');
    assert.match(
      selectedUs,
      /us-notif-country-chip-on/,
      'a selected chip must render the selected-state class',
    );
    assert.match(
      selectedUs,
      /us-notif-country-chip-x/,
      'a selected chip must render the ✕ remove affordance',
    );
    assert.match(
      selectedUs,
      /title="Remove United States"/,
      'a selected common chip must expose remove tooltip copy',
    );

    const empty = makeFakeElement() as unknown as HTMLElement;
    mountCountryChipPicker(empty, { initial: [] });
    const unselectedUs = chipMarkup(empty.innerHTML, 'US');
    assert.doesNotMatch(
      unselectedUs,
      /us-notif-country-chip-on/,
      'an unselected chip must not render the selected-state class',
    );
    assert.doesNotMatch(
      unselectedUs,
      /us-notif-country-chip-x/,
      'no ✕ affordance should render when nothing is selected',
    );
    assert.match(
      unselectedUs,
      /title="Add United States"/,
      'an unselected common chip must expose add tooltip copy',
    );
  });

  it('clicking a selected chip visibly returns it to the unselected state', () => {
    const root = makeFakeElement() as unknown as HTMLElement;
    const picker = mountCountryChipPicker(root, { initial: ['US'] });
    const fakeChip = {
      dataset: { code: 'US' },
      closest(sel: string) {
        return sel === '.us-notif-country-chip' ? this : null;
      },
      matches(_sel: string) { return false; },
    };

    root.dispatchEvent({ type: 'click', target: fakeChip });

    const usChip = chipMarkup(root.innerHTML, 'US');
    assert.deepEqual(picker.getValue(), []);
    assert.match(
      usChip,
      /aria-pressed="false"/,
      'removing a selected chip must update its pressed state',
    );
    assert.doesNotMatch(
      usChip,
      /us-notif-country-chip-on/,
      'removing a selected chip must clear the selected-state class',
    );
    assert.doesNotMatch(
      usChip,
      /us-notif-country-chip-x/,
      'removing a selected chip must clear the ✕ affordance',
    );
    assert.match(
      usChip,
      /title="Add United States"/,
      'removing a selected chip must restore add tooltip copy',
    );
    picker.destroy();
  });

  it('custom (non-common) selected codes also render the ✕ remove glyph', () => {
    // RO is not in COMMON_COUNTRIES — it renders as an "extra" chip.
    const root = makeFakeElement() as unknown as HTMLElement;
    mountCountryChipPicker(root, { initial: ['RO'] });
    assert.match(
      root.innerHTML,
      /data-code="RO"[\s\S]*?us-notif-country-chip-x/,
      'a custom selected chip must render the ✕ remove affordance',
    );
  });

  it('main.css defines a visible selected (-on) state — the missing rule that caused the bug', () => {
    const css = readFileSync(
      resolve(__dirname, '..', 'src', 'styles', 'main.css'),
      'utf-8',
    );
    const baseRule = cssRuleBody(css, '.us-notif-country-chip');
    const selectedRule = cssRuleBody(css, '.us-notif-country-chip-on');
    assert.match(baseRule, /background:\s*transparent;/, 'base chip must render as unselected');
    assert.match(
      selectedRule,
      /background:\s*rgba\(52,\s*211,\s*153,\s*0\.12\);/,
      'selected chip must have a visible selected background',
    );
    assert.match(
      selectedRule,
      /border-color:\s*rgba\(52,\s*211,\s*153,\s*0\.4\);/,
      'selected chip must have a visible selected border',
    );
    assert.match(
      selectedRule,
      /color:\s*var\(--settings-green\);/,
      'selected chip must have a visible selected text color',
    );
    assert.match(
      css,
      /\.us-notif-country-chip-x\s*\{/,
      'main.css must style the ✕ remove glyph',
    );
  });

  it('add-code row is styled by main.css, not an unstyled class plus inline styles', () => {
    const css = readFileSync(
      resolve(__dirname, '..', 'src', 'styles', 'main.css'),
      'utf-8',
    );
    const pickerSrc = readFileSync(
      resolve(__dirname, '..', 'src', 'utils', 'country-chip-picker.ts'),
      'utf-8',
    );
    // `unified-settings-input` had no rule anywhere, so the input rendered as a
    // raw white browser box with an uppercased, clipped placeholder.
    assert.doesNotMatch(pickerSrc, /unified-settings-input/);
    assert.doesNotMatch(pickerSrc, /style="/, 'picker markup must not carry inline styles');
    const inputRule = cssRuleBody(css, '.us-notif-country-add-input');
    assert.match(inputRule, /background:\s*var\(--settings-surface-inset\);/);
    assert.match(inputRule, /color:\s*var\(--settings-text\);/);
    assert.match(
      css,
      /\.us-notif-country-add-input::placeholder\s*\{[^}]*text-transform:\s*none;/,
      'placeholder must not inherit the uppercase transform',
    );
    assert.match(css, /\.us-notif-country-add-row\s*\{/);
    assert.match(cssRuleBody(css, '.us-notif-country-error'), /color:\s*var\(--settings-red\);/);
  });
});
