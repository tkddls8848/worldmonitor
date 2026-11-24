import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as XLSX from '@e965/xlsx';
import { findPinkSheetWorkbook, parsePinkSheet } from '../scripts/seed-pink-sheet.mjs';

const fixture = (file) => readFileSync(new URL(`./fixtures/global-indicators/${file}`, import.meta.url));

test('World Bank page and workbook yield seven indices with adjacent and year-ago comparisons', () => {
  assert.match(findPinkSheetWorkbook(fixture('pink-sheet-link.html').toString()), /^https:\/\/thedocs\.worldbank\.org\/.*Monthly\.xlsx$/);
  assert.throws(() => findPinkSheetWorkbook(fixture('pink-sheet-link.html').toString().replace('worldbank.org', 'other.example')), /no monthly workbook/);
  const { latest, history } = parsePinkSheet(fixture('pink-sheet.xlsx'));
  assert.equal(history.length, 20);
  assert.equal(latest.period, '2026-10');
  assert.equal(Object.keys(latest.indices).length, 7);
  assert.equal(latest.indices.energy.value, 159.6);
  assert.ok(Math.abs(latest.indices.energy.momPct - 7.11409) < 1e-5);
  assert.ok(Math.abs(latest.indices.food.yoyPct - 14.67545) < 1e-5);
});

test('Pink Sheet spikes require a move strictly greater than 10 percent', () => {
  const book = XLSX.read(fixture('pink-sheet.xlsx'));
  const sheet = book.Sheets['Monthly Indices'];
  const lastRow = XLSX.utils.decode_range(sheet['!ref']).e.r;
  const changeEnergy = (row, value) => { sheet[XLSX.utils.encode_cell({ r: row, c: 2 })] = { t: 'n', v: value }; };
  changeEnergy(lastRow - 1, 100);
  for (const [value, flag] of [[110, false], [111, true], [89, true]]) {
    changeEnergy(lastRow, value);
    const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    assert.equal(parsePinkSheet(bytes).spikes.some(({ period, key }) => period === '2026-10' && key === 'energy'), flag);
  }
});
