// A catalog feed whose URL is a path ("/api/miit-news") is served by this
// fork's own API. The digest fetches it from the local API in-process, with the
// local API's transport token, and never from another host or the relay.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ownApiFeedRequest } from '../server/_shared/own-api-feed';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';

const { fetchRssText, fetchViaRelay } = __testing__;
const ENV = { LOCAL_API_ORIGIN: 'http://127.0.0.1:45678', LOCAL_API_TOKEN: 'local-token' };
const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><title>MIIT (China)</title></channel></rss>';

function withEnv(t: test.TestContext, values: Record<string, string | undefined>) {
  const names = ['LOCAL_API_ORIGIN', 'LOCAL_API_TOKEN', 'WS_RELAY_URL'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  for (const [name, value] of Object.entries(values)) if (value !== undefined) process.env[name] = value;
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test('a path feed resolves to the local API with its transport token', () => {
  assert.deepEqual(ownApiFeedRequest('/api/miit-news', ENV), {
    url: 'http://127.0.0.1:45678/api/miit-news',
    headers: { 'x-worldmonitor-local-token': 'local-token' },
  });
});

test('absolute, protocol-relative and unconfigured feeds are not own-API requests', () => {
  assert.equal(ownApiFeedRequest('https://www.miit.gov.cn/', ENV), null);
  assert.equal(ownApiFeedRequest('//evil.example/api/miit-news', ENV), null);
  assert.equal(ownApiFeedRequest('/api/miit-news', {}), null);
  assert.equal(ownApiFeedRequest('/api/miit-news', { LOCAL_API_ORIGIN: ENV.LOCAL_API_ORIGIN }), null);
});

test('the digest fetches a path feed from the local API with the token', async (t) => {
  withEnv(t, ENV);
  const calls: Array<{ url: string; token: string | undefined }> = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    calls.push({ url: String(input), token: (init.headers as Record<string, string>)['x-worldmonitor-local-token'] });
    return new Response(RSS, { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  });
  const result = await fetchRssText('/api/miit-news', new AbortController().signal);
  assert.equal(result.text, RSS);
  assert.deepEqual(calls, [{ url: 'http://127.0.0.1:45678/api/miit-news', token: 'local-token' }]);
});

test('without a local API the path feed fails without any request', async (t) => {
  withEnv(t, {});
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(RSS));
  const result = await fetchRssText('/api/miit-news', new AbortController().signal);
  assert.equal(result.text, null);
  assert.equal(result.failure, 'direct-error');
  assert.equal(fetch.mock.callCount(), 0);
});

test('a path feed is never sent to the relay', async (t) => {
  withEnv(t, { WS_RELAY_URL: 'https://relay.example.test' });
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(RSS));
  const result = await fetchViaRelay('/api/miit-news', new AbortController().signal);
  assert.equal(result.attempted, false);
  assert.equal(fetch.mock.callCount(), 0);
});

test('the MIIT catalog feed is served by the fork\'s own /api/miit-news', () => {
  for (const file of ['shared/news-catalog.json', 'scripts/shared/news-catalog.json']) {
    const catalog = JSON.parse(readFileSync(file, 'utf8'));
    const miit = catalog.feeds.find((feed: { name: string }) => feed.name === 'MIIT (China)');
    assert.equal(miit.url, '/api/miit-news', file);
  }
});
