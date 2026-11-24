import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseCofer } from '../scripts/seed-imf-cofer.mjs';

const xml = readFileSync(new URL('./fixtures/global-indicators/cofer.xml', import.meta.url), 'utf8');

test('COFER SDMX supplies raw world USD totals, currency shares and exact quarter YoY', () => {
  const { latest, history } = parseCofer(xml);
  assert.equal(history.length, 2);
  assert.equal(latest.period, '2026-Q2');
  assert.equal(latest.totalUsd, 13_216_790_400_307.2);
  assert.ok(Math.abs(latest.shares.USD - 56.70476) < 1e-5);
  assert.ok(Math.abs(latest.usdYoyPp - (-0.24058)) < 1e-5);
  assert.ok(Math.abs(Object.values(latest.shares).reduce((a, b) => a + b) - 100) < 1e-4);
  assert.equal(latest.shares.unallocated, 0);
  assert.equal(latest.imputedShare, 10.58);
  assert.equal(parseCofer(xml.replaceAll('2025-Q2', '2025-Q1')).latest.usdYoyPp, null);
  assert.throws(() => parseCofer(xml.replaceAll('G001', 'OTHER')), /no world totals/);
});
