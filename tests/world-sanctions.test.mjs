import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import rulesFile from '../shared/world-sanctions-issuers.json' with { type: 'json' };
import {
  combineSanctionSources, countOpenSanctionsPairs, countUkSanctionsPairs, countUnSanctionsPairs,
  normalizeTargetCountries, resolveSanctionIssuers, skipFirstLine, ukCheckDue,
} from '../scripts/_world-sanctions.mjs';

const RULES = rulesFile.rules;
const NOW = Date.parse('2026-11-22T00:00:00Z');
const DAY = 86_400_000;
const OS_HEADER = '"id","schema","name","aliases","birth_date","countries","addresses","identifiers","sanctions","phones","emails","program_ids","dataset","first_seen","last_seen","last_change"';
const csvRow = (id, countries, dataset, name = 'A, "quoted"\r\nname') => [id, 'Thing', name, 'alias', '', countries, '', '', '', '', '', '', dataset, '', '', ''].map((v) => `"${String(v).replaceAll('"', '""')}"`).join(',');
const OS_CSV = `${OS_HEADER}\n${[
  csvRow('A', 'ru', 'US OFAC Specially Designated Nationals (SDN) List;US Trade Consolidated Screening List (CSL)'),
  csvRow('B', 'ru;by', 'EU Council Official Journal Sanctioned Entities;EU Sanctions Map;Switzerland SECO Sanctions/Embargoes'),
  csvRow('C', 'ua', 'Ukraine NSDC State Register of Sanctions'),
  csvRow('D', 'kp', 'Some Unknown Watchlist'),
  csvRow('E', 'suhh;ir', 'UK FCDO Sanctions List;UN Security Council Consolidated List'),
].join('\n')}`;
const UK_CSV = 'Report Date: 20-Nov-2026\nUnique ID,Name 6,Regime Name,Address Country,Nationality(/ies)\nRUS0001,One,The Russia (Sanctions) (EU Exit) Regulations 2019,,\nRUS0001,One alias,The Russia (Sanctions) (EU Exit) Regulations 2019,,\nGHR0001,Two,The Global Human Rights Sanctions Regulations 2020,,Saudi Arabia\nAFG0001,Three,The Afghanistan (Sanctions) (EU Exit) Regulations 2020,,\n';
const UN_XML = `<?xml version="1.0"?><CONSOLIDATED_LIST><INDIVIDUAL><NATIONALITY><VALUE>Democratic People's Republic of Korea</VALUE></NATIONALITY></INDIVIDUAL><INDIVIDUAL><NATIONALITY><VALUE>Iraq</VALUE></NATIONALITY></INDIVIDUAL><ENTITY><ENTITY_ADDRESS><COUNTRY>Libya</COUNTRY></ENTITY_ADDRESS></ENTITY></CONSOLIDATED_LIST>`;
const chunked = (text, size) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
const os = { source: 'opensanctions', rows: 9000, unmappedDatasets: {}, issuerTotals: { UN: 1100, GB: 2000 }, pairs: { 'US>RU': 812, 'EU>RU': 640, 'GB>RU': 400, 'UN>KP': 151, 'US>CU': 4 } };
const un = { source: 'un', rows: 1000, unmappedDatasets: {}, issuerTotals: { UN: 1000 }, pairs: { 'UN>KP': 150 } };
const uk = { source: 'uk', rows: 2100, unmappedDatasets: {}, issuerTotals: { GB: 2100 }, pairs: { 'GB>RU': 410, 'GB>IR': 12 } };

test('resolves issuers from list titles in rule order', () => {
  assert.deepEqual(resolveSanctionIssuers('US OFAC Specially Designated Nationals (SDN) List;US Trade Consolidated Screening List (CSL)', RULES), ['US']);
  assert.deepEqual(resolveSanctionIssuers('EU Council Official Journal Sanctioned Entities;EU Sanctions Map;Switzerland SECO Sanctions/Embargoes', RULES), ['EU', 'CH']);
  assert.deepEqual(resolveSanctionIssuers('Interpol Red Notices', RULES), []);
});

test('normalizes target countries to ISO2 and drops non-ISO codes', () => assert.deepEqual(normalizeTargetCountries('ru;ua;suhh;'), ['RU', 'UA']));

