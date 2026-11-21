import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  INSPECTOR_TABS,
  OVERVIEW_DEFAULT_PANELS,
  getInspectorTabForPanel,
  getOverviewPanelKeys,
  isPanelVisibleInInspectorTab,
} from '../src/config/inspector-domains.ts';
import { ALL_PANELS, VARIANT_DEFAULTS } from '../src/config/panels.ts';
import { MAP_LAYER_GROUPS, MAP_LAYER_PRESETS } from '../src/config/map-layer-definitions.ts';
import type { PanelConfig } from '../src/types/index.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function makeSettings(enabledKeys: string[], disabledKeys: string[] = []): Record<string, PanelConfig> {
  const out: Record<string, PanelConfig> = {};
  for (const key of enabledKeys) {
    out[key] = { name: ALL_PANELS[key]?.name ?? key, enabled: true, priority: 1 };
  }
  for (const key of disabledKeys) {
    out[key] = { name: ALL_PANELS[key]?.name ?? key, enabled: false, priority: 3 };
  }
  return out;
}

describe('inspector-domains mapping and filtering', () => {
  it('exposes the 5 Option B tabs in order', () => {
    assert.deepEqual(INSPECTOR_TABS.map((t) => t.id), ['overview', 'security', 'markets', 'news', 'all']);
  });

  it('maps every enabled panel of every variant to a concrete non-all domain tab', () => {
    for (const [variant, keys] of Object.entries(VARIANT_DEFAULTS)) {
      const orphaned: string[] = [];
      for (const key of keys) {
        if (key === 'map') continue;
        const tab = getInspectorTabForPanel(key, variant);
        if (tab === 'all') {
          orphaned.push(`${variant}:${key}`);
        }
      }
      assert.deepEqual(orphaned, [], `Orphaned enabled panels in variant "${variant}": ${orphaned.join(', ')}`);
    }
  });

  it('resolves getOverviewPanelKeys with defaults, custom pins, disabled filtering, and fallback', () => {
    const fullSettings = makeSettings(
      (VARIANT_DEFAULTS.full ?? []).filter((k) => k !== 'map'),
    );

    // Default curated 7 (insights first, matching approved Option B spec)
    assert.deepEqual(
      getOverviewPanelKeys('full', fullSettings, null),
      ['insights', 'strategic-risk', 'cii', 'threat-timeline', 'markets', 'energy-complex', 'latest-brief'],
    );

    // Custom pins drop disabled, unknown, and map entries
    const customSettings = makeSettings(['politics', 'markets'], ['cii']);
    assert.deepEqual(
      getOverviewPanelKeys('full', customSettings, ['map', 'cii', 'unknown-panel', 'politics', 'markets']),
      ['politics', 'markets'],
    );

    // When all custom pins are disabled or unknown, fall back to enabled defaults (matching boot filter)
    assert.deepEqual(
      getOverviewPanelKeys('full', customSettings, ['cii', 'unknown-panel']),
      ['markets'],
    );

    // Corrupt/empty pins fall back to enabled defaults
    assert.deepEqual(
      getOverviewPanelKeys('full', customSettings, []),
      ['markets'],
    );

    // When all curated defaults are disabled, falls back to first enabled panels
    const onlyOther = makeSettings(['politics', 'us', 'europe'], ['insights', 'strategic-risk', 'cii', 'threat-timeline', 'markets', 'energy-complex', 'latest-brief']);
    assert.deepEqual(
      getOverviewPanelKeys('full', onlyOther, null),
      ['politics', 'us', 'europe'],
    );
  });

  it('filters panels accurately across tabs and Markets/News sub-filters', () => {
    const settings = makeSettings([
      'insights', 'cii', 'gdelt-intel', 'markets', 'energy-complex', 'supply-chain', 'crypto',
      'politics', 'ai', 'live-news', 'displacement', 'monitors',
    ]);

    // Overview shows curated defaults only
    assert.equal(isPanelVisibleInInspectorTab('insights', 'overview', { variant: 'full', panelSettings: settings }), true);
    assert.equal(isPanelVisibleInInspectorTab('gdelt-intel', 'overview', { variant: 'full', panelSettings: settings }), false);
    assert.equal(isPanelVisibleInInspectorTab('live-news', 'overview', { variant: 'full', panelSettings: settings }), false);

    // Security tab
    assert.equal(isPanelVisibleInInspectorTab('gdelt-intel', 'security', { variant: 'full', panelSettings: settings }), true);
    assert.equal(isPanelVisibleInInspectorTab('cii', 'security', { variant: 'full', panelSettings: settings }), true);
    assert.equal(isPanelVisibleInInspectorTab('markets', 'security', { variant: 'full', panelSettings: settings }), false);

    // Markets sub-filters
    assert.equal(isPanelVisibleInInspectorTab('markets', 'markets', { variant: 'full', panelSettings: settings, marketsSubFilter: 'equities' }), true);
    assert.equal(isPanelVisibleInInspectorTab('energy-complex', 'markets', { variant: 'full', panelSettings: settings, marketsSubFilter: 'energy' }), true);
    assert.equal(isPanelVisibleInInspectorTab('energy-complex', 'markets', { variant: 'full', panelSettings: settings, marketsSubFilter: 'crypto' }), false);
    assert.equal(isPanelVisibleInInspectorTab('supply-chain', 'markets', { variant: 'full', panelSettings: settings, marketsSubFilter: 'supply' }), true);
    assert.equal(isPanelVisibleInInspectorTab('crypto', 'markets', { variant: 'full', panelSettings: settings, marketsSubFilter: 'crypto' }), true);

    // News sub-filters
    assert.equal(isPanelVisibleInInspectorTab('politics', 'news', { variant: 'full', panelSettings: settings, newsSubFilter: 'regional' }), true);
    assert.equal(isPanelVisibleInInspectorTab('ai', 'news', { variant: 'full', panelSettings: settings, newsSubFilter: 'topical' }), true);
    assert.equal(isPanelVisibleInInspectorTab('displacement', 'news', { variant: 'full', panelSettings: settings, newsSubFilter: 'tracking' }), true);
    assert.equal(isPanelVisibleInInspectorTab('live-news', 'news', { variant: 'full', panelSettings: settings, newsSubFilter: 'all' }), true);

    // All tab shows every enabled panel
    for (const key of Object.keys(settings)) {
      assert.equal(isPanelVisibleInInspectorTab(key, 'all', { variant: 'full', panelSettings: settings }), true);
    }
  });

  it('keeps panel-layout INITIAL_OVERVIEW_PANELS in sync with OVERVIEW_DEFAULT_PANELS', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'app', 'panel-layout.ts'), 'utf8');
    const match = src.match(/const INITIAL_OVERVIEW_PANELS:\s*Readonly<Record<string,\s*readonly string\[\]>>\s*=\s*(\{[\s\S]*?\});/);
    assert.ok(match, 'INITIAL_OVERVIEW_PANELS mirror must exist in panel-layout.ts');
    const mirrored = new Function(`return (${match[1]});`)() as Record<string, string[]>;
    assert.deepEqual(mirrored, OVERVIEW_DEFAULT_PANELS);
  });

  it('defines 6 layer groups and 5 layer presets including Clear', () => {
    assert.equal(MAP_LAYER_GROUPS.length, 6);
    assert.equal(MAP_LAYER_PRESETS.length, 5);
    const clear = MAP_LAYER_PRESETS.find((p) => p.id === 'clear');
    assert.ok(clear, 'clear layer preset must exist');
    assert.deepEqual(clear!.layers, []);
  });
});
