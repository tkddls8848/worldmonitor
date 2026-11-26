import path from 'node:path';
import { pathToFileURL } from 'node:url';
import tasksModule from './personal-collector-tasks.cjs';
import { loadEnvFile, redisCommand, getRedisCredentials, SOURCE_SKIPPED_EXIT_CODE } from './_seed-utils.mjs';
import { parseStoredSeedJson } from './_seed-payload-codec.mjs';

// One scheduler owns these producers; none starts a listener or a retry loop.
export const PERSONAL_TASKS = {
  'sector-summary': ['seedSectorSummary', 'market:sectors:v2', 30],
  satellites: ['seedSatelliteTLEs', 'intelligence:satellites:tle:v1', 120],
  'tech-events': ['seedTechEvents', 'research:tech-events-bootstrap:v1', 240],
  'corridor-risk': ['seedCorridorRisk', 'supply_chain:corridorrisk:v1', 60],
  'usni-fleet': ['seedUsniFleet', 'usni-fleet:sebuf:v1', 180],
  'social-velocity': ['seedSocialVelocity', 'intelligence:social:reddit:v1', 180],
  'wsb-tickers': ['seedWsbTickers', 'intelligence:wsb-tickers:v1', 180],
  gscpi: ['seedGscpi', 'economic:fred:v1:GSCPI:0', 1440],
  pizzint: ['seedPizzint', 'intelligence:pizzint:seed:v1', 15],
};

export async function runPersonalTask(name) {
  const entry = PERSONAL_TASKS[name];
  if (!entry) throw new Error(`Unknown personal task: ${name}`);
  loadEnvFile(import.meta.url);
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Start the personal store before collecting data');
  }
  const startedAt = Date.now();
  const result = await tasksModule.createPersonalCollectorTasks()[entry[0]]();
  if (result === 'quiet') {
    console.log(`NO SOURCE: ${name} has no new observation; preserving the last reading`);
    return SOURCE_SKIPPED_EXIT_CODE;
  }
  const { url, token } = getRedisCredentials();
  const reply = await redisCommand(url, token, ['GET', entry[1]]);
  const meta = reply.result ? parseStoredSeedJson(reply.result)?._seed : null;
  if (!Number.isFinite(meta?.fetchedAt) || meta.fetchedAt < startedAt) {
    throw new Error(`${name}: no new observation was published; last good data retained`);
  }
  console.log(`${name}: published ${meta.recordCount ?? 0} records`);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runPersonalTask(process.argv[2]).then(code => { if (code === 0) console.log("=== Done ==="); process.exitCode = code; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
