import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as XLSX from '@e965/xlsx';
import { parseGpr } from '../scripts/seed-gpr.mjs';

const fixture = (file) => readFileSync(new URL(`./fixtures/global-indicators/${file}`, import.meta.url));

test('GPR workbooks yield UTC dates, rolling global risk and ISO2 country values', () => {
  const { latest, daily, countries } = parseGpr(fixture('gpr-daily.xls'), fixture('gpr-monthly.xls'));
  assert.equal(daily.length, 420);
  assert.equal(latest.date, '2026-11-23');
  assert.ok(Math.abs(latest.average30d - 143.59908) < 1e-4);
  assert.ok(Math.abs(latest.normal - 176.73001) < 1e-4);
  assert.equal(latest.dailySpike, false);
  assert.equal(latest.sustainedSpike, false);
  assert.equal(Object.keys(countries).length, 44);
  assert.equal(countries.US.period, '2026-10');
  assert.ok(Math.abs(countries.US.value - 3.76223) < 1e-4);
});

test('a high enough daily observation exceeds both thresholds without entering its own baseline', () => {
  const daily = XLSX.read(fixture('gpr-daily.xls'));
  const sheet = daily.Sheets.Sheet1;
  const cell = XLSX.utils.encode_cell({ r: XLSX.utils.decode_range(sheet['!ref']).e.r, c: 1 });
  sheet[cell] = { t: 'n', v: 6000 };
  const high = XLSX.write(daily, { type: 'buffer', bookType: 'biff8' });
  const { latest, spikes } = parseGpr(high, fixture('gpr-monthly.xls'));
  assert.ok(latest.dailySpike && latest.sustainedSpike);
  assert.ok(Math.abs(latest.normal - 176.73001) < 1e-4);
  assert.deepEqual(spikes.at(-1), latest);
});
