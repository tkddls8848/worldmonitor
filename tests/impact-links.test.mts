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
const eventsById = Object.fromEntries(snapshot.countryEvents.map((event) => [event.id, event]));

test('derives sanctions and tariffs from dated official records with known country associations', () => {
  assert.equal(byId['sanctions:US:MY'].evidence[0].title, 'Additions to the Entity List');
  assert.equal(byId['sanctions:US:AE'].evidence[0].title, '2 list additions associated with AE');
  assert.ok(!Object.keys(byId).some((id) => /^(sanctions|tariffs):US:US$/.test(id)));
  assert.equal(byId['tariffs:US:BR'].firstSeen, fixture.federalRegister.items.find((row) => row.id === '2026-24231')?.filedAt);
});

test('uses the UCDP event date and the other state relative to the affected country', () => {
  const event = fixture.ucdp.events[0];
  const delayed = byId['conflict:RU:UA'];
  assert.equal(delayed.lastSeen, event.dateEnd);
  assert.equal(delayed.trend, 'steady');
  assert.ok(!snapshot.summary.today.some((link) => link.kind === 'conflict'));
  assert.deepEqual(snapshot.sources.find((source) => source.id === 'ucdp'), { id: 'ucdp', status: 'delayed', dataAsOf: event.dateEnd });
  const { links: [link] } = buildImpactLinks({ ucdp: fixture.ucdp }, event.dateEnd + DAY);
  assert.equal(link.id, 'conflict:RU:UA');
  assert.equal(link.lastSeen, event.dateEnd);
  assert.match(link.evidence[0].title, /UCDP 647030/);
  assert.equal(link.magnitude, Math.round(10 + 4 * Math.log2(3)));
  assert.equal(link.trend, 'new');
  const { observations } = buildImpactLinks({
    ucdp: { events: [event, { ...event, id: '123', dateEnd: event.dateEnd - 29 * DAY }, { ...event, id: '124', dateEnd: event.dateEnd - 31 * DAY }] },
  }, now);
  assert.deepEqual(observations.map((row) => row.eventId), [event.id, '123']);
});

test('derives direction from the cited action and preserves a single bilateral pact', () => {
  assert.equal(byId['tension:CN:US'].direction, 'pressure');
  assert.equal(byId['tension:CN:US'].undirected, false);
  assert.equal(byId['tension:CN:US'].evidence[0].source, 'Deutschlandfunk');
  assert.ok(!byId['tension:US:CN']);
  assert.equal(byId['support:IN:JP'].direction, 'support');
  assert.equal(byId['support:IN:JP'].undirected, true);
  assert.ok(!byId['support:JP:IN']);
  assert.ok(!byId['support:CN:SY']);
  assert.ok(!byId['support:UA:US']);
});

test('revalidates retained citations and excludes companies, nationals, and unsupported actors', () => {
  const evidence = (title: string, index: number) => ({ title, publisher: 'Test Wire', url: `https://example.test/${index}`, publishedAt: now - DAY / 2 });
  const candidate = (from: string, to: string, title: string, index: number) => ({
    from, to, kind: 'tension', directed: false, confidence: 0.9, sources: [evidence(title, index)],
  });
  const valid = 'Mexico announces diplomatic protest after US denies extradition of former TV host';
  const relations = { status: 'ok', relations: [
    candidate('US', 'MX', valid, 1), candidate('MX', 'US', valid, 1),
    candidate('BR', 'US', "Brazil's Embraer criticizes new US tariffs, warns of air travel inflation", 2),
    candidate('NG', 'RU', 'Threatened by Wagner, this Nigerian journalist uncovered Russia’s war machine in Africa', 3),
    candidate('CN', 'US', 'China warns US companies against new restrictions', 4),
    candidate('KP', 'RU', 'Ukraine says North Korea temporarily halted missile shipments to Russia following diplomatic tensions', 5),
  ] };
  const retained = { actor: 'NG', target: 'RU', kind: 'tension', eventId: '', points: 10,
    evidence: { ...evidence(relations.relations[3]!.sources[0]!.title, 3), source: 'Test Wire' } };
  const result = buildImpactLinks({ relations }, now, [retained]);
  assert.deepEqual(result.links.map(({ id }) => id), ['tension:MX:US']);
  assert.equal(result.observations.length, 1);
  assert.equal(result.links[0].evidence[0].title, valid);
  const reply = candidate('US', 'MX', 'US warns Mexico against retaliatory measures', 6);
  const reciprocal = buildImpactLinks({ relations: { ...relations, relations: [...relations.relations, reply] } }, now);
  assert.equal(reciprocal.links.length, 1);
  assert.equal(reciprocal.links[0].undirected, true);
  assert.deepEqual(reciprocal.summary.byCountry, {});
});

