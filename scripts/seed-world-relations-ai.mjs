#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loadEnvFile, readCanonicalValue, runSeed } from './_seed-utils.mjs';
import { callLlmViaInsights, declareRecords as declareAiRecords, generateAiSnapshot, shouldRunAiToday } from './_world-relations-ai.mjs';
import { WORLD_OVERVIEW_KEYS, kstDate } from '../shared/world-overview.js';
import { markActivated } from './_world-overview-io.mjs';

export function declareRecords(data) { return declareAiRecords(data); }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  loadEnvFile(import.meta.url);
  const existing = await readCanonicalValue(WORLD_OVERVIEW_KEYS.ai);
  const gate = shouldRunAiToday({ existing, nowMs: Date.now(), force: process.argv.includes('--force') });
  if (!gate.run) console.log(`world-relations-ai skipped: ${gate.reason}`);
  else {
    await runSeed('world-overview', 'ai', WORLD_OVERVIEW_KEYS.ai, async ({ fetchDeadlineAtMs }) => {
      const [pool, insights] = await Promise.all([
        readCanonicalValue('news:insights:v1:pool'),
        readCanonicalValue('news:insights:v1'),
      ]);
      if (!pool) throw Object.assign(new Error('story pool missing'), { nonRetryable: true });
      return generateAiSnapshot({ pool, insights, date: kstDate(Date.now()), nowMs: Date.now, deadlineAtMs: fetchDeadlineAtMs, callLlm: callLlmViaInsights, previous: existing });
    }, {
      validateFn: (d) => /^\d{4}-\d{2}-\d{2}$/.test(d?.date) && d.relations.length + d.issues.length > 0,
      declareRecords, ttlSeconds: 259200, sourceVersion: 'world-relations-ai-v1', schemaVersion: 1, maxStaleMin: 2160,
      lockTtlMs: 330_000, fetchPhaseTimeoutMs: 300_000,
      afterPublish: () => markActivated('seed-activated:world-overview:ai'),
    });
  }
}
