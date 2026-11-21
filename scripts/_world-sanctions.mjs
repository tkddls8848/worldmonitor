import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Papa from 'papaparse';
import sax from 'sax';
import { resolveIso2 } from './_country-resolver.mjs';

const OPENSANCTIONS_URL = 'https://data.opensanctions.org/datasets/latest/sanctions/targets.simple.csv';
const UN_SANCTIONS_URL = 'https://scsanctions.un.org/resources/xml/en/consolidated.xml';
const UK_SANCTIONS_URL = 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv';
export const SANCTION_SOURCE_URLS = { opensanctions: OPENSANCTIONS_URL, un: UN_SANCTIONS_URL, uk: UK_SANCTIONS_URL };
export const SANCTION_PAIR_MIN_COUNT = 5;
export const SANCTION_PAIR_LIMIT = 300;
const WEEK_MS = 7 * 86_400_000;

export function resolveSanctionIssuers(datasetField, rules) {
  const titles = String(datasetField || '').split(';').map((x) => x.trim()).filter(Boolean);
  const issuers = new Set();
  for (const title of titles) {
    for (const rule of rules) {
      if (new RegExp(rule.pattern).test(title)) { issuers.add(rule.issuer); break; }
    }
  }
  return [...issuers];
}

export function normalizeTargetCountries(countriesField) {
  return [...new Set(String(countriesField || '').split(';').map((name) => {
    const token = name.trim();
    return /^[A-Za-z]{2}$/.test(token) ? resolveIso2({ iso2: token }) : resolveIso2({ name: token });
  }).filter(Boolean))];
}

export async function* skipFirstLine(input) {
  let skipping = true;
  for await (const chunk of input) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (!skipping) { yield text; continue; }
    const newline = text.indexOf('\n');
    if (newline < 0) continue;
    skipping = false;
    yield text.slice(newline + 1);
  }
}

function newCount(source) {
  return { source, rows: 0, issuerTotals: {}, pairs: {}, unmappedDatasets: {} };
}
function record(count, issuer, target) {
  if (!issuer || !target || issuer === target) return;
  count.issuerTotals[issuer] = (count.issuerTotals[issuer] || 0) + 1;
  const key = `${issuer}>${target}`;
  count.pairs[key] = (count.pairs[key] || 0) + 1;
}
async function* csvRows(input) {
  const parser = Papa.parse(Papa.NODE_STREAM_INPUT, { header: true, skipEmptyLines: true });
  const finished = pipeline(Readable.from(input), parser);
  try {
    for await (const row of parser) yield row;
    await finished;
  } catch (error) {
    await finished.catch(() => {});
    throw error;
  }
}

export async function countOpenSanctionsPairs(input, rules) {
  const count = newCount('opensanctions');
  for await (const row of csvRows(input)) {
    count.rows++;
    const issuers = resolveSanctionIssuers(row.dataset, rules);
    if (!issuers.length) {
      const title = String(row.dataset || '').trim() || '(empty)';
      count.unmappedDatasets[title] = (count.unmappedDatasets[title] || 0) + 1;
    }
    const targets = normalizeTargetCountries(row.countries);
    for (const issuer of issuers) {
      count.issuerTotals[issuer] = (count.issuerTotals[issuer] || 0) + 1;
      for (const target of targets) {
        if (issuer === target) continue;
        const key = `${issuer}>${target}`;
        count.pairs[key] = (count.pairs[key] || 0) + 1;
      }
    }
  }
  return count;
}

