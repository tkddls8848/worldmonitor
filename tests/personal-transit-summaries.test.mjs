import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_COLLECTORS, STANDALONE_INTERVAL_MIN } from '../scripts/personal-collect.mjs';
import { buildTransitSummaries } from '../scripts/seed-transit-summaries.mjs';

const data = JSON.parse(readFileSync(new URL('./fixtures/transit-portwatch-hormuz.json', import.meta.url)));
const now = data.hormuz_strait.fetchedAt;

test('projects observed PortWatch history without filling in live AIS counts', () => {
  const output = buildTransitSummaries({ data }, now);
  assert.deepEqual(output.histories.hormuz_strait, data.hormuz_strait.history);
  assert.deepEqual(output.summaries.hormuz_strait, {
    todayTotal: null, todayTanker: null, todayCargo: null, todayOther: null,
    wowChangePct: -40.7,
    officialLatestDate: '2026-11-15', officialLatestTotal: 2, officialAvg7d: 2.3,
    baselineAvgDaily: 87.1, baselineFrom: '2024-11-24', baselineTo: '2025-11-23',
    riskLevel: '', incidentCount7d: 0, disruptionPct: 0, riskSummary: '', riskReportAction: '',
    anomaly: { dropPct: 39, signal: false },
    dataAvailable: true,
  });
  assert.deepEqual(Object.keys(output.summaries), ['hormuz_strait']);
});

test('never republishes expired observations as current and is due every 10 minutes', () => {
  assert.throws(() => buildTransitSummaries({ data }, now + 13 * 3600_000), /No current PortWatch/);
  assert.throws(() => buildTransitSummaries(null, now), /No current PortWatch/);
  assert.ok(DEFAULT_COLLECTORS.includes('transit-summaries'));
  assert.equal(STANDALONE_INTERVAL_MIN['transit-summaries'], 10);
});
