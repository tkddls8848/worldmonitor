import assert from 'node:assert/strict';
import { test } from 'node:test';
import fixture from './fixtures/impact-links-store.json' with { type: 'json' };
import { DEFAULT_COLLECTORS, STANDALONE_INTERVAL_MIN } from '../scripts/personal-collect.mjs';
import { buildImpactLinks } from '../scripts/seed-impact-links.mjs';
import { IMPACT_DAY_MS as DAY, IMPACT_LINKS_KEY, summarizeImpactLinks } from '../shared/impact-links';
import { getImpactLinks } from '../server/worldmonitor/world-overview/v1/get-impact-links';
import { createWorldOverviewServiceRoutes, type ServerContext } from '../src/generated/server/worldmonitor/world_overview/v1/service_server';
import { worldOverviewHandler } from '../server/worldmonitor/world-overview/v1/handler';
import { loadImpactLinks } from '../src/services/impact-links';

const now = fixture.captureTime;
const snapshot = buildImpactLinks(fixture, now);
const byId = Object.fromEntries(snapshot.links.map((link) => [link.id, link]));

test('derives sanctions and tariffs from dated official records with known country associations', () => {
  assert.equal(byId['sanctions:US:MY'].evidence[0].title, 'Additions to the Entity List');
  assert.equal(byId['sanctions:US:AE'].evidence[0].title, '2 list additions associated with AE');
  assert.ok(!Object.keys(byId).some((id) => /^(sanctions|tariffs):US:US$/.test(id)));
  assert.equal(byId['tariffs:US:BR'].firstSeen, fixture.federalRegister.items.find((row) => row.id === '2026-24231')?.filedAt);
});

test('uses the UCDP event date and the other state relative to the affected country', () => {
  assert.ok(!snapshot.links.some((link) => link.kind === 'conflict'));
  const event = fixture.ucdp.events[0];
  const { links: [link] } = buildImpactLinks({ ucdp: fixture.ucdp }, event.dateEnd + DAY);
  assert.equal(link.id, 'conflict:RU:UA');
  assert.equal(link.lastSeen, event.dateEnd);
  assert.match(link.evidence[0].title, /UCDP 647030/);
  assert.equal(link.magnitude, Math.round((10 + 4 * Math.log2(3)) * (13 / 14)));
  assert.equal(link.trend, 'new');
});

test('requires citations for tension and support and represents bilateral evidence in both directions', () => {
  assert.equal(byId['tension:CN:US'].direction, 'pressure');
  assert.equal(byId['tension:US:CN'].evidence[0].source, 'Deutschlandfunk');
  assert.equal(byId['support:IN:JP'].direction, 'support');
  assert.deepEqual(byId['support:JP:IN'].evidence, byId['support:IN:JP'].evidence);
  assert.ok(!byId['support:CN:SY']);
  assert.ok(!byId['support:UA:US']);
});

test('treats measured domestic energy and financial pressure as incoming only', () => {
  assert.match(byId['energy:IQ:IQ'].evidence[0].title, /Iraq Delays/);
  assert.ok(!byId['energy:PK:PK']);
  assert.match(byId['financial:US:US'].evidence[0].url, /R_20261124_4\.pdf$/);
  assert.equal(snapshot.summary.byCountry.IQ.incoming.energy, byId['energy:IQ:IQ'].magnitude);
  assert.deepEqual(snapshot.summary.byCountry.IQ.outgoing, {});
  assert.equal(snapshot.summary.byCountry.US.outgoing.financial, undefined);
  const stressed = structuredClone(fixture.funding);
  stressed.sofr.rate = stressed.effr.rate + 0.4;
  const { links: [funding] } = buildImpactLinks({ funding: stressed }, now);
  assert.equal(funding.id, 'financial:US:US');
  assert.match(funding.evidence[0].title, /40 bp/);
  assert.equal(funding.evidence[0].publishedAt, Date.parse(stressed.sofr.date));
});

