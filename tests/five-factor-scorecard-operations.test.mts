import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __testing__ as healthTesting } from '../api/health.js';

describe('five-factor operational wiring', () => {
  it('registers canonical and seed health with coverage and freshness floors', () => {
    assert.equal(healthTesting.STANDALONE_KEYS.scorecardFiveFactor, 'scorecard:five-factor:v1');
    assert.deepEqual(healthTesting.SEED_META.scorecardFiveFactor, {
      key: 'seed-meta:scorecard:five-factor',
      maxStaleMin: 2160,
      minRecordCount: 180,
      minPoolCounts: { population: 150, food: 80, energy: 120, demographics: 150, technology: 110, defense: 30 },
      poolCountMargin: 10,
      activationKey: 'seed-activated:scorecard:five-factor',
      cutover: {
        mode: 'activation-marker',
        fromKey: null,
        issue: 6441,
        activationKey: 'seed-activated:scorecard:five-factor',
      },
    });
    const base = { status: 'OK', key: 'scorecard:five-factor:v1' };
    assert.deepEqual(healthTesting.composeScorecardReadModelStatus(base, 1), {
      ...base,
      readModelReady: true,
    });
    assert.deepEqual(healthTesting.composeScorecardReadModelStatus(base, 0), {
      ...base,
      status: 'COVERAGE_PARTIAL',
      seedStatus: 'OK',
      readModelReady: false,
    });
    assert.equal(healthTesting.composeScorecardReadModelStatus(base, null, true).status, 'REDIS_PARTIAL');
  });

  it('softens scorecard absence only before the first successful cohort', () => {
    assert.equal(healthTesting.ON_DEMAND_KEYS.has('scorecardFiveFactor'), true);
    assert.equal(
      healthTesting.ACTIVATION_MARKERS.scorecardFiveFactor,
      'seed-activated:scorecard:five-factor',
    );

    const dataKey = healthTesting.STANDALONE_KEYS.scorecardFiveFactor;
    const metaKey = healthTesting.SEED_META.scorecardFiveFactor.key;
    const base = {
      keyStrens: new Map([[dataKey, 0]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[metaKey, null]]),
      keyMetaErrors: new Map(),
      now: 1_800_000_000_000,
    };
    assert.equal(healthTesting.classifyKey(
      'scorecardFiveFactor',
      dataKey,
      { allowOnDemand: true },
      { ...base, activationStates: new Map([['scorecardFiveFactor', false]]) },
    ).status, 'EMPTY_ON_DEMAND');
    assert.equal(healthTesting.classifyKey(
      'scorecardFiveFactor',
      dataKey,
      { allowOnDemand: true },
      { ...base, activationStates: new Map([['scorecardFiveFactor', true]]) },
    ).status, 'EMPTY');
  });

  it('runs the scorecard after the reference source sections', () => {
    const bundle = readFileSync(new URL('../scripts/seed-bundle-country-reference.mjs', import.meta.url), 'utf8');
    assert.match(bundle, /label:\s*'Five-Factor-Scorecard'[^\n]*timeoutMs:\s*180_000/);
    for (const label of ['Country-Reference', 'Food-Stocks', 'Low-Carbon-Generation', 'Power-Losses']) {
      assert.ok(bundle.indexOf("label: '" + label + "'") < bundle.indexOf("label: 'Five-Factor-Scorecard'"));
    }
  });

});
