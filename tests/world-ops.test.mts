import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorldOverviewSnapshot } from '../shared/world-overview.js';
import type { BreakingAlert } from '../src/services/breaking-news-alerts';
import { buildOpsEvents, computeOpsMetrics, THREAT_LEVEL_LABEL_KO } from '../src/services/world-ops';
import type { FederalRegisterDocument, ThreatLevel } from '../src/types/world-overview';

const nowMs = Date.parse('2026-11-22T03:00:00Z');

function snapshot(overrides: Partial<WorldOverviewSnapshot> = {}): WorldOverviewSnapshot {
  return {
    schemaVersion: 1,
    date: '2026-11-22',
    generatedAt: nowMs,
    countries: {},
    relations: [],
    blocs: [],
    anchors: {},
    ai: { status: 'ok', date: '2026-11-22', model: 'test' },
    inputs: {
      relations: { status: 'ok', asOf: nowMs }, trends: { status: 'ok', asOf: nowMs },
      ai: { status: 'ok', asOf: nowMs }, ucdp: { status: 'ok', asOf: nowMs },
      hapi: { status: 'ok', asOf: nowMs }, cii: { status: 'ok', asOf: nowMs },
      news: { status: 'ok', asOf: nowMs },
    },
    availableDates: ['2026-11-22'],
    ...overrides,
  };
}

function alert(id: string, timestamp: number, threatLevel: 'critical' | 'high' = 'high'): BreakingAlert {
  return {
    id, headline: `Alert ${id}`, source: 'test', link: `https://example.com/${id}`,
    threatLevel, timestamp: new Date(timestamp), origin: 'rss_alert',
    corroboration: { status: 'unverified', sources: [] },
  } as unknown as BreakingAlert;
}

function relation(overrides: Record<string, unknown>) {
  return {
    id: 'r1', origin: 'fixed', kind: 'tension', field: 'geopolitics',
    from: 'US', to: 'CN', directed: false, score: 1, value: 1, label: '미중 긴장',
    sources: [], trend: null, ...overrides,
  };
}

test('computes counters from the complete snapshot and applies threat score thresholds', () => {
  const data = snapshot({
    countries: {
      UA: { level: 'war', deaths: null, cii: null, demonstrations: null, unrest: false, blocs: [], inNews: false, issue: null },
      SD: { level: 'high', deaths: null, cii: null, demonstrations: null, unrest: false, blocs: [], inNews: false, issue: null },
    },
    relations: [
      relation({ id: 's1', kind: 'sanction', trend: { state: 'rising' } }),
      relation({ id: 's2', kind: 'sanction', trend: { state: 'surging' }, origin: 'ai' }),
      ...Array.from({ length: 30 }, (_, i) => relation({ id: `extra-${i}` })),
    ] as WorldOverviewSnapshot['relations'],
  });
  // Counted per country: KR twice (one corroborated) + JP corroborated = 2; telescope-only and stale entries are ignored.
  const outages = [{ id: 'active', iso2: 'KR', start: nowMs - 1000, end: null, severity: 'high', signals: ['bgp'], url: 'https://ioda.example/1' }, { id: 'recent', iso2: 'KR', start: nowMs - 9000, end: nowMs - 1000, severity: 'medium', signals: ['ping-slash24'], url: 'https://ioda.example/2' }, { id: 'jp', iso2: 'JP', start: nowMs - 9000, end: nowMs - 2000, severity: 'medium', signals: ['gtr'], url: 'https://ioda.example/4' }, { id: 'telescope', iso2: 'BR', start: nowMs - 500, end: null, severity: 'medium', signals: ['merit-nt'], url: 'https://ioda.example/5' }, { id: 'stale', iso2: 'FR', start: nowMs - 8 * 60 * 60 * 1000, end: nowMs - 7 * 60 * 60 * 1000, severity: 'low', signals: ['bgp'], url: 'https://ioda.example/3' }] as never;
  const metrics = computeOpsMetrics(data, [nowMs, nowMs - 24 * 60 * 60 * 1000, nowMs - 24 * 60 * 60 * 1000 - 1, nowMs + 1], nowMs, outages);
  assert.deepEqual(metrics.counters, {
    wars: 1, highConflicts: 1, worsening: 2, sanctionPairs: 2, aiRelations: 1, breaking24h: 2, outages: 2,
  });
  assert.equal(metrics.threatScore, 13.4);
  assert.equal(metrics.threatLevel, 5);
  assert.deepEqual(Object.keys(THREAT_LEVEL_LABEL_KO).map(Number), [1, 2, 3, 4, 5]);
});

