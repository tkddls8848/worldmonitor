import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SETTINGS_GROUPS,
  SETTINGS_SECTION_IDS,
  buildNav,
  diffNav,
  isAvailable,
  isPreferenceSection,
  pageEntryEffect,
  reduceNav,
  searchNav,
  searchTerms,
  type NavGroup,
  type NavLayout,
  type NavState,
  type SettingsFacts,
  type SettingsSectionId,
  type Translate,
} from '../src/config/settings-sections.ts';

const EN: unknown = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8'));

const facts = (overrides: Partial<SettingsFacts> = {}): SettingsFacts => ({
  panels: { on: 18, total: 64 },
  sourcesOn: 412,
  theme: 'auto',
  ...overrides,
});

function at(page: SettingsSectionId | null, f = facts(), layout: NavLayout = 'sheet'): NavState {
  return reduceNav(null, { type: 'open', target: page ?? undefined, layout, recent: null }, f);
}

function openIn(layout: NavLayout, target?: SettingsSectionId, recent: SettingsSectionId | null = null, f = facts()): NavState {
  return reduceNav(null, { type: 'open', target, layout, recent }, f);
}

function relayout(prev: NavState, layout: NavLayout, recent: SettingsSectionId | null = null, f = facts()): NavState {
  return reduceNav(prev, { type: 'relayout', layout, recent }, f);
}

function rowIds(f: SettingsFacts): string[] {
  return buildNav(f).flatMap((group) => group.rows.map((row) => row.id));
}

describe('settings sections registry', () => {
  it('declares every section once', () => {
    assert.equal(new Set(SETTINGS_SECTION_IDS).size, SETTINGS_SECTION_IDS.length);
    assert.deepEqual([...SETTINGS_SECTION_IDS], [
      'panels', 'sources',
      'display', 'map', 'ai', 'video',
      'sync', 'about',
    ]);
  });

  it('routes the preference pages to preferences-content and the rest to the shell', () => {
    const preference = SETTINGS_SECTION_IDS.filter(isPreferenceSection);
    assert.deepEqual(preference, ['display', 'map', 'ai', 'video', 'sync']);
  });

  it('makes every section available', () => {
    for (const id of SETTINGS_SECTION_IDS) {
      assert.equal(isAvailable(id, facts()), true, id);
    }
  });

  it('lists every section in registry order', () => {
    assert.deepEqual(rowIds(facts()), [...SETTINGS_SECTION_IDS]);
  });

  it('groups rows under their headings', () => {
    const groups = buildNav(facts());
    assert.deepEqual(groups.map((g) => [g.id, g.labelKey]), [
      ['dashboard', 'settings.groups.dashboard'],
      ['preferences', 'settings.groups.preferences'],
      ['app', 'settings.groups.app'],
    ]);
    assert.equal(SETTINGS_GROUPS.length, groups.length);
  });

  it('summarises rows as data the view formats', () => {
    const rows = new Map(buildNav(facts({ theme: 'dark' })).flatMap((g) => g.rows)
      .map((row) => [row.id, row] as const));
    assert.deepEqual(rows.get('panels')?.summary, { kind: 'count', on: 18, total: 64 });
    assert.deepEqual(rows.get('sources')?.summary, { kind: 'total', count: 412 });
    assert.deepEqual(rows.get('display')?.summary, { kind: 'text', key: 'preferences.themeDark' });
    assert.equal(rows.get('map')?.summary, null);
  });

  it('follows the theme in the display summary', () => {
    const display = (theme: SettingsFacts['theme']) => {
      const row = buildNav(facts({ theme })).flatMap((g) => g.rows)
        .find((r) => r.id === 'display');
      return row?.summary;
    };
    assert.deepEqual(display('auto'), { kind: 'text', key: 'settings.summary.themeAuto' });
    assert.deepEqual(display('light'), { kind: 'text', key: 'preferences.themeLight' });
  });
});

describe('settings navigation reducer', () => {
  it('opens on the home list without a target', () => {
    assert.equal(at(null).page, null);
  });

  it('opens straight onto a target', () => {
    assert.equal(at('sources').page, 'sources');
    assert.equal(at('about').page, 'about');
  });

  it('selects a section', () => {
    const panels = reduceNav(at(null), { type: 'select', id: 'panels' }, facts());
    assert.equal(panels.page, 'panels');
  });

  it('goes back to the home list', () => {
    assert.equal(reduceNav(at('map'), { type: 'back' }, facts()).page, null);
  });

  it('returns the same state for a repeated event', () => {
    const map = at('map');
    assert.equal(reduceNav(map, { type: 'select', id: 'map' }, facts()), map);
    const home = at(null);
    assert.equal(reduceNav(home, { type: 'back' }, facts()), home);
    assert.equal(reduceNav(map, { type: 'facts-changed' }, facts()), map);
  });

  it('re-opens onto a new target while already open', () => {
    const map = at('map');
    const reopen = (target?: SettingsSectionId) => reduceNav(map, { type: 'open', target, layout: 'sheet', recent: 'map' }, facts());
    assert.equal(reopen('sources').page, 'sources');
    assert.equal(reopen().page, null);
  });
});

