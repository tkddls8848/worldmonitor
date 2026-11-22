import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import ucdp from '../scripts/shared/ucdp-candidate.cjs';

test('maps Candidate CSV rows including death bounds and missing coordinates', async () => {
  const csv = 'id,date_start,date_end,latitude,longitude,country,country_id,where_prec,where_coordinates,side_a,side_b,best,low,high,type_of_violence,source_original\n42,2026-10-03,2026-10-03,,,Example,999,0,,"Side, A",Side B,12,8,20,2,Report\n';
  const rows = [];
  for await (const fields of ucdp.parseCsv(Readable.from([csv]))) rows.push(fields);
  const event = ucdp.mapCandidateCsvRow(rows[0], rows[1]);
  assert.equal(event.id, '42');
  assert.equal(event.country_id, '999');
  assert.equal(event.latitude, null);
  assert.equal(event.longitude, null);
  assert.equal(event.best, 12);
  assert.equal(event.low, 8);
  assert.equal(event.high, 20);
  assert.equal(event.side_a, 'Side, A');
  assert.equal(event.type_of_violence, '2');
});

test('parses escaped quotes and quoted line breaks', async () => {
  const csv = 'text,value\n"first ""quoted""\nsecond",ok\n';
  const rows = [];
  for await (const row of ucdp.parseCsv(Readable.from([csv]))) rows.push(row);
  assert.deepEqual(rows, [['text', 'value'], ['first "quoted"\nsecond', 'ok']]);
});

test('discovers newest monthly CSV before older monthly files', () => {
  const releases = ucdp.candidateCsvVersions([
    'GEDEvent_v26_0_9.csv', 'GEDEvent_v26_0_10.csv', 'GEDEvent_v26_01_26_09.csv',
  ].join(' '));
  assert.equal(releases[0].version, '26.0.10');
  assert.ok(releases.some((release) => release.version === '26.01.26.09'));
});

test('selects CSV without a token and after authorization failures', () => {
  assert.equal(ucdp.shouldUseCandidateCsv(''), true);
  assert.equal(ucdp.shouldUseCandidateCsv('   '), true);
  assert.equal(ucdp.shouldUseCandidateCsv('token', 401), true);
  assert.equal(ucdp.shouldUseCandidateCsv('token', 403), true);
  assert.equal(ucdp.shouldUseCandidateCsv('token', 500), false);
  assert.equal(ucdp.shouldUseCandidateCsv('token'), false);
});
