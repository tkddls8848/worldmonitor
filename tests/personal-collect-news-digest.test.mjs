// collect:personal stands in for the relay's digest warm cycle: without it no
// `news:digest:v1:<edition>:en` cell is built unless someone has the dashboard
// open, and the country brief, chat analyst, insights and forecasts read none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COLLECTORS, collectorScript } from '../scripts/personal-collect.mjs';
import { PERSONAL_DIGEST_CELLS, warmPersonalDigest } from '../scripts/seed-news-digest.mjs';

const PASSWORD = 'collect-test-password-123';

test('the digest is built before the collectors that read it', () => {
  assert.match(collectorScript('news-digest'), /seed-news-digest\.mjs$/);
  const at = (name) => DEFAULT_COLLECTORS.indexOf(name);
  assert.ok(at('news-digest') >= 0, 'news-digest is a default collector');
  for (const reader of ['insights', 'forecasts', 'digest-notifications']) {
    assert.ok(at(reader) > at('news-digest'), `${reader} runs after news-digest`);
  }
});

test('every English edition cell is requested through the personal server with the owner credential', async () => {
  const seen = [];
  const fetchImpl = async (input, init = {}) => {
    seen.push({ url: String(input), headers: init.headers ?? {} });
    return new Response(JSON.stringify({ coverage: { state: 'complete', feedTotal: 3, feedCompleted: 3, servedStale: false } }), { status: 200 });
  };
  const env = { WM_PERSONAL_PASSWORD: PASSWORD, WM_PERSONAL_PORT: '3999' };
  const summary = await warmPersonalDigest({ env, fetchImpl, spreadMs: 0 });

  assert.deepEqual(PERSONAL_DIGEST_CELLS.map((cell) => cell.lang), PERSONAL_DIGEST_CELLS.map(() => 'en'));
  assert.ok(PERSONAL_DIGEST_CELLS.some((cell) => cell.edition === 'full'));
  assert.deepEqual(
    seen.map((call) => call.url).sort(),
    PERSONAL_DIGEST_CELLS.map((cell) => `http://127.0.0.1:3999/api/news/v1/list-feed-digest?variant=${cell.edition}&lang=en`).sort(),
  );
  for (const call of seen) {
    assert.equal(call.headers.authorization, `Basic ${Buffer.from(`owner:${PASSWORD}`).toString('base64')}`);
    assert.match(call.headers['User-Agent'] ?? '', /WorldMonitor/);
  }
  assert.equal(summary.ok, true);
  assert.equal(summary.fresh, PERSONAL_DIGEST_CELLS.length);
});

test('the pass fails when the full English cell, the one every reader uses, was not served', async () => {
  const fetchImpl = async (input) => {
    const failed = String(input).includes('variant=full&');
    return new Response(failed ? 'nope' : JSON.stringify({ coverage: { state: 'complete', servedStale: false } }), { status: failed ? 502 : 200 });
  };
  const summary = await warmPersonalDigest({ env: { WM_PERSONAL_PASSWORD: PASSWORD }, fetchImpl, spreadMs: 0 });
  assert.equal(summary.ok, false);
  assert.ok(summary.failures.some((failure) => failure.startsWith('full:en:')));
  await assert.rejects(warmPersonalDigest({ env: {}, fetchImpl, spreadMs: 0 }), /WM_PERSONAL_PASSWORD/);
});
