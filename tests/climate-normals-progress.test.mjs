import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchClimateZoneNormals, normalsProgressStore } from '../scripts/seed-climate-zone-normals.mjs';
import { fetchOpenMeteoArchiveBatch, dailyLimitError } from '../scripts/_open-meteo-archive.mjs';
import { CLIMATE_ZONES } from '../scripts/_climate-zones.mjs';

const daily = {
  time: Array.from({ length: 12 }, (_, i) => `2000-${String(i + 1).padStart(2, '0')}-01`),
  temperature_2m_mean: Array(12).fill(10), precipitation_sum: Array(12).fill(1),
};
test('daily quota stops HTTP retries and proxy attempts immediately', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return new Response(JSON.stringify({ error: true, reason: 'Daily API request limit exceeded. Please try again tomorrow.' }), { status: 429 });
  });
  await assert.rejects(fetchOpenMeteoArchiveBatch(CLIMATE_ZONES.slice(0, 2), {
    startDate: '1991-01-01', endDate: '2020-12-31', daily: ['temperature_2m_mean'],
    _sleep: () => assert.fail('must not retry'),
    _connectProxyResolver: () => assert.fail('must not switch egress'),
  }), { code: 'OPEN_METEO_DAILY_LIMIT', nonRetryable: true });
  assert.equal(requests, 1);
});
test('normals survive restart, pause after quota, then resume only missing zones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wm-climate-progress-'));
  try {
    const file = join(dir, 'progress.json');
    let now = 1000000, calls = 0;
    const options = { _now: () => now, runStartedAtMs: now, _sleep: async () => {} };
    await assert.rejects(fetchClimateZoneNormals({ ...options, ...normalsProgressStore(file),
      _fetchArchiveBatch: async zones => { if (++calls === 2) throw dailyLimitError(); return zones.map(() => ({ daily })); },
    }), { code: 'OPEN_METEO_DAILY_LIMIT' });
    assert.equal(calls, 2);
    assert.equal((await normalsProgressStore(file)._loadProgress()).normals.length, 2);
    await assert.rejects(fetchClimateZoneNormals({ ...options, ...normalsProgressStore(file),
      _fetchArchiveBatch: () => assert.fail('cooldown must survive restart'),
    }), { code: 'OPEN_METEO_DAILY_LIMIT' });
    now += 86400001;
    const seen = [];
    const result = await fetchClimateZoneNormals({ ...options, runStartedAtMs: now, ...normalsProgressStore(file),
      _fetchArchiveBatch: async zones => { seen.push(...zones.map(z => z.name)); return zones.map(() => ({ daily })); },
    });
    assert.equal(result.normals.length, CLIMATE_ZONES.length);
    assert.deepEqual(seen, CLIMATE_ZONES.slice(2).map(z => z.name));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
