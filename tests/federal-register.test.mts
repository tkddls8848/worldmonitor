import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { __testing__ as health } from '../api/health.js';
import { BOOTSTRAP_CACHE_KEYS, bootstrapTierKeyNames } from '../api/_bootstrap-tier-keys.js';
import { DEFAULT_COLLECTORS, STANDALONE_INTERVAL_MIN } from '../scripts/personal-collect.mjs';
import { fetchFederalRegister, mapFederalRegisterDocuments } from '../scripts/seed-federal-register.mjs';
import { loadFederalRegister } from '../src/services/federal-register';

// Federal Register API v1 documents response, captured 2026-11-23.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/federal-register-documents.json', import.meta.url), 'utf8'));
// Current list and presidential headings captured from the public-inspection API.
const inspection = JSON.parse(readFileSync(new URL('./fixtures/federal-register-public-inspection.json', import.meta.url), 'utf8'));
const nowMs = Date.parse('2026-11-24T02:00:00Z'); // November 23 in New York
const from = '2026-10-25';
const through = '2026-11-23';

test('maps and deduplicates live document rows, filtering routine notices and validating source links', () => {
  const badLinks = fixture.results.map((row: { html_url: string }) => ({
    ...row, html_url: row.html_url.replace('www.federalregister.gov', 'bad.example'),
  }));
  const items = mapFederalRegisterDocuments([...badLinks, ...fixture.results, ...fixture.results, null, {}], from, through);
  assert.deepEqual(items.map(({ id, topic, type }) => [id, topic, type]), [
    ['2026-23785', 'sanctions', 'Notice'],
    ['2026-23529', 'export-control', 'Rule'],
    ['2026-23349', 'other', 'Determination'],
    ['2026-23348', 'other', 'Proclamation'],
    ['2026-22385', 'tariff', 'Proclamation'],
    ['2026-22051', 'other', 'Executive Order'],
  ]);
  assert.deepEqual(items.find(({ id }) => id === '2026-23529')?.countries, ['BR', 'ID', 'MO', 'MY', 'SG', 'TH', 'US']);
  assert.deepEqual(mapFederalRegisterDocuments(fixture.results, '2026-11-24', '2026-11-30'), []);
});

test('queries presidential and selected agency records, reads another page, and accepts a zero-count response', async () => {
  const calls: URL[] = [];
  const data = await fetchFederalRegister({ nowMs, fetchImpl: async (url: URL, init: RequestInit) => {
    calls.push(url);
    assert.equal(url.origin, 'https://www.federalregister.gov');
    assert.ok(new Headers(init.headers).get('user-agent'));
    if (url.pathname === '/api/v1/public-inspection-documents/current.json') return Response.json(inspection.current);
    assert.equal(url.pathname, '/api/v1/documents.json');
    assert.equal(url.searchParams.get('conditions[publication_date][gte]'), from);
    assert.equal(url.searchParams.get('conditions[publication_date][lte]'), through);
    assert.equal(url.searchParams.get('order'), 'newest');
    assert.ok(url.searchParams.getAll('fields[]').includes('subtype'));
    const types = url.searchParams.getAll('conditions[type][]');
    if (types.includes('PRESDOCU')) return Response.json({ count: 0 });
    assert.deepEqual(types, ['RULE', 'PRORULE', 'NOTICE']);
    assert.ok(url.searchParams.getAll('conditions[agencies][]').includes('industry-and-security-bureau'));
    if (url.searchParams.get('page') === '1') return Response.json({ results: fixture.results.slice(0, 2), next_page_url: 'https://untrusted.example/' });
    return Response.json({ results: fixture.results.slice(2, 3) });
  } });
  assert.equal(calls.length, 4);
  assert.equal(data.asOf, nowMs);
  assert.deepEqual(data.items.map(({ id }) => id), ['2026-23999', '2026-23939', '2026-23908', '2026-23785', '2026-23529']);
});

