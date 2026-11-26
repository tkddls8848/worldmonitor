import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectTrafficAnomaly, THREAT_LEVEL } from '../server/worldmonitor/supply-chain/v1/_scoring.mjs';
import { summarizePortwatchHistory } from '../shared/chokepoint-traffic-anomaly.js';
import {
  CANONICAL_CHOKEPOINTS,
  corridorRiskNameToId,
} from '../server/worldmonitor/supply-chain/v1/_chokepoint-ids.ts';
import { CHOKEPOINTS } from '../server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts';
import { CHOKEPOINT_THREAT_LEVELS } from '../shared/chokepoint-threat-levels.js';
import { readTransitWindow } from '../shared/chokepoint-transit-window.js';

function transitStore() {
  const rows = new Map();
  return async (_script, _keys, [now, window, _ttl, batch]) => {
    for (const event of JSON.parse(batch)) rows.set(JSON.stringify(event), event[3]);
    return [...rows].filter(([, ts]) => ts > now - window && ts <= now)
      .sort((a, b) => a[1] - b[1]).map(([member]) => member);
  };
}
import { CORRIDOR_RISK_NAME_MAP, deriveCorridorRiskLevel } from '../shared/corridor-risk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const relaySrc = readFileSync(resolve(root, 'scripts/personal-providers.cjs'), 'utf-8') + '\n' + readFileSync(resolve(root, 'scripts/personal-collector-tasks.cjs'), 'utf-8');
const handlerSrc = readFileSync(resolve(root, 'server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts'), 'utf-8');

function makeDays(count, dailyTotal, startOffset) {
  const days = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.now() - (startOffset + i) * 86400000);
    days.push({
      date: d.toISOString().slice(0, 10),
      tanker: 0,
      cargo: dailyTotal,
      other: 0,
      total: dailyTotal,
    });
  }
  return days;
}

// ---------------------------------------------------------------------------
// 2. CORRIDOR_RISK_NAME_MAP and seedCorridorRisk
// ---------------------------------------------------------------------------
describe('corridor risk feed adaptation', () => {
  // The relay, this suite, and the panel all read the same module now. The
  // banding used to be re-implemented inside the test and the name map pinned
  // entry-by-entry with regexes over relay source; neither could fail when the
  // relay changed.
  it('bands scores lower-inclusive so a boundary score never rounds down', () => {
    assert.equal(deriveCorridorRiskLevel(70), 'critical');
    assert.equal(deriveCorridorRiskLevel(69), 'high');
    assert.equal(deriveCorridorRiskLevel(50), 'high');
    assert.equal(deriveCorridorRiskLevel(49), 'elevated');
    assert.equal(deriveCorridorRiskLevel(30), 'elevated');
    assert.equal(deriveCorridorRiskLevel(29), 'normal');
  });

  it('bands the full score range', () => {
    assert.equal(deriveCorridorRiskLevel(100), 'critical');
    assert.equal(deriveCorridorRiskLevel(0), 'normal');
  });

  it('maps every corridor pattern onto a canonical chokepoint id', () => {
    const canonicalIds = new Set(CANONICAL_CHOKEPOINTS.map((c) => c.id));
    for (const { pattern, id } of CORRIDOR_RISK_NAME_MAP) {
      assert.ok(canonicalIds.has(id), `${pattern} maps to non-canonical id ${id}`);
    }
  });

  it('matches corridor names as lowercase substrings, first entry winning', () => {
    // Mirrors the relay's lookup so the ordering contract is exercised rather
    // than assumed: 'Red Sea / Bab-el-Mandeb' must resolve once, not twice.
    const resolve = (name) =>
      CORRIDOR_RISK_NAME_MAP.find((m) => name.toLowerCase().includes(m.pattern))?.id;

    assert.equal(resolve('Strait of Hormuz'), 'hormuz_strait');
    assert.equal(resolve('Bab-el-Mandeb Strait'), 'bab_el_mandeb');
    assert.equal(resolve('Red Sea Corridor'), 'bab_el_mandeb');
    assert.equal(resolve('Suez Canal'), 'suez');
    assert.equal(resolve('South China Sea'), 'taiwan_strait');
    assert.equal(resolve('Black Sea'), 'bosphorus');
    assert.equal(resolve('Panama Canal'), undefined, 'unmapped corridors must not resolve');
  });

  it('keeps every pattern lowercase, or the substring match can never fire', () => {
    for (const { pattern } of CORRIDOR_RISK_NAME_MAP) {
      assert.equal(pattern, pattern.toLowerCase());
    }
  });
});


