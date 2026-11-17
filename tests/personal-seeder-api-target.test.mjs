// Seeders that call the WorldMonitor API send those calls to the personal
// server (personalOrigin) with the owner's Basic credential, and a seeder that
// used the upstream RSS relay fetches its feeds directly unless RELAY_URL is
// set. See tests/personal-seeders-no-upstream-hosts.test.mjs for the static guard.
import assert from 'node:assert/strict';
import test from 'node:test';

import { wmApiBase, wmApiFetch } from '../scripts/lib/personal-api.mjs';

const PERSONAL_ENV = { WM_PERSONAL_HOST: '127.0.0.1', WM_PERSONAL_PORT: '3999', WM_PERSONAL_PASSWORD: 'p'.repeat(16) };
const OWNER_AUTH = `Basic ${Buffer.from(`owner:${'p'.repeat(16)}`).toString('base64')}`;

function withEnv(t, values) {
  const names = ['API_BASE_URL', 'RELAY_URL', 'WM_PERSONAL_HOST', 'WM_PERSONAL_PORT', 'WM_PERSONAL_USERNAME', 'WM_PERSONAL_PASSWORD'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function recordFetch(t, body = '{}') {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    calls.push({ url: String(input), authorization: init.headers?.authorization });
    return new Response(body, { status: 200 });
  });
  return calls;
}

test('the API base is the personal server unless API_BASE_URL names another', () => {
  assert.equal(wmApiBase({}), 'http://127.0.0.1:3000');
  assert.equal(wmApiBase({ WM_PERSONAL_HOST: '127.0.0.1', WM_PERSONAL_PORT: '3999' }), 'http://127.0.0.1:3999');
  assert.equal(wmApiBase({ API_BASE_URL: 'http://worldmonitor:8080/' }), 'http://worldmonitor:8080');
  assert.equal(wmApiBase({ API_BASE_URL: '   ' }), 'http://127.0.0.1:3000');
});

test('the owner credential goes to the personal server and nowhere else', async (t) => {
  const calls = recordFetch(t);
  const apiFetch = wmApiFetch(PERSONAL_ENV);
  await apiFetch('http://127.0.0.1:3999/api/infrastructure/v1/list-service-statuses', { method: 'POST' });
  await apiFetch('https://feeds.example.test/rss.xml');
  assert.deepEqual(calls, [
    { url: 'http://127.0.0.1:3999/api/infrastructure/v1/list-service-statuses', authorization: OWNER_AUTH },
    { url: 'https://feeds.example.test/rss.xml', authorization: undefined },
  ]);
});

test('a request to the personal server drops the upstream Origin its ingress refuses', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    seen.push({ url: String(input), headers: init.headers });
    return new Response('{}', { status: 200 });
  });
  const apiFetch = wmApiFetch(PERSONAL_ENV);
  const headers = { 'User-Agent': 'ua', Origin: 'https://worldmonitor.app' };
  await apiFetch('http://127.0.0.1:3999/api/news/v1/list-feed-digest', { headers });
  await apiFetch('https://feeds.example.test/rss.xml', { headers });
  assert.deepEqual(seen, [
    { url: 'http://127.0.0.1:3999/api/news/v1/list-feed-digest', headers: { 'User-Agent': 'ua', authorization: OWNER_AUTH } },
    { url: 'https://feeds.example.test/rss.xml', headers },
  ]);
  assert.equal(headers.Origin, 'https://worldmonitor.app', 'the caller\'s headers object is not mutated');
});

test('without a personal password the API fetch adds no credential', async (t) => {
  const calls = recordFetch(t);
  await wmApiFetch({})('http://127.0.0.1:3000/api/version');
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:3000/api/version', authorization: undefined }]);
});

test('china-decision-signals reads its RPC from the personal server by default', async (t) => {
  withEnv(t, PERSONAL_ENV);
  const { fetchChinaDecisionSignals } = await import('../scripts/seed-china-decision-signals.mjs');
  const calls = recordFetch(t, JSON.stringify({ payloadJson: '{}' }));
  // The empty payload fails the six-group contract; only the target matters here.
  await assert.rejects(() => fetchChinaDecisionSignals(), /six-group contract/);
  assert.deepEqual(calls, [{
    url: 'http://127.0.0.1:3999/api/intelligence/v1/get-china-decision-signals',
    authorization: OWNER_AUTH,
  }]);
});

test('security-advisories fetches each feed directly when no relay is configured', async (t) => {
  withEnv(t, {});
  const { fetchFeed } = await import('../scripts/seed-security-advisories.mjs');
  const requested = [];
  const feed = { name: 'CDC Travel Notices', sourceCountry: 'US', sourceCategory: 'health', url: 'https://wwwnc.cdc.gov/travel/rss/notices.xml' };
  await fetchFeed(feed, async (url) => {
    requested.push(url);
    return new Response('<rss><channel></channel></rss>', { status: 200 });
  });
  assert.deepEqual(requested, ['https://wwwnc.cdc.gov/travel/rss/notices.xml']);
});
