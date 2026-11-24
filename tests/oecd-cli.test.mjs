import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { cliPhase, parseCli } from '../scripts/seed-oecd-cli.mjs';

const fixture = (file) => readFileSync(new URL(`./fixtures/global-indicators/${file}`, import.meta.url), 'utf8');

test('OECD CSV yields the latest monthly levels and a dated OECD Total archive', () => {
  const { series } = parseCli(fixture('oecd-cli.csv'), fixture('oecd-total-archive.csv'));
  assert.equal(series.G20.period, '2026-10');
  assert.equal(series.G20.phase, 'downturn');
  assert.ok(Math.abs(series.G20.change + 0.05409) < 1e-7);
  assert.equal(series.US.phase, 'expansion');
  assert.equal(series.KR.phase, 'slowdown');
  assert.equal(series.CN.phase, 'downturn');
  assert.equal(series.OECD.period, '2022-11');
  assert.equal(series.OECD.archived, true);
  assert.equal(series.G4E, undefined);
});

test('CLI phase and turning rules require adjacent months and a strict slope reversal', () => {
  assert.deepEqual([cliPhase(101, 1), cliPhase(101, -1), cliPhase(99, -1), cliPhase(99, 1)],
    ['expansion', 'slowdown', 'downturn', 'recovery']);
  const csv = 'REF_AREA,TIME_PERIOD,OBS_VALUE,ADJUSTMENT\nG20,2026-01,99,AA\nG20,2026-02,101,AA\nG20,2026-03,100,AA\n';
  assert.equal(parseCli(csv).series.G20.turningPoint, 'peak');
  assert.equal(parseCli(csv.replace('2026-01,99', '2026-01,102').replace('2026-03,100', '2026-03,103')).series.G20.turningPoint, 'trough');
  assert.equal(parseCli(csv.replace('2026-01', '2025-12')).series.G20.turningPoint, null);
  assert.throws(() => parseCli(csv.replace('2026-02', '2025-02')), /consecutive/);
});
