#!/usr/bin/env node
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { buildEcosMacro, validateEcosMacro } from './lib/ecos-macro.mjs';

loadEnvFile(import.meta.url);

const KEY = 'kr:ecos-macro:v1';
const TTL_SECONDS = 3 * 86400;

if (process.argv[1]?.endsWith('seed-ecos-macro.mjs')) {
  runSeed('kr', 'ecos-macro', KEY, () => buildEcosMacro({ apiKey: process.env.ECOS_API_KEY }), {
    validateFn: validateEcosMacro,
    ttlSeconds: TTL_SECONDS,
    sourceVersion: 'ecos-key-statistics-v1',
    schemaVersion: 1,
    maxStaleMin: 2880,
  }).catch((err) => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