test('deduplicates rolling observations, computes 24h vs 6d trend and drops expired evidence', () => {
  const [policy] = fixture.federalRegister.items.filter((row) => row.id === '2026-24231');
  const document = (index: number, age: number) => ({
    ...policy, id: String(index), url: `https://example.test/regulation/${index}`, filedAt: now - age,
  });
  const prior = Array.from({ length: 6 }, (_, i) => document(i, 2 * DAY + i));
  const evaluate = (items: ReturnType<typeof document>[]) => buildImpactLinks({ federalRegister: { items } }, now);
  const older = evaluate(prior);
  assert.equal(older.links[0].trend, 'falling');
  const current = document(10, DAY / 2);
  assert.equal(evaluate([...prior, current]).links[0].trend, 'steady');
  const other = document(11, DAY / 4);
  const final = { ...current, url: 'https://example.test/official', filedAt: now, type: 'Rule' };
  const advanced = buildImpactLinks({ federalRegister: { items: [current, final, other, document(99, -1)] } }, now, older.observations);
  const [link] = advanced.links;
  assert.equal(link.trend, 'rising');
  assert.equal(advanced.observations.length, 8);
  assert.equal(link.firstSeen, now - 2 * DAY - 5);
  assert.equal(link.lastSeen, other.filedAt);
  assert.equal(link.evidence.length, 5);
  assert.equal(link.evidence[0].url, other.url);
  assert.equal(advanced.summary.today[0].id, link.id);
  assert.equal(buildImpactLinks({}, now + 7 * DAY, advanced.observations).links.length, 0);
  assert.equal(evaluate(Array.from({ length: 30 }, (_, i) => document(i, 0))).links[0].magnitude, 100);
});

test('caps today at seven while pressure totals cover every matching link', () => {
  const sample = { ...byId['tariffs:US:BR'], magnitude: 3 };
  const links = Array.from({ length: 8 }, () => sample);
  const summary = summarizeImpactLinks(links, now);
  assert.equal(summary.today.length, 7);
  assert.equal(summary.byCountry.US.outgoing.tariffs, 24);
  assert.equal(summary.byCountry.BR.incoming.tariffs, 24);
});

test('publishes after its inputs with a 30-minute target cadence', () => {
  assert.equal(STANDALONE_INTERVAL_MIN['impact-links'], 30);
  assert.equal(DEFAULT_COLLECTORS.filter((name) => name === 'impact-links').length, 1);
  for (const input of ['world-relations-ai', 'federal-register', 'sanctions-pressure', 'conflict-intel', 'energy-intelligence', 'treasury-auctions', 'funding-stress']) {
    assert.ok(DEFAULT_COLLECTORS.includes(input));
    assert.ok(DEFAULT_COLLECTORS.indexOf(input) < DEFAULT_COLLECTORS.indexOf('impact-links'));
  }
});

const ctx = {} as ServerContext;
const defaults = { country: '', kind: '', window: '', limit: 0 };

test('RPC filters by kind, either country endpoint and age before applying limit', async () => {
  const result = await getImpactLinks(ctx, { ...defaults, kind: 'tension', country: 'cn', window: '24h', limit: 1 }, async (key) => {
    assert.equal(key, IMPACT_LINKS_KEY);
    return snapshot;
  });
  assert.deepEqual(result.links.map(({ id }) => id), ['tension:CN:US']);
  assert.deepEqual(result.summary?.today.map(({ id }) => id), ['tension:CN:US', 'tension:US:CN']);
  assert.equal(result.summary?.byCountry.CN.incoming.tension, byId['tension:US:CN'].magnitude);
  assert.ok(!Object.hasOwn(result, 'observations'));
  assert.deepEqual(await getImpactLinks(ctx, defaults, async () => null), {
    generatedAt: 0, links: [], summary: { today: [], byCountry: {} },
  });
  for (const filter of [{ kind: 'other' }, { country: 'ZZ' }, { window: '30d' }, { limit: 501 }, { limit: 1.2 }]) {
    await assert.rejects(getImpactLinks(ctx, { ...defaults, ...filter }, async () => assert.fail('invalid requests must be rejected before Redis')));
  }
});

test('browser service encodes filters through the generated GET route', async (t) => {
  const routes = createWorldOverviewServiceRoutes({
    ...worldOverviewHandler,
    getImpactLinks: (context, request) => getImpactLinks(context, request, async () => snapshot),
  });
  const route = routes.find((item) => item.path === '/api/world-overview/v1/get-impact-links');
  assert.ok(route);
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    urls.push(url.pathname + url.search);
    assert.equal(init.method, 'GET');
    return route.handler(new Request(url, init));
  });
  const filtered = await loadImpactLinks({ kind: 'energy', country: ' iq ', window: '24h', limit: 1 });
  assert.deepEqual(filtered.links.map(({ id }) => id), ['energy:IQ:IQ']);
  await loadImpactLinks();
  assert.deepEqual(urls, [
    '/api/world-overview/v1/get-impact-links?kind=energy&country=IQ&window=24h&limit=1',
    '/api/world-overview/v1/get-impact-links',
  ]);
});
