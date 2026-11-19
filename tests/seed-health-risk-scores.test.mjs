// Cross-file source check by design (#8690, section 2): this suite compares
// freshness declarations in api/seed-health.js and api/health.js and pins
// relay warm-ping ownership of health metadata.
// A runtime handler result does not expose those freshness declarations,
// and importing the relay starts its server and background loops.
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

function readRepoFile(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function extractObjectEntry(source, entryName) {
  const pattern = new RegExp(`${entryName}:\\s*\\{\\s*key:\\s*'([^']+)',\\s*(?:maxStaleMin|intervalMin):\\s*([0-9_]+)`);
  const match = source.match(pattern);
  assert.ok(match, `missing ${entryName} freshness entry`);
  return { key: match[1], minutes: Number(match[2].replaceAll('_', '')) };
}

test('seed-health CII risk score freshness mirrors api/health riskScores', () => {
  const seedHealth = readRepoFile('api/seed-health.js');
  const health = readRepoFile('api/health.js');

  const healthRiskScores = extractObjectEntry(health, 'riskScores');
  const seedHealthMatch = seedHealth.match(
    /'intelligence:risk-scores':\s*\{\s*key:\s*'([^']+)',\s*intervalMin:\s*([0-9_]+)/,
  );

  assert.ok(seedHealthMatch, 'api/seed-health.js must register intelligence:risk-scores');
  assert.equal(seedHealthMatch[1], 'seed-meta:intelligence:risk-scores');
  assert.equal(healthRiskScores.key, seedHealthMatch[1]);
  assert.equal(
    Number(seedHealthMatch[2].replaceAll('_', '')) * 2,
    healthRiskScores.minutes,
    'seed-health intervalMin*2 must match api/health.js riskScores maxStaleMin',
  );
  assert.match(
    health,
    /riskScores:\s*\{\s*key:\s*'seed-meta:intelligence:risk-scores',\s*maxStaleMin:\s*30,\s*minRecordCount:\s*2\s*\}/,
    'api/health.js riskScores must degrade partial realtime signal-density coverage via minRecordCount=2 (conflict + news since CII v14)',
  );
  assert.match(
    health,
    /signal-density coverage/i,
    'api/health.js riskScores comment must document that recordCount is not raw feed availability',
  );
  assert.ok(
    seedHealth.includes('api/health.js riskScores'),
    'seed-health CII comment should keep the alignment target explicit',
  );
  assert.doesNotMatch(
    seedHealth,
    /seed-meta:risk:scores:sebuf/,
    'seed-health must not drift back to the retired risk:scores:sebuf seed-meta key',
  );
  assert.doesNotMatch(
    seedHealth,
    /'risk:scores:sebuf':/,
    'seed-health must not publish the retired risk:scores:sebuf seed domain',
  );
});

test('the get-risk-scores handler owns the risk-score health count (signal coverage)', () => {
  // The relay's upstream CII warm-ping is gone; the handler alone writes this seed-meta.
  const relay = readRepoFile('scripts/ais-relay.cjs');
  const handler = readRepoFile('server/worldmonitor/intelligence/v1/get-risk-scores.ts');
  assert.doesNotMatch(relay, /seed-meta:intelligence:risk-scores/, 'the relay no longer touches the risk-score seed-meta');
  assert.match(
    handler,
    /countCiiRealtimeSignalDensityCoverage\(acled,\s*aux,\s*nowMs\)/,
    'get-risk-scores handler must derive riskScores recordCount from real-time CII signal-density coverage using the request clock',
  );
  assert.match(
    handler,
    /not a raw feed heartbeat/i,
    'get-risk-scores handler must document that signal-density health can differ from feed availability',
  );
});
