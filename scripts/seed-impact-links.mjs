#!/usr/bin/env node
/**
 * Embedded-store inventory (2026-11-27 UTC). Only dated attributable evidence contributes.
 *
 * Kind       | Input used                                             | Other inputs inspected
 * sanctions  | policy:federal-register:v1; sanctions:changes:v1       | sanctions:pressure:v1 and sanctions:country-counts:v1 are aggregate stocks. world-overview:relations:v1 has undated pair counts.
 * tariffs    | policy:federal-register:v1 (trade measures, AD/CVD)    | trade:tariffs:v2:842 absent. Trade barriers/restrictions are annual, customs revenue is monthly, and the U.S. HTS catalog release was Nov 10.
 * conflict   | conflict:ucdp-events:v1 (country-level event evidence) | Latest was Nov 5. ACLED cache absent. unrest:events:v1 held unverified mentions. News threat summary lacks actor attribution.
 * tension    | world-overview:ai:v1 (stored relations and citations)   | world-overview:relations:v1 has no dated tension events. News digest classifications alone lack attribution.
 * support    | world-overview:ai:v1 (explicit aid/pact citations)     | world-overview:relations:v1 has standing alliances. Verification dates do not date a new alliance.
 * energy     | energy:intelligence:feed:v1, energy:disruptions:v1, energy:fuel-shortages:v1 | Registry evidence dated April. energy:chokepoint-flows:v1 and supply_chain:transit-summaries:v1 lack country impact/actor attribution. Status and dependencies absent.
 * financial  | markets:treasury-auctions:v1, markets:funding-stress:v1 | CII score caches and military CII absent. CII priors and economic stress are contextual. China decision signals had no recent explicit stress or bilateral measures.
 *
 * Per-evidence points (heuristic significance, not measured impact): sanctions 8–18,
 * tariffs 5–12, conflict 10–25 by reported fatalities, tension 8–16 by confidence,
 * support 8–16 by confidence, energy 10–18 by evidence and severity, financial
 * 12 for weak auctions or 12–24 for funding spreads. Same-list sanctions additions
 * count once per target and effective day. Publications without a known release
 * time are bucketed at UTC midnight. Weight decays linearly to 50% at age 7d.
 * Magnitude is the rounded sum, capped at 100. Trend compares points in the
 * latest 24h to daily points over the previous 6d. No prior points means new
 * when recent evidence exists. ±25% marks rising/falling, otherwise steady.
 */
import { pathToFileURL } from 'node:url';
import countryNames from '../shared/country-name-to-iso2.cjs';
import iso3ToIso2 from '../shared/iso3-to-iso2.json' with { type: 'json' };
import { IMPACT_DAY_MS as DAY, IMPACT_LINKS_KEY, summarizeImpactLinks } from '../shared/impact-links.ts';
import { loadEnvFile, readCanonicalValue, runSeed } from './_seed-utils.mjs';
import { markActivated } from './_world-overview-io.mjs';

const KEYS = {
  federalRegister: 'policy:federal-register:v1',
  sanctionsChanges: 'sanctions:changes:v1',
  ucdp: 'conflict:ucdp-events:v1',
  relations: 'world-overview:ai:v1',
  energyNews: 'energy:intelligence:feed:v1',
  disruptions: 'energy:disruptions:v1',
  shortages: 'energy:fuel-shortages:v1',
  auctions: 'markets:treasury-auctions:v1',
  funding: 'markets:funding-stress:v1',
};
const COUNTRIES = new Set([...Object.values(iso3ToIso2), 'BQ', 'BV', 'CC', 'CX', 'GF', 'GP', 'MQ', 'RE', 'SJ', 'TK', 'YT']);
const BLOCS = new Set(['EU', 'UN', 'NATO']);
const KO = new Intl.DisplayNames('ko', { type: 'region' });
const LABELS = {
  sanctions: '제재·수출 통제', tariffs: '관세·무역 조치', conflict: '무력 분쟁',
  tension: '외교 긴장', support: '동맹·지원', energy: '에너지 공급 차질', financial: '금융 스트레스',
};
const rows = (value) => Array.isArray(value) ? value : [];
const country = (value) => {
  const iso2 = countryNames.countryNameToIso2(value);
  return COUNTRIES.has(iso2) ? iso2 : null;
};
const timestamp = (value) => {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  return /^\d{13}$/.test(value) ? Number(value) : Date.parse(value);
};
const text = (value, limit = 320) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
const within = (at, now) => Number.isSafeInteger(at) && at >= now - 7 * DAY && at <= now;
const safeUrl = (value) => {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
};