describe('settings navigation effects', () => {
  it('enters the first page of a session', () => {
    assert.deepEqual(diffNav(null, at('panels')), { leave: null, enter: 'panels' });
    assert.deepEqual(diffNav(null, at(null)), { leave: null, enter: null });
  });

  it('leaves before it enters', () => {
    const panels = at('panels');
    const sources = reduceNav(panels, { type: 'select', id: 'sources' }, facts());
    assert.deepEqual(diffNav(panels, sources), { leave: 'panels', enter: 'sources' });
  });

  it('leaves without entering on back', () => {
    const ai = at('ai');
    assert.deepEqual(diffNav(ai, reduceNav(ai, { type: 'back' }, facts())), { leave: 'ai', enter: null });
  });

  it('has no effects for a no-op transition', () => {
    const ai = at('ai');
    assert.deepEqual(diffNav(ai, reduceNav(ai, { type: 'select', id: 'ai' }, facts())), { leave: null, enter: null });
    const home = at(null);
    assert.deepEqual(diffNav(home, reduceNav(home, { type: 'back' }, facts())), { leave: null, enter: null });
  });
});

describe('settings page history entry', () => {
  it('holds an entry for an open page on the phone sheet above a Settings entry', () => {
    assert.equal(pageEntryEffect(at('sources'), true), 'hold');
  });

  it('releases it on the home list, in the modal, or without a Settings entry beneath', () => {
    assert.equal(pageEntryEffect(at(null), true), 'release');
    assert.equal(pageEntryEffect(null, true), 'release');
    assert.equal(pageEntryEffect(openIn('modal', 'sources'), true), 'release');
    assert.equal(pageEntryEffect(at('sources'), false), 'release');
  });

  it('follows navigation: a row holds it, back releases it', () => {
    const page = reduceNav(at(null), { type: 'select', id: 'about' }, facts());
    assert.equal(pageEntryEffect(page, true), 'hold');
    assert.equal(pageEntryEffect(reduceNav(page, { type: 'back' }, facts()), true), 'release');
  });

  it('keeps holding one entry while the open page changes', () => {
    const panels = at('panels');
    const sources = reduceNav(panels, { type: 'open', target: 'sources', layout: 'sheet', recent: 'panels' }, facts());
    assert.equal(pageEntryEffect(panels, true), 'hold');
    assert.equal(pageEntryEffect(sources, true), 'hold');
  });

  it('releases it when the sheet widens into the modal and holds it again on return', () => {
    const map = at('map');
    const wide = relayout(map, 'modal', 'map');
    assert.equal(pageEntryEffect(wide, true), 'release');
    assert.equal(pageEntryEffect(relayout(wide, 'sheet', 'map'), true), 'hold');
  });
});

describe('settings navigation in the two-pane modal', () => {
  it('opens on Display the first time, then on the recent page', () => {
    assert.deepEqual(openIn('modal'), openIn('modal', undefined, null));
    assert.equal(openIn('modal').page, 'display');
    assert.equal(openIn('modal').layout, 'modal');
    assert.equal(openIn('modal', undefined, 'sources').page, 'sources');
  });

  it('opens straight onto a target', () => {
    assert.equal(openIn('modal', 'about', 'sources').page, 'about');
  });

  it('selects a section', () => {
    const display = openIn('modal');
    const about = reduceNav(display, { type: 'select', id: 'about' }, facts());
    assert.equal(about.page, 'about');
  });

  it('never shows the home list: back keeps the page', () => {
    const map = openIn('modal', 'map');
    assert.equal(reduceNav(map, { type: 'back' }, facts()), map);
  });

  it('keeps the open page when the modal narrows into the sheet', () => {
    const map = openIn('modal', 'map');
    const narrow = relayout(map, 'sheet', 'map');
    assert.equal(narrow.layout, 'sheet');
    assert.equal(narrow.page, 'map');
    assert.deepEqual(diffNav(map, narrow), { leave: null, enter: null });
    assert.equal(reduceNav(narrow, { type: 'back' }, facts()).page, null);
  });

  it('keeps the open sheet page when the sheet widens into the modal', () => {
    const sources = relayout(at('sources'), 'modal', 'sources');
    assert.equal(sources.layout, 'modal');
    assert.equal(sources.page, 'sources');
  });

  it('selects the recent page, else Display, when the sheet home list widens into the modal', () => {
    const fromHome = (recent: SettingsSectionId | null) => relayout(at(null), 'modal', recent);
    assert.equal(fromHome(null).page, 'display');
    assert.equal(fromHome('about').page, 'about');
    assert.deepEqual(diffNav(at(null), fromHome('about')), { leave: null, enter: 'about' });
  });

  it('returns the same state for a relayout that keeps the layout', () => {
    const map = openIn('modal', 'map');
    assert.equal(relayout(map, 'modal', 'about'), map);
    const home = at(null);
    assert.equal(relayout(home, 'sheet', 'about'), home);
  });
});

