import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateFlows, calculateChange7d, convertKwhDayToGwhDay, selectPoints } from '../scripts/seed-eu-gas-flows.mjs';

const metadata = [
  { operatorKey: 'BG-TSO-0001', pointKey: 'ITP-1', adjacentCountry: 'TR', tSOCountry: 'BG', directionKey: 'entry', pointType: 'Cross-Border Transmission IP between EU and Non-EU (import)' },
  { operatorKey: 'BE-TSO-0001', pointKey: 'LNG-1', adjacentCountry: null, tSOCountry: 'BE', directionKey: 'entry', pointType: 'LNG Entry point' },
  { operatorKey: 'GB-TSO-0001', pointKey: 'LNG-2', tSOCountry: 'GB', directionKey: 'entry', pointType: 'LNG Entry point' },
];
describe('EU gas flows', () => {
  it('converts kWh/d to GWh/d', () => assert.equal(convertKwhDayToGwhDay(1234567), 1.234567));
  it('selects EU LNG entries and excludes non-EU points', () => {
    const groups = selectPoints(metadata);
    assert.equal(groups.lng.has('BE-TSO-0001|LNG-1'), true);
    assert.equal(groups.lng.has('GB-TSO-0001|LNG-2'), false);
  });
  it('groups configured origins, fills missing dates with zero and computes 7-day change', () => {
    const points = [{ ...metadata[1], pointKey: 'LNG-1' }, { ...metadata[0], adjacentCountry: 'RU', pointKey: 'RU-1' }];
    const rows = [
      { indicator: 'Physical Flow', directionKey: 'entry', operatorKey: 'BE-TSO-0001', pointKey: 'LNG-1', periodFrom: '2026-11-08T06:00:00+01:00', value: 10_000_000 },
      { indicator: 'Physical Flow', directionKey: 'entry', operatorKey: 'BG-TSO-0001', pointKey: 'RU-1', periodFrom: '2026-11-15T06:00:00+01:00', value: 20_000_000 },
    ];
    const result = aggregateFlows(rows, points, '2026-11-21');
    assert.equal(result.lng.series.length, 14);
    assert.equal(result.lng.series[0].gwhPerDay, 10);
    assert.equal(result.lng.series.at(-1).gwhPerDay, 0);
    assert.equal(result.russia.series[7].gwhPerDay, 20);
    assert.equal(calculateChange7d([{ date: '2026-11-14', gwhPerDay: 10 }, { date: '2026-11-21', gwhPerDay: 15 }]), 50);
    assert.equal(result.russia.change7dPct, null);
  });
});
