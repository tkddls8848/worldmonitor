import test from 'node:test';
import assert from 'node:assert/strict';
import { mapIodaEvents, severityForScore } from '../scripts/seed-ioda-outages.mjs';

test('IODA outage mapping resolves country codes/names, score bands, ordering and cap', () => {
  assert.equal(severityForScore(999), 'low');
  assert.equal(severityForScore(1000), 'medium');
  assert.equal(severityForScore(100000), 'high');
  const rows = [
    { entityType: 'country', entityCode: 'USA', location_name: 'United States', from: 200, until: 240, score: 1000, datasource: 'bgp' },
    { entityType: 'country', entityCode: 'Iran', location_name: 'Iran', from: 300, until: 0, score: 100000, datasource: 'gtr' },
    { entityType: 'asn', entityCode: '123', from: 999, score: 9 },
  ];
  const mapped = mapIodaEvents(rows, 100_000, 500_000);
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].iso2, 'IR');
  assert.equal(mapped.at(-1).iso2, 'US');
  assert.equal(mapped.at(-1).countryName, 'United States');
  assert.equal(mapped.at(-1).end, 240_000);
  assert.equal(mapped.at(-1).severity, 'medium');
  assert.equal(mapped.find((x) => x.iso2 === 'IR').end, null);
  assert.equal(mapped.find((x) => x.iso2 === 'IR').severity, 'high');
  const many = mapIodaEvents(Array.from({ length: 105 }, (_, i) => ({
    entityType: 'country', entityCode: 'KR', from: 400 + i, score: 10, datasource: `source-${i}`,
  })), 100_000, 500_000);
  assert.equal(many.length, 100);
  assert.equal(many[0].start, 504_000);
  assert.equal(many.at(-1).start, 405_000);
});