describe('settings sidebar search', () => {
  const lookup = (dict: unknown, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], dict);

  /** i18next's t over real catalogues: `ui` is the UI language, English answers lng 'en'. */
  const translate = (ui: unknown): Translate => (key, { lng }) => lookup(lng === 'en' ? EN : ui, key) ?? key;
  const text = searchTerms(translate(EN));

  const ids = (groups: readonly NavGroup[]) =>
    groups.flatMap((group) => group.rows.map((row) => row.id));

  it('keeps every row for an empty or blank query', () => {
    const all = buildNav(facts());
    assert.deepEqual(ids(searchNav(all, '', text).groups), [...SETTINGS_SECTION_IDS]);
    assert.deepEqual(ids(searchNav(all, '   ', text).groups), [...SETTINGS_SECTION_IDS]);
  });

  it('matches the translated label and description, ignoring case', () => {
    assert.deepEqual(ids(searchNav(buildNav(facts()), 'PRIVACY', text).groups), ['about']);
    assert.deepEqual(ids(searchNav(buildNav(facts()), 'theme', text).groups), ['display', 'map']);
  });

  it('matches registry keywords and needs every word of the query', () => {
    const search = (q: string) => ids(searchNav(buildNav(facts()), q, text).groups);
    assert.deepEqual(search('ollama'), ['ai']);
    assert.deepEqual(search('text size'), ['panels', 'display']);
    assert.deepEqual(search('backup'), ['sync']);
    assert.deepEqual(search('globe tiles'), ['map']);
    assert.deepEqual(search('stream autoplay'), ['video']);
  });

  it('drops groups left empty and keeps their headings in order', () => {
    const result = searchNav(buildNav(facts()), 'privacy', text);
    assert.deepEqual(result.groups.map((group) => group.id), ['app']);
  });

  it('counts hits so the view can say nothing matched', () => {
    assert.equal(searchNav(buildNav(facts()), 'zzz', text).hits, 0);
    assert.deepEqual(ids(searchNav(buildNav(facts()), 'zzz', text).groups), []);
    assert.equal(searchNav(buildNav(facts()), 'privacy', text).hits, 1);
  });

  it('gives every section a non-empty keyword list in the English catalogue', () => {
    for (const group of buildNav(facts())) {
      for (const row of group.rows) {
        const keywords = lookup(EN, row.keywordsKey);
        assert.ok(keywords !== null && typeof keywords === 'object', `${row.id} has keywords at ${row.keywordsKey}`);
        const words = Object.values(keywords as object);
        assert.ok(words.length > 0 && words.every((word) => typeof word === 'string' && word.trim() !== ''), `${row.id} keywords are words`);
      }
    }
  });

  it('gives every rendering of a key: the UI language, then English, lists flattened', () => {
    const fr = { settings: { keywords: { about: { 0: 'mentions légales', 1: 'confidentialité' } }, sections: { about: 'À propos' } } };
    const terms = searchTerms(translate(fr));
    assert.deepEqual(terms('settings.keywords.about'), ['mentions légales', 'confidentialité', 'terms', 'privacy', 'license', 'legal']);
    assert.deepEqual(terms('settings.sections.about'), ['À propos', 'About']);
    assert.deepEqual(terms('settings.missing'), []);
  });

  it('finds a row in another language by its translated keyword and by the English original', () => {
    const fr = { settings: { keywords: { about: { 0: 'mentions légales', 1: 'confidentialité' } } } };
    const search = (q: string) => searchNav(buildNav(facts()), q, searchTerms(translate(fr)));
    assert.deepEqual(ids(search('MENTIONS légales').groups), ['about']);
    assert.deepEqual(ids(search('legal').groups), ['about']);
    assert.equal(search('mentions').hits, 1);
  });
});