describe('corridorRiskNameToId', () => {
  it('resolves every chokepoint that declares a CorridorRisk name', () => {
    for (const cp of CANONICAL_CHOKEPOINTS.filter((c) => c.corridorRiskName !== null)) {
      assert.equal(corridorRiskNameToId(cp.corridorRiskName), cp.id);
    }
  });
});

// ---------------------------------------------------------------------------
// detectTrafficAnomaly (shared/chokepoint-traffic-anomaly.js) edge cases.
// The relay and the RPC handler both call this exact function now, so there is
// no second implementation left to hold in sync.
// ---------------------------------------------------------------------------

describe('summarizePortwatchHistory (shared/chokepoint-traffic-anomaly.js)', () => {
  const baseline = { avgDaily: 87.42, days: 365, from: '2024-10-22', to: '2025-10-21' };
  const tail = [3, 7, 3, 2, 7, 0, 4].map((total, index) => ({ date: `2026-10-${12 + index}`, total }));

  it('reports the latest published day, the 7-day mean and the baseline to one decimal', () => {
    assert.deepEqual(summarizePortwatchHistory([...tail].reverse(), baseline), {
      latestDate: '2026-10-18', latestTotal: 4, avg7d: 3.7,
      baselineAvgDaily: 87.4, baselineFrom: '2024-10-22', baselineTo: '2025-10-21',
    });
  });

  it('publishes a measured zero on the latest day', () => {
    const summary = summarizePortwatchHistory([...tail, { date: '2026-10-19', total: 0 }], baseline);
    assert.equal(summary.latestDate, '2026-10-19');
    assert.equal(summary.latestTotal, 0);
  });

  it('withholds the 7-day mean below seven published days and everything without history', () => {
    const sixDays = summarizePortwatchHistory(tail.slice(0, 6), baseline);
    assert.equal(sixDays.avg7d, null);
    assert.equal(sixDays.latestDate, '2026-10-17');
    assert.equal(sixDays.latestTotal, 0, 'the latest day still publishes, and a measured 0 is a value');
    const empty = { latestDate: null, latestTotal: null, avg7d: null, baselineAvgDaily: null, baselineFrom: null, baselineTo: null };
    assert.deepEqual(summarizePortwatchHistory([], null), empty);
    assert.deepEqual(summarizePortwatchHistory(undefined, undefined), empty);
  });

  it('drops a baseline missing any part and ignores malformed days', () => {
    for (const broken of [null, {}, { avgDaily: 87.4 }, { avgDaily: 'x', from: '2024-10-22', to: '2025-10-21' }, { avgDaily: 87.4, from: '2024-10-22', to: 'last year' }, { avgDaily: -1, from: '2024-10-22', to: '2025-10-21' }]) {
      const summary = summarizePortwatchHistory(tail, broken);
      assert.equal(summary.baselineAvgDaily, null, JSON.stringify(broken));
      assert.equal(summary.baselineFrom, null);
      assert.equal(summary.baselineTo, null);
      assert.equal(summary.latestTotal, 4, 'the history still publishes');
    }
    const summary = summarizePortwatchHistory([...tail, { date: '2026-10-19', total: 'n/a' }, { date: 'yesterday', total: 9 }, { total: 5 }], baseline);
    assert.equal(summary.latestDate, '2026-10-18');
  });
});