test('caps threat score and maps all score bands to threat levels', () => {
  const levels: Array<[number, ThreatLevel]> = [[0, 5], [2, 5], [3, 4], [5, 3], [8, 2], [10, 1]];
  for (const [wars, level] of levels) {
    const result = computeOpsMetrics(snapshot({
      countries: Object.fromEntries(Array.from({ length: wars }, (_, i) => [`C${i}`, {
        level: 'war', deaths: null, cii: null, demonstrations: null, unrest: false, blocs: [], inNews: false, issue: null,
      }])) as WorldOverviewSnapshot['countries'],
    }), [], nowMs);
    assert.equal(result.threatLevel, level);
  }
  const capped = computeOpsMetrics(snapshot({
    countries: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`W${i}`, {
      level: 'war', deaths: null, cii: null, demonstrations: null, unrest: false, blocs: [], inNews: false, issue: null,
    }])) as WorldOverviewSnapshot['countries'],
  }), [], nowMs);
  assert.equal(capped.threatScore, 100);
  assert.equal(capped.threatLevel, 1);
});

test('builds stable, newest-first events with source links and caps the log at 50', () => {
  const data = snapshot({
    relations: [
      relation({ id: 'ai-tension', origin: 'ai', kind: 'tension', sources: [{ url: 'https://example.com/relation', title: 'source', publisher: 'test' }] }),
      relation({ id: 'ai-support', origin: 'ai', kind: 'support' }),
      relation({ id: 'fixed', origin: 'fixed' }),
    ] as WorldOverviewSnapshot['relations'],
    countries: {
      KR: { level: null, deaths: null, cii: null, demonstrations: null, unrest: false, blocs: [], inNews: false,
        issue: { summaryKo: '시위 발생', fields: ['politics'], sources: [{ url: 'https://example.com/issue', title: 'source', publisher: 'test' }] } },
    },
  });
  const alerts = [alert('critical', nowMs + 1000, 'critical'), alert('high', nowMs - 1000)];
  const outages = [{ id: 'stable-1', iso2: 'KR', start: nowMs - 5000, end: null, severity: 'high', signals: ['BGP', 'ping'], url: 'https://ioda.example/1' }] as never;
  const events = buildOpsEvents(data, alerts, nowMs, { outages });
  assert.deepEqual(events.map((event) => event.id), [
    'wm:breaking-news:critical', 'world-overview:issue:2026-11-22:KR',
    'world-overview:relation:ai-support', 'world-overview:relation:ai-tension', 'wm:breaking-news:high', 'ioda:outage:stable-1',
  ]);
  assert.equal(events[0]?.severity, 'critical');
  assert.equal(events[5]?.kind, 'outage');
  assert.equal(events[5]?.title, '인터넷 차단 · 대한민국 (BGP, ping)');
  assert.equal(events[5]?.url, 'https://ioda.example/1');
  assert.equal(events[3]?.severity, 'high');
  assert.equal(events[2]?.severity, 'medium');
  assert.equal(events[3]?.url, 'https://example.com/relation');
  assert.equal(events[1]?.url, 'https://example.com/issue');
  assert.deepEqual(buildOpsEvents(data, alerts, nowMs, { outages }), events);
  assert.equal(buildOpsEvents(null, Array.from({ length: 60 }, (_, i) => alert(String(i), nowMs + i)), nowMs).length, 50);
});