function federalRegister(payload, add) {
  for (const row of rows(payload?.items)) {
    const tariff = row?.topic === 'tariff';
    if (!tariff && !['sanctions', 'export-control'].includes(row?.topic)) continue;
    const title = text(row.title);
    // Exclude administrative timing notices, withdrawals and general licenses that relieve restrictions.
    if (/\b(?:general licen[cs]es?|revocations?|withdrawals?|rescissions?|extension of time|opportunity to request administrative review)\b/i.test(title)) continue;
    const preliminary = row.type !== 'Rule' && !/\bfinal\b/i.test(title);
    for (const target of rows(row.countries)) {
      if (country(target) === 'US') continue;
      add(tariff ? 'tariffs' : 'sanctions', 'US', target, tariff ? (preliminary ? 5 : 12) : (preliminary ? 8 : 15), {
        source: 'Federal Register', title, url: row.url, publishedAt: row.filedAt ?? row.date,
      }, { eventId: row.id, keepEarliest: true });
    }
  }
}

const SANCTIONS_LISTS = new Map([
  ['SDN', ['US', 'OFAC SDN', 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/sdn_advanced.xml']],
  ['sema-ca', ['CA', 'Global Affairs Canada', 'https://www.international.gc.ca/world-monde/international_relations-relations_internationales/sanctions/consolidated-consolide.aspx?lang=eng']],
]);

function sanctionsChanges(payload, add, now) {
  const batches = new Map();
  for (const row of rows(payload?.events)) {
    if (row?.op !== 'added' || !SANCTIONS_LISTS.has(row.list) || !row.id) continue;
    const publishedAt = timestamp(row.effectiveAt || row.at);
    if (!within(publishedAt, now)) continue;
    for (const raw of rows(row.cc)) {
      const target = country(raw);
      if (!target) continue;
      const day = Math.floor(publishedAt / DAY);
      const key = [row.list, target, day].join(':');
      if (!batches.has(key)) batches.set(key, { list: row.list, target, day, publishedAt, ids: new Set() });
      const batch = batches.get(key);
      batch.publishedAt = Math.max(batch.publishedAt, publishedAt);
      batch.ids.add(row.id);
    }
  }
  for (const { list, target, day, publishedAt, ids } of batches.values()) {
    const [actor, source, url] = SANCTIONS_LISTS.get(list);
    if (actor === target) continue;
    add('sanctions', actor, target, Math.min(18, 8 + 2 * Math.log2(ids.size)), {
      source, title: `${ids.size} list additions associated with ${target}`, url, publishedAt,
    }, { eventId: `${list}:${day}` });
  }
}

function conflict(payload, add, now) {
  for (const row of rows(payload?.events)) {
    if (!within(row?.dateEnd, now) || !/^\d+$/.test(row.id)) continue;
    const target = country(row.country);
    if (!target) continue;
    // Side order does not name the aggressor. Use the other state only when both
    // are explicitly identified and one is the country where the event occurred.
    const state = (side) => country(typeof side === 'string' ? side.match(/^Government of (.+)$/)?.[1] : null);
    const a = state(row.sideA);
    const b = state(row.sideB);
    const actor = (a === target && b) || (b === target && a) || target;
    const points = 10 + Math.min(15, 4 * Math.log2(1 + Math.max(0, Number(row.deathsBest) || 0)));
    add('conflict', actor, target, points, {
      source: 'UCDP', title: `Recorded armed conflict event in ${target} (UCDP ${row.id})`,
      url: 'https://ucdp.uu.se/downloads/', publishedAt: row.dateEnd,
    }, { eventId: row.id });
  }
}

function relations(payload, add) {
  if (payload?.status !== 'ok') return;
  for (const row of rows(payload.relations)) {
    if (!['tension', 'support', 'alliance'].includes(row?.kind) || !Number.isFinite(row.confidence) || row.confidence < 0.5) continue;
    const kind = row.kind === 'tension' ? 'tension' : 'support';
    for (const citation of rows(row.sources)) {
      const title = text(citation?.title);
      // A stored candidate still needs a citation that supports the classification.
      if (row.kind === 'alliance' && !/\b(?:new (?:pact|agreement)|sign(?:s|ed)?\b.{0,80}\b(?:pact|agreement|treaty))\b/i.test(title)) continue;
      if (row.kind === 'support' && (!row.directed || !/\b(?:provides?|sends?|pledges?|approves?|delivers?)\b.{0,90}\b(?:aid|support|assistance)\b/i.test(title))) continue;
      if (row.kind === 'tension' && !/\b(?:protest\w*|warn\w*|accus\w*|denounc\w*|condemn\w*|tensions?|dispute\w*|summons?|expels?|threat\w*)\b/i.test(title)) continue;
      const evidence = { source: citation.publisher, title, url: citation.url, publishedAt: citation.publishedAt };
      const options = { headline: /[가-힣]/.test(row.summaryKo) ? row.summaryKo : '' };
      const points = 16 * Math.min(1, row.confidence);
      add(kind, row.from, row.to, points, evidence, options);
      // Mirror mutual relations when the source names two countries.
      if (!row.directed) add(kind, row.to, row.from, points, evidence, options);
    }
  }
}

function energy(inputs, add, now) {
  for (const row of rows(inputs.energyNews?.items)) {
    const title = text(row?.title);
    const match = /^([\p{L} .’'-]{2,45}?) (?:delays?|suspends?|halts?|cuts?)\b.*\b(?:crude|oil|gas|fuel|power)\b.*\b(?:shipments?|exports|supplies|output|production|deliveries)\b/iu.exec(title);
    const target = country(match?.[1]);
    if (target) add('energy', target, target, 10, { ...row, title });
  }
  for (const row of Object.values(inputs.disruptions?.events ?? {})) {
    const [target, other] = rows(row?.countries);
    if (!target || other || timestamp(row.endAt) < now - 7 * DAY) continue;
    for (const source of rows(row.sources)) {
      if (source) add('energy', target, target, 16, { ...source, source: source.authority, publishedAt: source.date });
    }
  }
  for (const row of Object.values(inputs.shortages?.shortages ?? {})) {
    if (!row || row.resolvedAt || row.severity !== 'confirmed') continue;
    for (const source of rows(row.evidence?.evidenceSources)) {
      if (source) add('energy', row.country, row.country, 18, { ...source, source: source.authority, publishedAt: source.date });
    }
  }
}

function financial(inputs, add) {
  for (const row of rows(inputs.auctions?.coupons)) {
    if (row?.verdict !== 'weak') continue;
    const file = row.resultsFile;
    const url = typeof file === 'string' && /^R_\d{8}_\d+\.pdf$/.test(file)
      ? `https://fiscaldata.treasury.gov/static-data/published-reports/auctions-query/results/${file}`
      : 'https://fiscaldata.treasury.gov/datasets/treasury-securities-auctions-data/';
    add('financial', 'US', 'US', 12, {
      source: 'U.S. Treasury', title: `${text(row.term, 40)} Treasury auction: weak demand`, url, publishedAt: row.at,
    }, { eventId: row.cusip });
  }
  const { sofr, effr } = inputs.funding ?? {};
  if (!sofr?.date || sofr.date !== effr?.date || !Number.isFinite(sofr.rate) || !Number.isFinite(effr.rate)) return;
  const spreadBp = Math.round((sofr.rate - effr.rate) * 100);
  if (spreadBp >= 20) add('financial', 'US', 'US', Math.min(24, 12 + (spreadBp - 20) / 3), {
    source: 'New York Fed', title: `SOFR traded ${spreadBp} bp above EFFR`,
    url: 'https://www.newyorkfed.org/markets/reference-rates/sofr', publishedAt: sofr.date,
  });
}

/** Reduce stored source snapshots to a rolling, reproducible seven-day read model. */
export function buildImpactLinks(inputs, now, previous = []) {
  const observations = new Map();
  function add(kind, from, to, points, raw, options = {}) {
    const actor = BLOCS.has(from) ? from : country(from);
    const target = country(to);
    const publishedAt = timestamp(raw.publishedAt);
    const source = text(raw.source, 100);
    const title = text(raw.title);
    const url = safeUrl(raw.url);
    if (!actor || !target || !source || !title || !url || !within(publishedAt, now)) return;
    const id = `${kind}:${actor}:${target}`;
    const eventId = text(options.eventId, 128);
    const key = eventId ? `${id}|event|${eventId}` : `${id}|${url}|${publishedAt}`;
    const existing = observations.get(key);
    if (options.keepEarliest && existing && existing.evidence.publishedAt < publishedAt) return;
    observations.set(key, {
      id, actor, target, kind, points, eventId, headline: text(options.headline, 100),
      evidence: { source, title, url, publishedAt },
    });
  }

  // Carry citations across rotations of the existing daily relation/news cells.
  for (const row of rows(previous)) {
    if (Object.hasOwn(LABELS, row?.kind) && typeof row.eventId === 'string' && row.evidence && Number.isFinite(row.points)) {
      // The sanctions change ledger already covers the lookback and may revise a batch.
      if (row.kind === 'sanctions' && row.evidence.source !== 'Federal Register' && Array.isArray(inputs.sanctionsChanges?.events)) continue;
      add(row.kind, row.actor, row.target, row.points, row.evidence, row);
    }
  }
  federalRegister(inputs.federalRegister, add);
  sanctionsChanges(inputs.sanctionsChanges, add, now);
  conflict(inputs.ucdp, add, now);
  relations(inputs.relations, add);
  energy(inputs, add, now);
  financial(inputs, add);

  const groups = new Map();
  for (const row of observations.values()) {
    if (!groups.has(row.id)) groups.set(row.id, []);
    groups.get(row.id).push(row);
  }
  const links = [...groups.values()].map((group) => {
    group.sort((a, b) => b.evidence.publishedAt - a.evidence.publishedAt || a.evidence.url.localeCompare(b.evidence.url, 'en'));
    const [latest] = group;
    const { id, actor, target, kind } = latest;
    let points = 0;
    let recent = 0;
    let prior = 0;
    for (const row of group) {
      const age = now - row.evidence.publishedAt;
      points += row.points * (1 - age / (14 * DAY));
      if (age <= DAY) recent += row.points;
      else prior += row.points;
    }
    const baseline = prior / 6;
    const trend = !prior ? 'new' : recent > baseline * 1.25 ? 'rising' : recent < baseline * 0.75 ? 'falling' : 'steady';
    const label = actor === target ? KO.of(target) : `${BLOCS.has(actor) ? actor : KO.of(actor)} → ${KO.of(target)}`;
    return {
      id, actor, target, kind, magnitude: Math.min(100, Math.round(points)),
      direction: kind === 'support' ? 'support' : 'pressure',
      firstSeen: group.at(-1).evidence.publishedAt, lastSeen: latest.evidence.publishedAt,
      trend, headline: latest.headline || `${label} ${LABELS[kind]}`,
      evidence: [...new Map(group.map(({ evidence }) => [`${evidence.url}|${evidence.publishedAt}`, evidence])).values()].slice(0, 5),
    };
  });
  links.sort((a, b) => b.magnitude - a.magnitude || b.lastSeen - a.lastSeen || a.id.localeCompare(b.id, 'en'));
  return { generatedAt: now, links, summary: summarizeImpactLinks(links, now), observations: [...observations.values()] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFile(import.meta.url);
  await runSeed('world', 'impact-links', IMPACT_LINKS_KEY, async () => {
    const fetched = await Promise.all(Object.entries(KEYS).map(async ([name, key]) => [name, await readCanonicalValue(key, { strict: true })]));
    if (!fetched.some(([, value]) => value != null)) throw new Error('No impact-link inputs in the personal store');
    const previous = await readCanonicalValue(IMPACT_LINKS_KEY, { strict: true });
    return buildImpactLinks(Object.fromEntries(fetched), Date.now(), previous?.observations);
  }, {
    ttlSeconds: 10_800,
    declareRecords: (data) => data.links.length,
    schemaVersion: 1,
    sourceVersion: 'impact-links-v1',
    maxStaleMin: 90,
    zeroIsValid: true,
    afterFreshness: () => markActivated('seed-activated:world:impact-links'),
  });
}