test('requires state-to-state support rather than aid to local groups mentioned in the headline', () => {
  const support = (title: string, index: number) => ({
    from: 'JP', to: 'US', kind: 'support',
    sources: [{ title, publisher: 'Test Wire', url: `https://example.test/${index}`, publishedAt: now - DAY / 2 }],
  });
  const valid = 'US pledges military aid to Japan under new agreement';
  const relations = { status: 'ok', relations: [
    support(valid, 1),
    support('US sends aid to Japan earthquake victims', 2),
    support('US approves funding support for Japan’s semiconductor makers', 3),
    support('US sends no financial aid to Japan', 4),
  ] };
  const { links } = buildImpactLinks({ relations }, now);
  assert.deepEqual(links.map(({ id, undirected }) => [id, undirected]), [['support:US:JP', false]]);
  assert.deepEqual(links[0].evidence.map(({ title }) => title), [valid]);
});

test('keeps domestic incidents and financial or energy shocks out of both links and pressure totals', () => {
  assert.ok(snapshot.links.every((link) => link.actor !== link.target));
  assert.match(eventsById['country:energy:IQ'].evidence[0].title, /Iraq Delays/);
  assert.ok(!eventsById['country:energy:PK']);
  assert.match(eventsById['country:financial:US'].evidence[0].url, /R_20261124_4\.pdf$/);
  assert.equal(snapshot.summary.byCountry.IQ, undefined);
  assert.equal(snapshot.summary.byCountry.US.outgoing.financial, undefined);
  const stressed = structuredClone(fixture.funding);
  stressed.sofr.rate = stressed.effr.rate + 0.4;
  const { countryEvents: [funding] } = buildImpactLinks({ funding: stressed }, now);
  assert.equal(funding.id, 'country:financial:US');
  assert.match(funding.evidence[0].title, /40 bp/);
  assert.equal(funding.evidence[0].publishedAt, Date.parse(stressed.sofr.date));
  const event = { ...fixture.ucdp.events[0]!, country: 'Haiti', sideA: 'Government of Haiti', sideB: 'Viv Ansanm' };
  const domestic = buildImpactLinks({ ucdp: { events: [event, { ...event, id: '1' }] } }, now);
  assert.deepEqual(domestic.links, []);
  assert.deepEqual(domestic.summary.today, []);
  assert.equal(domestic.countryEvents[0].country, 'HT');
  assert.equal(domestic.countryEvents[0].eventCount, 2);
  assert.equal(domestic.countryEvents[0].evidence.length, 2);
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
  assert.deepEqual(result.summary?.today.map(({ id }) => id), ['tension:CN:US']);
  assert.equal(result.summary?.byCountry.CN.outgoing.tension, byId['tension:CN:US'].magnitude);
  assert.ok(!Object.hasOwn(result, 'observations'));
  assert.deepEqual(await getImpactLinks(ctx, defaults, async () => null), {
    generatedAt: 0, links: [], summary: { today: [], byCountry: {} }, sources: [], countryEvents: [],
  });
  const conflict = (window: string) => getImpactLinks(ctx, { ...defaults, kind: 'conflict', window }, async () => snapshot);
  assert.equal((await conflict('7d')).links[0]?.id, 'conflict:RU:UA');
  assert.deepEqual((await conflict('24h')).links, []);
  const iq = await getImpactLinks(ctx, { ...defaults, kind: 'conflict', country: 'IQ' }, async () => snapshot);
  assert.deepEqual(iq.links, []);
  assert.deepEqual(iq.countryEvents.map((event) => event.id), ['country:energy:IQ']);
  const { countryEvents: _, ...old } = snapshot;
  const legacy = await getImpactLinks(ctx, defaults, async () => ({
    ...old, links: [...old.links, { ...old.links[0], actor: 'NG', target: 'NG' }],
  }));
  assert.ok(legacy.links.every((link) => link.actor !== link.target && !['tension', 'support'].includes(link.kind)));
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
  assert.deepEqual(filtered.links, []);
  assert.deepEqual(filtered.countryEvents.map(({ id }) => id), ['country:energy:IQ']);
  await loadImpactLinks();
  assert.deepEqual(urls, [
    '/api/world-overview/v1/get-impact-links?kind=energy&country=IQ&window=24h&limit=1',
    '/api/world-overview/v1/get-impact-links',
  ]);
});