test('uses the same topics and country mentions for regular and special public-inspection filings', () => {
  const [special, regular, ...other] = inspection.current.results;
  const invalidUrl = { ...special, html_url: special.html_url.replace('www.federalregister.gov', 'bad.example') };
  const wrongDoc = { ...regular, html_url: special.html_url };
  const futureFiling = { ...special, filed_at: '2026-11-25T00:00:00Z' };
  const inputs = [invalidUrl, wrongDoc, futureFiling, special, regular, ...other, ...inspection.current.results];
  const items = mapFederalRegisterDocuments([], from, through, inputs, nowMs);
  assert.deepEqual(items.map(({ id, date, topic, countries }) => [id, date, topic, countries]), [
    ['2026-23999', '2026-11-25', 'export-control', []],
    ['2026-23939', '2026-11-24', 'tariff', ['CN']],
    ['2026-23908', '2026-11-24', 'sanctions', []],
  ]);
  assert.equal(items[0]?.filedAt, Date.parse(special.filed_at));
  assert.equal(items[1]?.filedAt, Date.parse(regular.filed_at));
  assert.equal(items[0]?.url, special.html_url);
  const presidential = mapFederalRegisterDocuments([], '2026-10-01', '2026-10-30', inspection.presidential, Date.parse('2026-10-31T01:00:00Z'));
  assert.deepEqual(presidential.map(({ type, topic }) => [type, topic]), [['Proclamation', 'tariff']]);
  const order = mapFederalRegisterDocuments([], '2026-10-01', '2026-10-27', inspection.presidential, Date.parse('2026-10-28T01:00:00Z'));
  assert.deepEqual(order.map(({ type, topic }) => [type, topic]), [['Executive Order', 'other']]);
});

test('replaces a preview on publication, including when the title changes', () => {
  const [, preview] = inspection.current.results;
  const published = {
    ...preview, title: 'Final Determination on Antidumping Duties on Vehicle Tires from China',
    filing_type: undefined, filed_at: undefined,
    html_url: `https://www.federalregister.gov/documents/2026/11/24/${preview.document_number}/final-determination`,
  };
  const nextDay = Date.parse('2026-11-24T16:00:00Z');
  const [item, ...remaining] = mapFederalRegisterDocuments([published], from, '2026-11-24', [preview], nextDay);
  assert.equal(remaining.length, 0);
  assert.equal(item?.id, preview.document_number);
  assert.equal(item?.title, published.title);
  assert.equal(item?.url, published.html_url);
  assert.equal(item?.filedAt, undefined);
  assert.deepEqual(mapFederalRegisterDocuments([], from, '2026-11-25', [preview], nextDay), []);
  assert.deepEqual(mapFederalRegisterDocuments([{ ...published, title: 'Agency Information Collection Activities' }], from, '2026-11-24', [preview], nextDay), []);
});

test('rejects a failed or malformed upstream response', async () => {
  await assert.rejects(fetchFederalRegister({ nowMs, fetchImpl: async () => new Response(null, { status: 503 }) }), /HTTP 503/);
  await assert.rejects(fetchFederalRegister({ nowMs, fetchImpl: async () => Response.json({ count: 1 }) }), /document results/);
  await assert.rejects(fetchFederalRegister({
    nowMs,
    fetchImpl: async (url: URL) => Response.json(url.pathname.endsWith('current.json') ? {} : { results: [] }),
  }), /public inspection results/);
});

test('registers the personal cadence, cache and health metadata and reads the on-demand API value', async (t) => {
  assert.ok(DEFAULT_COLLECTORS.includes('federal-register'));
  assert.equal(STANDALONE_INTERVAL_MIN['federal-register'], 60);
  assert.equal(BOOTSTRAP_CACHE_KEYS.federalRegister, 'policy:federal-register:v1');
  assert.ok(bootstrapTierKeyNames('on-demand').includes('federalRegister'));
  assert.equal(health.STANDALONE_KEYS.federalRegister, BOOTSTRAP_CACHE_KEYS.federalRegister);
  assert.equal(health.SEED_META.federalRegister.key, 'seed-meta:policy:federal-register');
  assert.equal(health.SEED_META.federalRegister.maxStaleMin, 180);
  assert.equal(health.ACTIVATION_MARKERS.federalRegister, 'seed-activated:policy:federal-register');
  assert.ok(health.ON_DEMAND_KEYS.has('federalRegister'));

  const items = mapFederalRegisterDocuments(fixture.results, from, through, inspection.current.results, nowMs);
  const fetch = t.mock.method(globalThis, 'fetch');
  fetch.mock.mockImplementationOnce(async () => Response.json({
    data: { federalRegister: { asOf: nowMs, items: [
      ...items, null, { ...items[0], date: 'unknown' }, { ...items[0], url: 'javascript:void(0)' },
      { ...items[0], url: 'https://www.federalregister.gov/public-inspection/2026-99999/wrong' },
      { ...items[0], filedAt: 'pending' },
    ] } },
  }));
  fetch.mock.mockImplementationOnce(async () => Response.json({ data: {}, missing: ['federalRegister'] }), 1);
  assert.deepEqual(await loadFederalRegister(), items);
  assert.match(String(fetch.mock.calls[0]?.arguments[0]), /\/api\/bootstrap\?keys=federalRegister&public=1$/);
  assert.deepEqual(await loadFederalRegister(), []);
});
