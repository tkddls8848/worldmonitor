import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_COLLECTORS, STANDALONE_INTERVAL_MIN } from '../scripts/personal-collect.mjs';
import { summarizeNewsThreat } from '../scripts/seed-news-threat-summary.mjs';

const digest = JSON.parse(readFileSync(new URL('./fixtures/news-threat-digest-excerpt.json', import.meta.url)));
const now = Date.parse(digest.generatedAt);

test('counts a live keyword label by affected country once across editions', () => {
  assert.deepEqual(summarizeNewsThreat([digest, digest], now), {
    byCountry: { SY: { critical: 0, high: 1, medium: 0, low: 0, info: 0 } },
    generatedAt: now,
  });
});

test('excludes old headlines, distinguishes quiet news from replay or missing coverage', () => {
  assert.deepEqual(summarizeNewsThreat([digest], now + 6 * 3600_000).byCountry, {});
  assert.throws(() => summarizeNewsThreat([null, digest], now), /full English news digest unavailable/);
  assert.throws(() => summarizeNewsThreat([{ ...digest, coverage: { ...digest.coverage, servedStale: true } }], now), /unavailable/);
  assert.throws(() => summarizeNewsThreat([digest, null], now + 6 * 3600_000), /cannot confirm a quiet news cycle/);
  assert.equal(STANDALONE_INTERVAL_MIN['news-threat-summary'], 15);
  assert.equal(DEFAULT_COLLECTORS.indexOf('news-threat-summary'), DEFAULT_COLLECTORS.indexOf('news-digest') + 1);
});
