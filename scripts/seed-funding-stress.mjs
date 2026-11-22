#!/usr/bin/env node
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { collectFundingStress } from './_funding-stress.mjs';
loadEnvFile(import.meta.url);

runSeed('markets', 'funding-stress', 'markets:funding-stress:v1', () => collectFundingStress(), {
  validateFn: (value) => value != null && ['sofr', 'effr', 'rrp', 'ofrFsi'].some((key) => value[key] != null),
  ttlSeconds: 86400 * 3,
  declareRecords: () => 1,
  schemaVersion: 1,
  maxStaleMin: 2880,
  sourceVersion: 'funding-stress-v1',
}).catch((error) => { console.error('FATAL:', error.message || error); process.exit(1); });