describe('detectTrafficAnomaly edge cases (_scoring.mjs)', () => {
  it('null history returns no signal', () => {
    const result = detectTrafficAnomaly(null, 'war_zone');
    assert.deepEqual(result, { dropPct: 0, signal: false });
  });

  it('empty array returns no signal', () => {
    const result = detectTrafficAnomaly([], 'war_zone');
    assert.deepEqual(result, { dropPct: 0, signal: false });
  });

  it('exactly 37 days is sufficient', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    assert.equal(history.length, 37);
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.signal, 'should detect anomaly with exactly 37 days');
    assert.ok(result.dropPct >= 90);
  });

  it('36 days is insufficient', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(29, 100, 7)];
    assert.equal(history.length, 36);
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.equal(result.signal, false);
    assert.equal(result.dropPct, 0);
  });

  it('equal traffic recent vs baseline yields dropPct 0, no signal', () => {
    const history = [...makeDays(7, 100, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.equal(result.dropPct, 0);
    assert.equal(result.signal, false);
  });

  it('increased traffic yields negative dropPct, no signal', () => {
    const history = [...makeDays(7, 200, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.dropPct < 0, `expected negative dropPct, got ${result.dropPct}`);
    assert.equal(result.signal, false);
  });

  it('exactly 50% drop in war_zone triggers signal', () => {
    const history = [...makeDays(7, 50, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.equal(result.dropPct, 50);
    assert.equal(result.signal, true);
  });

  it('49% drop in war_zone does NOT trigger signal', () => {
    const history = [...makeDays(7, 51, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.dropPct < 50);
    assert.equal(result.signal, false);
  });

  it('elevated threat level does not trigger signal even with large drop', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'elevated');
    assert.equal(result.signal, false);
    assert.ok(result.dropPct >= 90);
  });

  it('high threat level does not trigger signal even with large drop', () => {
    const history = [...makeDays(7, 5, 0), ...makeDays(30, 100, 7)];
    const result = detectTrafficAnomaly(history, 'high');
    assert.equal(result.signal, false);
  });

  it('unsorted history is handled correctly (sorted internally)', () => {
    const history = [...makeDays(30, 100, 7), ...makeDays(7, 5, 0)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.signal);
    assert.ok(result.dropPct >= 90);
  });

  it('baseline < 2 vessels/day avg (< 14 total over 7 days) returns no signal', () => {
    // baseline30 of 1/day -> baselineAvg7 = (30*1/30)*7 = 7 < 14
    const history = [...makeDays(7, 0, 0), ...makeDays(30, 1, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.equal(result.signal, false);
    assert.equal(result.dropPct, 0);
  });

  it('baseline of exactly 2 vessels/day (14/week) is accepted', () => {
    const history = [...makeDays(7, 0, 0), ...makeDays(30, 2, 7)];
    const result = detectTrafficAnomaly(history, 'war_zone');
    assert.ok(result.dropPct > 0, 'should compute dropPct when baseline is 14/week');
  });
});

// ---------------------------------------------------------------------------
// 7. CHOKEPOINT_THREAT_LEVELS sync between relay and handler
// ---------------------------------------------------------------------------
// Threat-level parity between shared/chokepoint-threat-levels.js and the
// handler's CHOKEPOINTS config is asserted in tests/chokepoint-id-mapping.test.mjs,
// which owns the canonical-registry contracts.

describe('handler transit data strategy', () => {
  it('reads only the compact summary key and makes no upstream call', () => {
    // Each removed fallback was a ~500KB secondary read stacked on the 1.5s
    // Redis budget, which is what made this handler time out. Absence is the
    // contract, and absence is the one thing no executable test can observe.
    assert.match(handlerSrc, /TRANSIT_SUMMARIES_KEY/);
    assert.doesNotMatch(
      handlerSrc,
      /PORTWATCH_FALLBACK_KEY|CORRIDORRISK_FALLBACK_KEY|TRANSIT_COUNTS_FALLBACK_KEY|buildFallbackSummaries/,
    );
    assert.doesNotMatch(handlerSrc, /getPortWatchTransits|fetchCorridorRisk/);
  });
});

// ---------------------------------------------------------------------------
// envelopeRead helper — runtime behavior (regression guard for PR #3097 drift)
// ---------------------------------------------------------------------------
describe('envelopeRead helper', () => {
  // Extract and eval the helper — it is pure aside from upstashGet, which we stub.
  const helpers = readFileSync(resolve(root, 'scripts/_personal-provider-helpers.cjs'), 'utf8');
  const helperSrc = helpers.match(/async function envelopeRead\([\s\S]*?\n  \}/)?.[0];

  it('is defined next to envelopeWrite in the shared provider helpers', () => {
    assert.ok(helperSrc, 'envelopeRead not found in the shared provider helpers');
  });

  function buildEnvelopeRead(stub) {
    // eslint-disable-next-line no-new-func
    return new Function('upstashGet', `${helperSrc}\nreturn envelopeRead;`)(stub);
  }

  it('unwraps contract-mode envelope {_seed, data} -> data', async () => {
    const stub = async () => ({ _seed: { fetchedAt: 1 }, data: { hormuz_strait: { history: [1, 2, 3] } } });
    const read = buildEnvelopeRead(stub);
    const out = await read('supply_chain:portwatch:v1');
    assert.deepEqual(out, { hormuz_strait: { history: [1, 2, 3] } });
  });

  it('passes legacy raw shape through unchanged', async () => {
    const stub = async () => ({ hormuz_strait: { history: [1] }, suez: { history: [] } });
    const read = buildEnvelopeRead(stub);
    const out = await read('legacy:key');
    assert.deepEqual(out, { hormuz_strait: { history: [1] }, suez: { history: [] } });
  });

  it('returns null when Redis returns null', async () => {
    const stub = async () => null;
    const read = buildEnvelopeRead(stub);
    assert.equal(await read('missing:key'), null);
  });

  it('does NOT unwrap arrays that happen to have _seed/data indices', async () => {
    const stub = async () => [1, 2, 3];
    const read = buildEnvelopeRead(stub);
    assert.deepEqual(await read('array:key'), [1, 2, 3]);
  });
});
