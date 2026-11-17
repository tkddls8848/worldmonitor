// /monitor-the-situation/ readings. The page itself was written by the
// crawl corpus build, which left the personal build; these pin the pure
// reading helpers that page used.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { crisisFigure } from '../scripts/build-situation-page.mjs';
import { headlinesRecord } from '../scripts/situation-page/sections.mjs';
import { UnpublishableReading } from '../scripts/live-pages/common.mjs';

describe('/monitor-the-situation/ readings', () => {
  it('withholds the combined figure when the pulse holds none', () => {
    assert.equal(crisisFigure(null), null);
    assert.equal(crisisFigure({ state: 'missing' }), null);
    assert.equal(crisisFigure({ state: 'partial', eventsTotal: null, fatalities: null, referencePeriod: 'Mixed reference periods' }), null);
    assert.equal(crisisFigure({ state: 'ready', eventsTotal: '1,111', fatalities: '12', referencePeriod: '2026-10-01' }), '1,111 recorded events and 12 fatalities in the October 2026 HAPI summary');
  });

  it('rejects a digest it cannot publish as current', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    const fresh = { generatedAt: '2026-10-24T11:50:00Z', coverage: { state: 'complete' }, categories: { world: { items: [
      { title: 'A', source: 'Reuters', link: 'https://www.reuters.com/a', publishedAt: now - 60_000, importanceScore: 5 },
    ] } } };
    assert.equal(headlinesRecord(fresh, now).rows.length, 1);
    assert.throws(() => headlinesRecord({ ...fresh, generatedAt: '2026-10-24T05:00:00Z' }, now), UnpublishableReading);
    assert.throws(() => headlinesRecord({ ...fresh, coverage: { state: 'unavailable' } }, now), UnpublishableReading);
    assert.throws(() => headlinesRecord({ ...fresh, categories: { world: { items: [{ title: 'No source', link: 'https://x.y/z', publishedAt: now }] } } }, now), UnpublishableReading);
    assert.throws(() => headlinesRecord({ ...fresh, categories: null }, now), UnpublishableReading);
    const outOfRange = { title: 'B', source: 'AP', link: 'https://apnews.com/b', publishedAt: 8.64e15 + 1, importanceScore: 9 };
    const mixed = { ...fresh, categories: { world: { items: [...fresh.categories.world.items, outOfRange] } } };
    assert.deepEqual(headlinesRecord(mixed, now).rows.map((row) => row.title), ['A'], 'an unrepresentable time drops only that headline');
  });
});
