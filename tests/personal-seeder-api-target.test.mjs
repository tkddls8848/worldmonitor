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
    calls.push({ url: String(input), authorization: new Headers(init.headers).get('authorization') ?? undefined });
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

const headerObject = (headers) => Object.fromEntries(new Headers(headers));

function recordHeaders(t) {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    seen.push({ url: String(input), headers: headerObject(init.headers) });
    return new Response('{}', { status: 200 });
  });
  return seen;
}

test('a request to the personal server drops the upstream Origin its ingress refuses', async (t) => {
  const seen = recordHeaders(t);
  const apiFetch = wmApiFetch(PERSONAL_ENV);
  const headers = { 'User-Agent': 'ua', Origin: 'https://worldmonitor.app' };
  await apiFetch('http://127.0.0.1:3999/api/news/v1/list-feed-digest', { headers });
  await apiFetch('https://feeds.example.test/rss.xml', { headers });
  assert.deepEqual(seen, [
    { url: 'http://127.0.0.1:3999/api/news/v1/list-feed-digest', headers: { 'user-agent': 'ua', authorization: OWNER_AUTH } },
    { url: 'https://feeds.example.test/rss.xml', headers: { 'user-agent': 'ua', origin: 'https://worldmonitor.app' } },
  ]);
  assert.equal(headers.Origin, 'https://worldmonitor.app', 'the caller\'s headers object is not mutated');
});

test('Headers objects and header tuples keep every header on the way to the personal server', async (t) => {
  const seen = recordHeaders(t);
  const apiFetch = wmApiFetch(PERSONAL_ENV);
  const target = 'http://127.0.0.1:3999/api/infrastructure/v1/list-service-statuses';
  await apiFetch(target, { headers: new Headers({ 'Content-Type': 'application/json', Origin: 'https://worldmonitor.app' }) });
  await apiFetch(target, { headers: [['Content-Type', 'application/json'], ['X-Trace', '1'], ['Origin', 'https://worldmonitor.app']] });
  assert.deepEqual(seen, [
    { url: target, headers: { 'content-type': 'application/json', authorization: OWNER_AUTH } },
    { url: target, headers: { 'content-type': 'application/json', 'x-trace': '1', authorization: OWNER_AUTH } },
  ]);
});

test('with API_BASE_URL on another host the owner credential stays home and Origin is kept', async (t) => {
  const seen = recordHeaders(t);
  const env = { ...PERSONAL_ENV, API_BASE_URL: 'https://api.example.test' };
  const base = wmApiBase(env);
  await wmApiFetch(env)(`${base}/api/news/v1/list-feed-digest`, { headers: { 'User-Agent': 'ua', Origin: 'https://worldmonitor.app' } });
  assert.deepEqual(seen, [{
    url: 'https://api.example.test/api/news/v1/list-feed-digest',
    headers: { 'user-agent': 'ua', origin: 'https://worldmonitor.app' },
  }]);
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

// Direct fetches replace the relay's per-hop redirect checks
// (scripts/ais-relay.cjs fetchWithRedirects): at most 3 hops, each to an
// allowed domain over http(s) on the default port.
async function advisoryFetchFeed() {
  return (await import('../scripts/seed-security-advisories.mjs')).fetchFeed;
}
const CDC = { name: 'CDC Travel Notices', sourceCountry: 'US', sourceCategory: 'health', url: 'https://wwwnc.cdc.gov/travel/rss/notices.xml' };
const ONE_ITEM = '<rss><channel><item><title>Measles</title><link>https://wwwnc.cdc.gov/m</link><pubDate>Mon, 16 Nov 2026 00:00:00 GMT</pubDate></item></channel></rss>';
const redirectTo = (location) => new Response(null, { status: 302, headers: { location } });

for (const [label, location] of [
  ['a host outside the allowlist', 'https://evil.example/feed.xml'],
  ['the local store on 127.0.0.1:8079', 'http://127.0.0.1:8079/get/secret'],
  ['an allowed host on a non-default port', 'https://wwwnc.cdc.gov:8443/travel/rss/notices.xml'],
  ['a non-http scheme', 'file:///etc/passwd'],
]) {
  test(`a direct advisory fetch refuses a redirect to ${label}`, async (t) => {
    withEnv(t, {});
    const fetchFeed = await advisoryFetchFeed();
    const requested = [];
    const items = await fetchFeed(CDC, async (url, init) => {
      requested.push({ url: String(url), redirect: init?.redirect });
      return requested.length === 1 ? redirectTo(location) : new Response(ONE_ITEM, { status: 200 });
    });
    assert.deepEqual(items, []);
    assert.deepEqual(requested, [{ url: CDC.url, redirect: 'manual' }]);
  });
}

test('a direct advisory fetch follows a redirect that stays inside the allowlist', async (t) => {
  withEnv(t, {});
  const fetchFeed = await advisoryFetchFeed();
  const requested = [];
  const items = await fetchFeed(CDC, async (url, init) => {
    requested.push({ url: String(url), redirect: init?.redirect });
    return requested.length === 1 ? redirectTo('/travel/rss/notices-v2.xml') : new Response(ONE_ITEM, { status: 200 });
  });
  assert.equal(items.length, 1);
  assert.deepEqual(requested, [
    { url: CDC.url, redirect: 'manual' },
    { url: 'https://wwwnc.cdc.gov/travel/rss/notices-v2.xml', redirect: 'manual' },
  ]);
});

test('a direct advisory fetch gives up after three redirects', async (t) => {
  withEnv(t, {});
  const fetchFeed = await advisoryFetchFeed();
  let calls = 0;
  const items = await fetchFeed(CDC, async () => {
    calls += 1;
    return redirectTo(`https://wwwnc.cdc.gov/hop-${calls}.xml`);
  });
  assert.deepEqual(items, []);
  assert.equal(calls, 4, 'the original request plus three redirects');
});

test('an auth failure from the personal server names WM_PERSONAL_PASSWORD, not the relay key', async () => {
  const { wmApiAuthHint } = await import('../scripts/lib/personal-api.mjs');
  assert.match(wmApiAuthHint('http://127.0.0.1:3999/api/version', 401, PERSONAL_ENV), /WM_PERSONAL_PASSWORD/);
  assert.equal(wmApiAuthHint('http://127.0.0.1:3999/api/version', 503, PERSONAL_ENV), '');
  // Another API host keeps the caller's own (relay-key) hint.
  assert.equal(wmApiAuthHint('https://api.example.test/api/version', 401, PERSONAL_ENV), null);
});