export async function countUkSanctionsPairs(input) {
  const count = newCount('uk');
  const seen = new Set();
  const rows = csvRows(skipFirstLine(input));
  for await (const row of rows) {
    const id = String(row['Unique ID'] || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let target = null;
    const regime = String(row['Regime Name'] || '').match(/^The (.+?) \(Sanctions\)/i);
    if (regime) target = resolveIso2({ name: regime[1] });
    if (!target) target = String(row['Nationality(/ies)'] || '').split(';').map((name) => resolveIso2({ name: name.trim() })).find(Boolean);
    if (!target) target = resolveIso2({ name: row['Address Country'] });
    if (!target) continue;
    count.rows++;
    record(count, 'GB', target);
  }
  return count;
}

const UN_NAME_ALIASES = new Map([
  ["Democratic People's Republic of Korea", 'KP'], ['Iran (Islamic Republic of)', 'IR'],
  ['Syrian Arab Republic', 'SY'], ['Russian Federation', 'RU'], ["Lao People's Democratic Republic", 'LA'],
]);
const UN_LIST_TYPES = new Map([
  ['DPRK', 'KP'], ['Iran', 'IR'], ['Iraq', 'IQ'], ['Libya', 'LY'], ['Somalia', 'SO'],
  ['South Sudan', 'SS'], ['Sudan', 'SD'], ['DRC', 'CD'], ['CAR', 'CF'], ['Yemen', 'YE'],
  ['Mali', 'ML'], ['Haiti', 'HT'], ['Taliban', 'AF'],
]);
function resolveUnName(name) {
  const normalized = String(name || '').trim();
  return UN_NAME_ALIASES.get(normalized) || resolveIso2({ name: normalized });
}

export async function countUnSanctionsPairs(input) {
  const count = newCount('un');
  const parser = sax.createStream(true, { trim: true, normalize: true });
  let entity = null;
  let capture = null;
  let text = '';
  const stack = [];
  const targets = new Set();
  parser.on('opentag', (tag) => {
    stack.push(tag.name);
    if (tag.name === 'INDIVIDUAL' || tag.name === 'ENTITY') entity = { kind: tag.name, names: [], listType: '' };
    const relevant = tag.name === 'UN_LIST_TYPE'
      || (tag.name === 'VALUE' && entity?.kind === 'INDIVIDUAL' && stack.includes('NATIONALITY'))
      || (tag.name === 'COUNTRY' && entity?.kind === 'ENTITY' && stack.includes('ENTITY_ADDRESS'));
    if (entity && relevant) { capture = tag.name; text = ''; }
  });
  parser.on('text', (value) => { if (capture) text += value; });
  parser.on('cdata', (value) => { if (capture) text += value; });
  parser.on('closetag', (name) => {
    if (entity && capture === name) {
      const value = text.trim();
      if (name === 'UN_LIST_TYPE') entity.listType = value;
      else if (value) entity.names.push(value);
      capture = null;
    }
    if (entity && (name === 'INDIVIDUAL' || name === 'ENTITY')) {
      let target = entity.names.map(resolveUnName).find(Boolean);
      if (!target) target = UN_LIST_TYPES.get(entity.listType) || null;
      if (target) targets.add(target);
      entity = null;
    }
    stack.pop();
  });
  await new Promise((resolve, reject) => {
    parser.on('error', reject);
    parser.on('end', resolve);
    Readable.from(input).pipe(parser);
  });
  for (const target of targets) record(count, 'UN', target);
  count.rows = targets.size;
  return count;
}

function pairList(pairs) {
  return Object.entries(pairs || {}).map(([key, count]) => {
    const [issuer, target] = key.split('>');
    return { issuer, target, count };
  }).filter((p) => p.issuer && p.target && Number.isFinite(p.count) && p.count >= SANCTION_PAIR_MIN_COUNT)
    .sort((a, b) => b.count - a.count || a.issuer.localeCompare(b.issuer) || a.target.localeCompare(b.target))
    .slice(0, SANCTION_PAIR_LIMIT);
}
const issuerPairs = (pairs, issuers) => Object.fromEntries(Object.entries(pairs || {}).filter(([key]) => issuers.includes(key.split('>')[0])));
const mergePairs = (...sources) => {
  const merged = {};
  for (const pairs of sources) for (const [key, value] of Object.entries(pairs || {})) merged[key] = value;
  return merged;
};
function round3(value) { return Math.round(value * 1000) / 1000; }
function latestCrossCheck(previous, openSanctions, un, uk, nowMs) {
  const crossCheck = { ...(previous?.crossCheck || {}) };
  for (const [country, backup] of [['UN', un], ['GB', uk]]) {
    if (!openSanctions || !backup) continue;
    const official = backup.issuerTotals[country] || 0;
    const open = openSanctions.issuerTotals[country] || 0;
    crossCheck[country] = { opensanctions: open, official, relDiff: round3(Math.abs(open - official) / Math.max(open, official, 1)), checkedAt: nowMs };
  }
  return crossCheck;
}

export function ukCheckDue(previous, nowMs, openSanctionsOk) {
  if (!openSanctionsOk) return true;
  const checkedAt = previous?.crossCheck?.GB?.checkedAt;
  return !Number.isFinite(checkedAt) || nowMs - checkedAt >= WEEK_MS;
}

export function combineSanctionSources({ openSanctions, un, uk, previous, nowMs }) {
  let source;
  let openSanctionsPairs;
  let openSanctionsAsOf;
  let pairs;
  if (openSanctions) {
    source = 'opensanctions';
    openSanctionsPairs = pairList(openSanctions.pairs);
    openSanctionsAsOf = nowMs;
    pairs = openSanctions.pairs;
  } else {
    const hasRecent = Number.isFinite(previous?.openSanctionsAsOf) && nowMs - previous.openSanctionsAsOf <= WEEK_MS;
    openSanctionsPairs = hasRecent ? previous.openSanctionsPairs || [] : [];
    openSanctionsAsOf = hasRecent ? previous.openSanctionsAsOf : null;
    let old = Object.fromEntries(openSanctionsPairs.map(({ issuer, target, count }) => [`${issuer}>${target}`, count]));
    const backups = {};
    for (const [issuer, backup] of [['UN', un], ['GB', uk]]) {
      const fresh = backup ? issuerPairs(backup.pairs, [issuer]) : issuerPairs(old, [issuer]);
      Object.assign(backups, fresh);
    }
    pairs = mergePairs(issuerPairs(old, Object.keys(old).map((key) => key.split('>')[0]).filter((issuer) => !['UN', 'GB'].includes(issuer))), backups);
    if (hasRecent) source = un || uk ? 'backup+last-good' : 'last-good';
    else source = 'backup';
  }
  const result = pairList(pairs);
  if (!result.length) throw Object.assign(new Error('no sanctions source'), { nonRetryable: true });
  return {
    source, asOf: nowMs, openSanctionsAsOf, openSanctionsPairs,
    pairs: result, crossCheck: latestCrossCheck(previous, openSanctions, un, uk, nowMs),
    unmappedDatasets: Object.fromEntries(Object.entries(openSanctions?.unmappedDatasets || previous?.unmappedDatasets || {})
      .sort((a, b) => b[1] - a[1]).slice(0, 30)),
  };
}
