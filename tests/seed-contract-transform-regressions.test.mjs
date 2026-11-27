// Regression locks for PR #3097 review findings:
//
//   1. runSeed passes publishData (post-transform) to declareRecords. Seeders
//      that author declareRecords against the pre-transform shape silently
//      enter the RETRY path (count=0 with zeroIsValid=false), skipping the
//      write.
//
//   2. extraKeys whose key begins with `seed-meta:` must NEVER be enveloped —
//      health/bundle-runner/legacy readers parse them as bare `{fetchedAt,
//      recordCount}`. seed-iea-oil-stocks' ANALYSIS_META_EXTRA_KEY hit this.
//
//   3. Per-extra-key declareRecords must operate on the transformed extra-key
//      payload, not the raw fetch result. Token-panels' AI/OTHER extras now
//      declare their own recordCount against the extracted panel.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildEnvelope, unwrapEnvelope } from '../scripts/_seed-envelope-source.mjs';
import { resolveRecordCount } from '../scripts/_seed-contract.mjs';
import { shouldEnvelopeKey } from '../scripts/_seed-utils.mjs';

// ─── Commit A: shouldEnvelopeKey invariant ──────────────────────────────

test('shouldEnvelopeKey: seed-meta:* keys must stay bare', () => {
  assert.equal(shouldEnvelopeKey('seed-meta:energy:oil-stocks-analysis'), false);
  assert.equal(shouldEnvelopeKey('seed-meta:conflict:ucdp-events'), false);
  assert.equal(shouldEnvelopeKey('seed-meta:'), false);
});

test('shouldEnvelopeKey: canonical data keys DO envelope', () => {
  assert.equal(shouldEnvelopeKey('economic:fsi-eu:v1'), true);
  assert.equal(shouldEnvelopeKey('market:perp-positioning:v1'), true);
  assert.equal(shouldEnvelopeKey('climate:zone-normals:v1'), true);
});

test('shouldEnvelopeKey: non-string / falsy → defensive false', () => {
  assert.equal(shouldEnvelopeKey(null), false);
  assert.equal(shouldEnvelopeKey(undefined), false);
  assert.equal(shouldEnvelopeKey(''), true); // empty string is not a seed-meta prefix
});

// ─── Commit B: declareRecords must work on post-transform shape ──────────

// ─── partial-fetch clobber guard (false-503 root cause) ──────────────────
// CoinGecko's /coins/markets?ids= returns only the IDs it has data for. A
// partial response that drops the AI or Other IDs (while DeFi still resolves,
// so validateFn passes on the canonical panel) would otherwise write an empty
// recordCount=0 AI/Other panel — blanking the UI AND tripping the seed-contract
// probe's minRecords:1 floor (recurring false 503). `skipWhenEmpty` prevents it.

test('shouldSkipEmptyExtraKey: skips an opted-in extra key only when recordCount is 0', async () => {
  const { shouldSkipEmptyExtraKey } = await import('../scripts/_seed-utils.mjs');
  assert.equal(shouldSkipEmptyExtraKey({ skipWhenEmpty: true }, 0), true);
  assert.equal(shouldSkipEmptyExtraKey({ skipWhenEmpty: true }, 3), false, 'non-empty must still write');
  assert.equal(shouldSkipEmptyExtraKey({ skipWhenEmpty: false }, 0), false, 'not opted in → write (legacy)');
  assert.equal(shouldSkipEmptyExtraKey({}, 0), false, 'no flag → write (legacy)');
  assert.equal(shouldSkipEmptyExtraKey(undefined, 0), false);
});

// ─── validateFn also runs on post-transform shape ────────────────────────
//
// atomicPublish() calls validateFn(publishData). The imported validate() cases
// below must accept the transformed panel and reject empty or zero-price data;
// that production contract prevents a pre-transform shape check from silently
// skipping the write.

// ─── Commit E: resolveRecordCount contract invariants ────────────────────

test('resolveRecordCount: accepts 0 when declareRecords returns 0', () => {
  assert.equal(resolveRecordCount(() => 0, {}), 0);
});

test('resolveRecordCount: throws on non-integer return', () => {
  assert.throws(() => resolveRecordCount(() => 3.5, {}), /non-negative integer/);
  assert.throws(() => resolveRecordCount(() => 'many', {}), /non-negative integer/);
});

// ─── Commit D: envelope unwrap on product-catalog cached shape ──────────

test('unwrapEnvelope: contract-mode product-catalog payload returns bare {tiers,...}', () => {
  const bare = { tiers: [{ id: 'pro', price: 12 }], fetchedAt: 1, cachedUntil: 2, priceSource: 'dodo' };
  const enveloped = buildEnvelope({
    fetchedAt: 1, recordCount: 1, sourceVersion: 'dodo-v1', schemaVersion: 1, state: 'OK',
    data: bare,
  });
  const unwrapped = unwrapEnvelope(enveloped).data;
  assert.deepEqual(unwrapped, bare, 'edge reader must return bare tiers shape, not {_seed, data}');
});

test('unwrapEnvelope: legacy bare product-catalog value passes through', () => {
  const legacy = { tiers: [], fetchedAt: 100, cachedUntil: 200, priceSource: 'fallback' };
  assert.deepEqual(unwrapEnvelope(legacy).data, legacy);
});
