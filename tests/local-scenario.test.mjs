import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runLocalScenario } from '../scripts/run-local-scenario.mjs';

test('local snapshot computes existing impact math without a network request', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Local scenarios must not fetch'); };
  try {
    const result = await runLocalScenario({
      'seed-meta:supply_chain:chokepoint-exposure': {
        manifestVersion: 1, countryIds: ['KR'], hs2Codes: ['27', '29'], fetchedAt: 1789000000000,
      },
      'supply-chain:exposure:KR:27:v1': {
        iso2: 'KR', hs2: '27', coverage: 'flow_weighted', fetchedAt: '2026-09-09T00:00:00Z',
        exposures: [{ chokepointId: 'hormuz_strait', exposureScore: 40 }],
      },
    }, 'hormuz-tanker-blockade', 'KR', 50);
    assert.equal(result.topImpactCountries[0].totalImpact, 42);
    assert.equal(result.topImpactCountries[0].partialEvidence, true);
    assert.deepEqual(result.coverage.records.map(r => r.state), ['evaluated', 'missing']);
    assert.equal(result.coverage.records[0].fetchedAt, '2026-09-09T00:00:00Z');
    assert.equal(result.coverage.status, 'partial');
    assert.equal((await runLocalScenario({}, 'hormuz-tanker-blockade')).coverage.status, 'unknown');
  } finally { globalThis.fetch = previous; }
});

test('local scenarios retain engine validation', async () => {
  await assert.rejects(runLocalScenario([], 'hormuz-tanker-blockade'), /Snapshot must/);
  await assert.rejects(runLocalScenario({}, 'unknown'), /Unknown scenario/);
  await assert.rejects(runLocalScenario({}, 'hormuz-tanker-blockade', 'KOR'), /Invalid country/);
  await assert.rejects(runLocalScenario({}, 'us-tariff-escalation-electronics', null, 50), /Invalid disruption/);
});

test('CLI writes parseable evidence and refuses to overwrite an input snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wm-local-scenario-'));
  try {
    const snapshot = join(dir, 'seeds.json');
    const output = join(dir, 'result.json');
    await writeFile(snapshot, '{}');
    const args = ['scripts/run-local-scenario.mjs', '--snapshot', snapshot,
      '--scenario', 'hormuz-tanker-blockade'];
    const run = spawnSync(process.execPath, [...args, '--output', output], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(await readFile(output, 'utf8')).coverage.status, 'unknown');
    const overwrite = spawnSync(process.execPath, [...args, '--output', snapshot], { encoding: 'utf8' });
    assert.equal(overwrite.status, 1);
    assert.equal(await readFile(snapshot, 'utf8'), '{}');
    const invalid = spawnSync(process.execPath, [...args, '--severity', ''], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /integer from 0 to 100/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
