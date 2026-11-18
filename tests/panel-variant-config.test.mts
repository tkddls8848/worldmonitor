import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getEffectivePanelConfig,
  restoreProGatedPanels,
  userSetPanelEnabled,
} from '../src/config/panels.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function src(relPath: string): string {
  return readFileSync(resolve(root, relPath), 'utf-8');
}

describe('variant panel config resolution', () => {
  it('prefers the happy variant config over a duplicate full panel key', () => {
    const giving = getEffectivePanelConfig('giving', 'happy');

    assert.equal(giving.name, 'Global Giving');
    assert.equal(giving.enabled, true);
    assert.equal(giving.priority, 1);
  });

  it('preserves commodity and energy labels for shared supply-chain panels', () => {
    assert.equal(
      getEffectivePanelConfig('supply-chain', 'commodity').name,
      'Supply Chain & Logistics',
    );
    assert.equal(
      getEffectivePanelConfig('supply-chain', 'energy').name,
      'Chokepoints & Routes',
    );
  });

  it('still falls back to the cross-variant registry for panels outside a variant default set', () => {
    const forecast = getEffectivePanelConfig('forecast', 'happy');

    assert.equal(forecast.name, 'AI Forecasts');
    assert.equal(forecast.enabled, true);
  });

  it('applies variant overrides on top of the variant-specific base config', () => {
    const financeMap = getEffectivePanelConfig('map', 'finance');

    assert.equal(financeMap.name, 'Global Markets Map');
    assert.equal(financeMap.enabled, true);
    assert.equal(financeMap.priority, 1);
  });

  it('a user toggle takes ownership: a later deliberate hide survives going Pro', () => {
    // The marker means "the GATE owns this disable". If it survives a USER
    // re-enable, a later deliberate hide is indistinguishable from gate damage
    // and the next Pro reconcile resurrects a panel the user chose to hide —
    // then cloud-syncs that resurrection to every device.
    //
    // The over-cap fixture above hides its panel BEFORE the clamp, so the
    // marker is never set on it. This covers the real sequence: clamp, user
    // re-enables, user later hides.
    // A panel the retired free-tier clamp disabled, as stored by an older build.
    const clampedKey = 'q40';
    const clamped: Record<string, { name: string; enabled: boolean; priority: number; proGated?: boolean }> = {
      [clampedKey]: { name: clampedKey, enabled: false, priority: 1, proGated: true },
    };

    // 1. User re-enables it themselves (Cmd+K, settings toggle, undo-close).
    userSetPanelEnabled(clamped[clampedKey]!, true);
    assert.equal(clamped[clampedKey]?.proGated, undefined,
      'a user toggle transfers ownership away from the gate — the marker must go');

    // 2. Later, the user deliberately hides it.
    userSetPanelEnabled(clamped[clampedKey]!, false);

    // 3. Going Pro must NOT resurrect it.
    assert.equal(restoreProGatedPanels(clamped)[clampedKey]?.enabled, false,
      'a panel the user hid after re-enabling it must stay hidden');
  });

  it('standalone settings render uses resolved variant names instead of saved panel names', () => {
    const text = src('src/settings-window.ts');

    assert.match(
      text,
      /const resolvedPanel = ALL_PANELS\[key\] \? getEffectivePanelConfig\(key, SITE_VARIANT\) : panel;/,
      'settings-window render must resolve variant-specific panel config per entry',
    );
    assert.match(
      text,
      /getPanelDisplayName\(key, resolvedPanel\.name \?\? panel\.name\)/,
      'settings-window render must prefer the resolved variant name before saved panel.name',
    );
  });
});
