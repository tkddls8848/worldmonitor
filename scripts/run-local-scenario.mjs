#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { computeScenario } from './scenario-worker.mjs';

// Snapshot values are decoded JSON records, indexed by their original seed key.
// Missing keys deliberately remain missing; no remote fallback or invented data.
export async function runLocalScenario(snapshot, scenarioId, iso2 = null, disruptionPct) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Snapshot must be an object mapping seed keys to decoded JSON values');
  }
  const get = async key => Object.hasOwn(snapshot, key) ? snapshot[key] : null;
  return computeScenario(scenarioId, iso2, disruptionPct, {
    get,
    getMany: keys => Promise.all(keys.map(get)),
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    snapshot: { type: 'string' }, database: { type: 'string' }, scenario: { type: 'string' },
    country: { type: 'string' }, severity: { type: 'string' },
    output: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('node scripts/run-local-scenario.mjs --snapshot seeds.json --scenario hormuz-tanker-blockade [--country KR] [--severity 50] [--output result.json]');
    console.log('Snapshot: JSON object with seed-meta:supply_chain:chokepoint-exposure and supply-chain:exposure:{ISO2}:{HS2}:v1 keys. Results describe snapshot coverage, not live or global coverage.');
    console.log('Use --database personal.sqlite instead of --snapshot to read locally collected SQLite datasets. The database is opened read-only; expired records remain unavailable.');
    return;
  }
  if ((!values.snapshot && !values.database) || (values.snapshot && values.database) || !values.scenario) throw new Error('Exactly one of --snapshot or --database, and --scenario, are required');
  if (values.severity !== undefined && !/^(0|[1-9]\d?|100)$/.test(values.severity)) {
    throw new Error('--severity must be an integer from 0 to 100');
  }
  let result;
  const severity = values.severity === undefined ? undefined : Number(values.severity);
  if (values.database) {
    const { openPersonalStore } = await import('../shared/personal-store.mjs');
    const store = openPersonalStore(resolve(values.database), { readOnly: true });
    try {
      result = await computeScenario(values.scenario, values.country ?? null, severity, {
        get: async key => store.get(key),
        getMany: async keys => store.getMany(keys),
      });
    } finally { store.close(); }
  } else {
    const snapshot = JSON.parse(await readFile(values.snapshot, 'utf8'));
    result = await runLocalScenario(snapshot, values.scenario, values.country ?? null, severity);
  }
  const json = `${JSON.stringify(result, null, 2)}\n`;
  // Exclusive creation avoids overwriting an input snapshot or prior evidence.
  if (values.output) await writeFile(values.output, json, { flag: 'wx' });
  else process.stdout.write(json);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