test('keeps trade and sanctions actions and executive orders in a busy log', () => {
  const base: FederalRegisterDocument = {
    id: 'tariff', title: 'Import adjustment', date: '2026-11-21', topic: 'tariff', type: 'Proclamation',
    countries: ['CN', 'US'], url: 'https://www.federalregister.gov/documents/example',
  };
  const federalRegister: FederalRegisterDocument[] = [
    base,
    { ...base, id: 'sanctions', topic: 'sanctions', type: 'Notice' },
    { ...base, id: 'export', topic: 'export-control', type: 'Rule' },
    { ...base, id: 'order', topic: 'other', type: 'Executive Order', countries: [] },
    { ...base, id: 'ignored', topic: 'defense', type: 'Determination' },
  ];
  const events = buildOpsEvents(null, Array.from({ length: 60 }, (_, i) => alert(String(i), nowMs + i)), nowMs, { federalRegister });
  assert.equal(events.length, 50);
  const policy = events.filter((event) => event.kind === 'federal-register');
  assert.deepEqual(policy.map((event) => event.id), ['export', 'order', 'sanctions', 'tariff'].map((id) => `federal-register:${id}`));
  assert.deepEqual(policy.map((event) => event.iso2), ['CN', undefined, 'CN', 'CN']);
});

test('orders public-inspection alerts by filing time and keeps published entries in a busy queue', () => {
  const published: FederalRegisterDocument[] = Array.from({ length: 6 }, (_, i) => ({
    id: `published-${i}`, date: '2026-11-22', title: 'Tariff decision', type: 'Rule',
    topic: 'tariff', countries: ['CN'], url: 'https://www.federalregister.gov/documents/example',
  }));
  const previews: FederalRegisterDocument[] = Array.from({ length: 10 }, (_, i) => ({
    id: `preview-${i}`, date: '2026-11-23', filedAt: nowMs - i - 1,
    title: 'Financial notice', type: 'Notice', topic: 'monetary/financial', countries: [],
    url: 'https://www.federalregister.gov/public-inspection/example',
  }));
  const events = buildOpsEvents(null, [alert('latest', nowMs)], nowMs, { federalRegister: [...previews, ...published] });
  assert.equal(events[0]?.id, 'wm:breaking-news:latest');
  assert.equal(events[1]?.at, previews[0]?.filedAt);
  assert.equal(events[1]?.scheduledPublicationDate, '2026-11-23');
  assert.equal(events.filter((event) => event.scheduledPublicationDate).length, 4);
  assert.equal(events.filter((event) => event.kind === 'federal-register' && !event.scheduledPublicationDate).length, 4);
  assert.equal(buildOpsEvents(null, [], nowMs, { federalRegister: previews }).length, 8);
  assert.equal(buildOpsEvents(null, [], nowMs, { federalRegister: published }).length, 6);
});

test('does not include AI relations from another KST day and supports a missing snapshot', () => {
  const data = snapshot({ ai: { status: 'ok', date: '2026-11-21', model: 'test' } });
  assert.deepEqual(buildOpsEvents(data, [], nowMs), []);
  assert.deepEqual(buildOpsEvents(null, [], nowMs), []);
});

test('adds stable Korean DART events with severity and a 15-filing limit', () => {
  const filings = Array.from({ length: 18 }, (_, i) => ({ id: `f${i}`, at: nowMs + i, corpName: `회사${i}`, stockCode: null, market: 'KOSPI' as const, kind: i % 2 ? 'ownership' as const : 'major' as const, title: '공시', filer: '', url: `https://dart.example/${i}` }));
  const events = buildOpsEvents(null, [], nowMs, { disclosures: filings });
  assert.equal(events.length, 15);
  assert.equal(events[0]?.id, 'dart:f17');
  assert.equal(events[0]?.kind, 'disclosure');
  assert.equal(events[0]?.severity, 'low');
  assert.equal(events.find((event) => event.id === 'dart:f16')?.severity, 'medium');
  assert.equal(events[0]?.title, '회사17 · 공시');
  assert.equal(events[0]?.iso2, 'KR');
});