test('counts OpenSanctions pairs identically for any chunking and line ending', async () => {
  const expected = { rows: 5, pairs: { 'US>RU': 1, 'EU>RU': 1, 'EU>BY': 1, 'CH>RU': 1, 'CH>BY': 1, 'GB>IR': 1, 'UN>IR': 1 }, issuerTotals: { US: 1, EU: 1, CH: 1, UA: 1, GB: 1, UN: 1 }, unmappedDatasets: { 'Some Unknown Watchlist': 1 } };
  for (const text of [OS_CSV, OS_CSV.replaceAll('\n', '\r\n')]) for (const size of [1, 7, text.length]) {
    const got = await countOpenSanctionsPairs(Readable.from(chunked(text, size)), RULES);
    assert.deepEqual({ rows: got.rows, pairs: got.pairs, issuerTotals: got.issuerTotals, unmappedDatasets: got.unmappedDatasets }, expected);
  }
});

test('skips the UK preamble line across chunk boundaries and de-duplicates aliases by Unique ID', async () => {
  for (const size of [1, 7, UK_CSV.length]) {
    const got = await countUkSanctionsPairs(Readable.from(chunked(UK_CSV, size)));
    assert.equal(got.rows, 3);
    assert.deepEqual(got.pairs, { 'GB>RU': 1, 'GB>SA': 1, 'GB>AF': 1 });
  }
});

test('skipFirstLine works when the line break spans chunks', async () => {
  assert.equal((await Array.fromAsync(skipFirstLine(Readable.from(['prefix', '\nrest'])))).join(''), 'rest');
});

test('counts UN individuals by nationality and entities by address, with UN name aliases', async () => {
  const got = await countUnSanctionsPairs(Readable.from(chunked(UN_XML, 11)));
  assert.deepEqual(got.pairs, { 'UN>KP': 1, 'UN>IQ': 1, 'UN>LY': 1 });
  assert.equal(got.issuerTotals.UN, 3);
});

test('uses OpenSanctions when it arrived, drops pairs under 5 and records the UN cross-check', () => {
  const s = combineSanctionSources({ openSanctions: os, un, uk: null, previous: null, nowMs: NOW });
  assert.equal(s.source, 'opensanctions');
  assert.deepEqual(s.pairs.map((p) => `${p.issuer}>${p.target}:${p.count}`), ['US>RU:812', 'EU>RU:640', 'GB>RU:400', 'UN>KP:151']);
  assert.deepEqual(s.crossCheck.UN, { opensanctions: 1100, official: 1000, relDiff: 0.091, checkedAt: NOW });
  assert.equal(s.crossCheck.GB, undefined);
});

test('replaces only UN and GB with backups when OpenSanctions failed and last good is at most 7 days old', () => {
  const previous = combineSanctionSources({ openSanctions: os, un: null, uk: null, previous: null, nowMs: NOW - 3 * DAY });
  const s = combineSanctionSources({ openSanctions: null, un, uk, previous, nowMs: NOW });
  assert.equal(s.source, 'backup+last-good');
  assert.equal(s.openSanctionsAsOf, NOW - 3 * DAY);
  assert.deepEqual(s.pairs.map((p) => `${p.issuer}>${p.target}:${p.count}`), ['US>RU:812', 'EU>RU:640', 'GB>RU:410', 'UN>KP:150', 'GB>IR:12']);
});

test('keeps last good untouched when every source failed', () => {
  const previous = combineSanctionSources({ openSanctions: os, un: null, uk: null, previous: null, nowMs: NOW - DAY });
  assert.equal(combineSanctionSources({ openSanctions: null, un: null, uk: null, previous, nowMs: NOW }).source, 'last-good');
});

test('falls back to backups alone when last good is older than 7 days, and throws when nothing is usable', () => {
  const previous = combineSanctionSources({ openSanctions: os, un: null, uk: null, previous: null, nowMs: NOW - 8 * DAY });
  const s = combineSanctionSources({ openSanctions: null, un, uk, previous, nowMs: NOW });
  assert.equal(s.source, 'backup');
  assert.deepEqual(s.pairs.map((p) => p.issuer).sort(), ['GB', 'GB', 'UN']);
  assert.throws(() => combineSanctionSources({ openSanctions: null, un: null, uk: null, previous: null, nowMs: NOW }), (e) => /no sanctions source/.test(e.message) && e.nonRetryable === true);
});

test('fetches the UK list weekly for the cross-check, and always when OpenSanctions failed', () => {
  assert.equal(ukCheckDue(null, NOW, true), true);
  const checked = { crossCheck: { GB: { checkedAt: NOW - 6 * DAY } } };
  assert.equal(ukCheckDue(checked, NOW, true), false);
  assert.equal(ukCheckDue(checked, NOW, false), true);
  assert.equal(ukCheckDue({ crossCheck: { GB: { checkedAt: NOW - 7 * DAY } } }, NOW, true), true);
});
