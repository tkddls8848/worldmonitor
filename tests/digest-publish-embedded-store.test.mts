/**
 * The personal server's embedded store runs no Lua, so the digest's atomic
 * publish script (shared/digest-lastgood-publish-script.mjs) cannot run there.
 * Before this was handled, every personal-mode digest build was dropped as
 * "publish unavailable": `news:digest:v1:<edition>:<lang>` never existed, and
 * every reader of it (country brief, chat analyst, news pool, country history,
 * forecasts) saw no news.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startEmbeddedStore } from '../scripts/local/embedded-store.mjs';

const TOKEN = 'digest-publish-embedded-store-token';
const CANONICAL_KEY = 'news:digest:v1:full:en';

const coverage = () => ({
  state: 'complete', attemptedAt: new Date().toISOString(), itemsServed: 1, publisherCount: 1,
  feedTotal: 1, feedCompleted: 1, categoryTotal: 1, categoryCompleted: 1, categoryStates: { politics: 'ok' },
  droppedFeedCap: 0, droppedUndated: 0, droppedFreshness: 0, droppedCategoryCap: 0,
  servedStale: false, staleAgeSeconds: 0, staleReason: '',
});
const body = (links: string[]) => ({
  categories: { politics: { items: links.map((link) => ({ link, source: 'S', title: link })) } },
  feedStatuses: {},
  generatedAt: new Date().toISOString(),
  coverage: coverage(),
});

describe('digest publication against the embedded personal store', () => {
  const saved = { ...process.env };
  let store: Awaited<ReturnType<typeof startEmbeddedStore>>;

  before(async () => {
    store = await startEmbeddedStore({ token: TOKEN, port: 0 });
    // What start:personal sets for the local API process.
    process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${store.port}`;
    process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
    process.env.LOCAL_API_MODE = 'docker';
    process.env.WM_PERSONAL_STORE = 'embedded';
  });

  after(async () => {
    await store.close();
    for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'LOCAL_API_MODE', 'WM_PERSONAL_STORE']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('writes the canonical cell and the last-good snapshot, and keeps the richer one', async () => {
    const { publishAcceptedSnapshot } = await import('../server/worldmonitor/news/v1/_lastgood-store.ts');
    const { lastGoodKey } = await import('../server/worldmonitor/news/v1/_lastgood.ts');

    const rich = body(['https://a/1', 'https://a/2', 'https://a/3']);
    assert.equal(await publishAcceptedSnapshot('full', 'en', rich, CANONICAL_KEY), 'accepted');
    const cell = store.engine.exec(['GET', CANONICAL_KEY]);
    assert.ok(cell, 'the canonical digest cell exists');
    assert.deepEqual(JSON.parse(cell as string).categories, rich.categories);
    assert.ok(store.engine.exec(['GET', lastGoodKey('full', 'en')]), 'the last-good snapshot exists');
    assert.ok(Number(store.engine.exec(['TTL', CANONICAL_KEY])) > 0, 'the cell expires like the upstream one');

    // The same acceptance gate as upstream: a narrower build does not replace it.
    assert.equal(await publishAcceptedSnapshot('full', 'en', body(['https://a/9']), CANONICAL_KEY), 'rejected');
    assert.deepEqual(JSON.parse(store.engine.exec(['GET', CANONICAL_KEY]) as string).categories, rich.categories);
  });
});
