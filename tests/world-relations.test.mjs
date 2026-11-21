import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { bankClaimPairs, tradeDependencePairs } from '../scripts/_world-economic-pairs.mjs';
import { fetchWorldRelations } from '../scripts/seed-world-relations.mjs';
import iso3ToIso2 from '../shared/iso3-to-iso2.json' with { type: 'json' };
const ISO3 = Object.fromEntries(Object.entries(iso3ToIso2).map(([iso3, iso2]) => [iso2, iso3]));

test('alliance list holds treaty alliances with official sources', () => {
  const { bilateral, blocs } = JSON.parse(readFileSync('shared/world-alliances.json', 'utf8'));
  assert.deepEqual(bilateral.map((x) => x.id).sort(), ['cn-kp', 'ru-by', 'ru-kp', 'sa-pk', 'tr-az', 'us-au', 'us-jp', 'us-kr', 'us-ph', 'us-th']);
  for (const item of bilateral) {
    assert.notEqual(item.a, item.b);
    assert.ok(ISO3[item.a] && ISO3[item.b]);
    assert.match(item.source.url, /^https:\/\//);
    assert.match(item.nameKo, /[가-힣]/);
    assert.equal(item.verifiedAt, '2026-11-22');
  }
  assert.deepEqual(Object.fromEntries(blocs.map((bloc) => [bloc.id, bloc.members.length])), { nato: 32, csto: 6, sco: 10 });
});

test('ranks strategic-goods imports by exporter and maps Comtrade code 490 to Taiwan', () => {
  const { pairs, asOfYear } = tradeDependencePairs([{ iso2: 'KR', products: [
    { year: 2025, topExporters: [{ partnerCode: 682, partnerIso2: 'SA', value: 25740855840 }, { partnerCode: 842, partnerIso2: 'US', value: 12864504527 }] },
    { year: 2025, topExporters: [{ partnerCode: 490, partnerIso2: '', value: 24307492141 }, { partnerCode: 410, partnerIso2: 'KR', value: 5 }] },
    { year: 2024, topExporters: [{ partnerCode: 842, partnerIso2: 'US', value: 6281384484 }] },
  ] }], 40);
  assert.deepEqual(pairs, [
    { from: 'SA', to: 'KR', valueUsd: 25740855840 },
    { from: 'TW', to: 'KR', valueUsd: 24307492141 },
    { from: 'US', to: 'KR', valueUsd: 19145889011 },
  ]);
  assert.equal(asOfYear, 2025);
});

test('ranks bank claims in USD and skips domestic claims', () => {
  assert.deepEqual(bankClaimPairs({ AU: { parents: { JP: 155381.2, US: 143955, AU: 9 } }, AT: { parents: { IT: 86896.072 } } }, 20), [
    { from: 'JP', to: 'AU', valueUsd: 155381200000 },
    { from: 'US', to: 'AU', valueUsd: 143955000000 },
    { from: 'IT', to: 'AT', valueUsd: 86896072000 },
  ]);
});

test('publishes streamed OpenSanctions data with alliances and economic pairs', async () => {
  const headers = [];
  const csv = [
    '"id","schema","name","aliases","birth_date","countries","addresses","identifiers","sanctions","phones","emails","program_ids","dataset","first_seen","last_seen","last_change"',
    ...Array.from({ length: 6 }, (_, i) => `"${i}","Thing","Target ${i}","","","ru","","","","","","","US OFAC list","","",""`),
  ].join('\n');
  const xml = '<CONSOLIDATED_LIST><INDIVIDUAL><NATIONALITY><VALUE>Iraq</VALUE></NATIONALITY></INDIVIDUAL></CONSOLIDATED_LIST>';
  const fetchImpl = async (url, options) => {
    headers.push(options.headers);
    const body = url.includes('opensanctions') ? csv : url.includes('scsanctions') ? xml : '';
    return url.includes('sanctionslist.fcdo')
      ? new Response('', { status: 503 })
      : new Response(Readable.toWeb(Readable.from([body])), { status: 200 });
  };
  const NOW = Date.parse('2026-11-22T00:00:00Z');
  const payload = await fetchWorldRelations({ fetchImpl, readValue: async () => null, nowMs: NOW, deadlineAtMs: NOW + 300_000 });
  assert.deepEqual(payload.sanctions.pairs, [{ issuer: 'US', target: 'RU', count: 6 }]);
  assert.equal(payload.sanctions.source, 'opensanctions');
  assert.equal(payload.diagnostics.uk.ok, false);
  assert.equal(payload.alliances.bilateral.length, 10);
  assert.ok(headers.every((header) => header['User-Agent'] === 'WorldMonitor-Personal-Collect/1.0 (world-relations)'));
});

test('retains last good OpenSanctions issuers when a download breaks mid-stream', async () => {
  const NOW = Date.parse('2026-11-22T00:00:00Z');
  const previous = { sanctions: {
    source: 'opensanctions', asOf: NOW - 2 * 86_400_000, openSanctionsAsOf: NOW - 2 * 86_400_000,
    openSanctionsPairs: [{ issuer: 'US', target: 'RU', count: 812 }, { issuer: 'GB', target: 'RU', count: 400 }],
    pairs: [{ issuer: 'US', target: 'RU', count: 812 }, { issuer: 'GB', target: 'RU', count: 400 }], crossCheck: {}, unmappedDatasets: {},
  } };
  let brokenBodySent = false;
  const brokenBody = new ReadableStream({
    pull(controller) {
      if (!brokenBodySent) {
        brokenBodySent = true;
        controller.enqueue(new TextEncoder().encode('"id","schema","name","aliases","birth_date","countries","addresses","identifiers","sanctions","phones","emails","program_ids","dataset","first_seen","last_seen","last_change"\n'));
      } else controller.error(new Error('truncated export'));
    },
  });
  const fetchImpl = async (url) => {
    if (url.includes('opensanctions')) return new Response(brokenBody, { status: 200 });
    if (url.includes('scsanctions')) return new Response('<CONSOLIDATED_LIST><INDIVIDUAL><NATIONALITY><VALUE>Iraq</VALUE></NATIONALITY></INDIVIDUAL></CONSOLIDATED_LIST>');
    return new Response('Report Date: today\nUnique ID,Name 6,Regime Name,Address Country,Nationality(/ies)\nGHR1,Name,The Global Human Rights Sanctions Regulations 2020,,Saudi Arabia');
  };
  const payload = await fetchWorldRelations({ fetchImpl, readValue: async () => previous, nowMs: NOW, deadlineAtMs: NOW + 300_000 });
  assert.equal(payload.sanctions.source, 'backup+last-good');
  assert.ok(payload.sanctions.pairs.some((pair) => pair.issuer === 'US' && pair.target === 'RU' && pair.count === 812));
  assert.equal(payload.diagnostics.opensanctions.ok, false);
});
