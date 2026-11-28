#!/usr/bin/env node
import { loadEnvFile, getRedisCredentials, redisCommand } from './_seed-utils.mjs';
import { callLlmViaInsights } from './_world-relations-ai.mjs';
import { createNewsEventBudget } from './seed-news-events.mjs';
import { NEWS_EVENT_BATCH_SIZE, extractNewsEventBatch, prioritizeEventItems } from './_news-events.mjs';
import { IMPACT_KINDS } from '../shared/impact-links.ts';
import fixture from '../tests/fixtures/news-impact-events-eval.json' with { type: 'json' };

loadEnvFile(import.meta.url);
const { url, token } = getRedisCredentials();
const budget = createNewsEventBudget(async (command) => (await redisCommand(url, token, command)).result);
const items = fixture.map((row, i) => ({ ...row, id: String(i), publishedAt: row.publishedAt ?? 0 }));
const candidates = prioritizeEventItems(items);
const scored = new Set(items.filter((item) => !candidates.includes(item)).map((item) => item.id));
const extracted = [];
for (let i = 0; i < candidates.length; i += NEWS_EVENT_BATCH_SIZE) {
  const batch = candidates.slice(i, i + NEWS_EVENT_BATCH_SIZE);
  const result = await extractNewsEventBatch(batch, { ...budget, callLlm: callLlmViaInsights });
  if (!result) break;
  for (const { id } of batch) scored.add(id);
  extracted.push(...result.events);
}

const counts = Object.fromEntries(IMPACT_KINDS.map((kind) => [kind, { tp: 0, fp: 0, fn: 0 }]));
const misses = [];
for (const item of items.filter(({ id }) => scored.has(id))) {
  const actual = extracted.filter((event) => event.item.id === item.id)
    .map(({ kind, actor, target, direction }) => [kind, actor, target, direction].join(':'));
  const unexpected = actual.filter((key) => !item.expected.includes(key));
  const missing = item.expected.filter((key) => !actual.includes(key));
  for (const key of actual) counts[key.split(':')[0]][item.expected.includes(key) ? 'tp' : 'fp']++;
  for (const key of missing) counts[key.split(':')[0]].fn++;
  if (unexpected.length || missing.length) misses.push({ id: item.id, title: item.title, unexpected, missing });
}
const metrics = Object.fromEntries(Object.entries(counts).map(([kind, { tp, fp, fn }]) => [
  kind, { tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null },
]));
console.log(JSON.stringify({
  headlines: items.length, scored: scored.size, sentToModel: scored.size - items.length + candidates.length,
  ...budget.stats, costUsd: 0, metrics, misses, extracted,
}, null, 2));
if (scored.size !== items.length) process.exitCode = 1;
