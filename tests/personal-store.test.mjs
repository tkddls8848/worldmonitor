import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openPersonalStore } from '../shared/personal-store.mjs';

async function database(t) {
  const dir = await mkdtemp(join(tmpdir(), 'wm-personal-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'personal.sqlite');
}

test('TTL preserves last-good evidence and first-writer-wins works across connections', async t => {
  const path = await database(t);
  let time = 1000;
  const a = openPersonalStore(path, { now: () => time });
  const b = openPersonalStore(path, { now: () => time });
  try {
    assert.equal(a.setIfAbsent('key', { count: 0 }, 1), true);
    assert.equal(b.setIfAbsent('key', { count: 99 }), false);
    assert.deepEqual(b.getMany(['missing', 'key']), [null, { count: 0 }]);
    time = 2000;
    assert.equal(a.get('key'), null);
    assert.deepEqual(a.getRecord('key'), { value: { count: 0 }, storedAt: 1000, expiresAt: 2000, expired: true });
    assert.throws(() => a.set('key', undefined), /JSON serializable/);
    assert.throws(() => a.set('key', 1, 0), /TTL/);
    assert.equal(a.getRecord('key').storedAt, 1000);
    assert.equal(b.setIfAbsent('key', { count: 2 }), true);
    assert.equal(a.delete('key'), true);
    assert.equal(b.get('key'), null);
  } finally { a.close(); b.close(); }
});

test('failed metadata publication rolls back data and preserves observation dates', async t => {
  const path = await database(t);
  const store = openPersonalStore(path);
  const db = new DatabaseSync(path);
  try {
    store.atomicPublish({ key: 'dataset', value: { observedAt: '2026-01-01' }, metadata: { fetchedAt: 123 } });
    db.exec("CREATE TRIGGER reject_meta BEFORE UPDATE ON personal_values WHEN NEW.key = 'seed-meta:dataset' BEGIN SELECT RAISE(ABORT, 'metadata failure'); END;");
    assert.throws(() => store.atomicPublish({ key: 'dataset', value: { observedAt: '2026-02-01' }, metadata: { fetchedAt: 456 } }), /metadata failure/);
    assert.deepEqual(store.get('dataset'), { observedAt: '2026-01-01' });
    assert.deepEqual(store.get('seed-meta:dataset'), { fetchedAt: 123 });
  } finally { db.close(); store.close(); }
});

test('scenario CLI reads persistent SQLite after writer exits without changing source dates', async t => {
  const path = await database(t);
  const moduleUrl = new URL('../shared/personal-store.mjs', import.meta.url).href;
  const script = `import {openPersonalStore} from ${JSON.stringify(moduleUrl)};
    const s=openPersonalStore(process.argv[1]);
    s.set('seed-meta:supply_chain:chokepoint-exposure',{manifestVersion:1,countryIds:['KR'],hs2Codes:['27','29'],fetchedAt:1789000000000});
    s.set('supply-chain:exposure:KR:27:v1',{iso2:'KR',hs2:'27',coverage:'flow_weighted',fetchedAt:'2026-09-09T00:00:00Z',exposures:[{chokepointId:'hormuz_strait',exposureScore:40}]});s.close();`;
  const writer = spawnSync(process.execPath, ['--input-type=module', '-e', script, path], { encoding: 'utf8' });
  assert.equal(writer.status, 0, writer.stderr);
  const result = spawnSync(process.execPath, ['scripts/run-local-scenario.mjs', '--database', path, '--scenario', 'hormuz-tanker-blockade', '--country', 'KR', '--severity', '50'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.topImpactCountries[0].totalImpact, 42);
  assert.deepEqual(data.coverage.records.map(row => row.state), ['evaluated', 'missing']);
  assert.equal(data.coverage.records[0].fetchedAt, '2026-09-09T00:00:00Z');
  const readOnly = openPersonalStore(path, { readOnly: true });
  try { assert.throws(() => readOnly.set('key', 1), /read-only/); }
  finally { readOnly.close(); }
  assert.throws(() => openPersonalStore(join(path, 'nonexistent.sqlite'), { readOnly: true }));
});
