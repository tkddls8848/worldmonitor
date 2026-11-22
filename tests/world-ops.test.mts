import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorldOverviewSnapshot } from '../shared/world-overview.js';
import type { BreakingAlert } from '../src/services/breaking-news-alerts';
import { buildOpsEvents, computeOpsMetrics, THREAT_LEVEL_LABEL_KO } from '../src/services/world-ops';
import type { ThreatLevel } from '../src/types/world-overview';

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
  const outages = [{ id: 'active', iso2: 'KR', start: nowMs - 1000, end: null, severity: 'high', signals: ['BGP'], url: 'https://ioda.example/1' }, { id: 'recent', iso2: 'KR', start: nowMs - 9000, end: nowMs - 1000, severity: 'medium', signals: ['ping'], url: 'https://ioda.example/2' }, { id: 'stale', iso2: 'KR', start: nowMs - 8 * 60 * 60 * 1000, end: nowMs - 7 * 60 * 60 * 1000, severity: 'low', signals: ['ping'], url: 'https://ioda.example/3' }] as never;
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

test('does not include AI relations from another KST day and supports a missing snapshot', () => {
  const data = snapshot({ ai: { status: 'ok', date: '2026-11-21', model: 'test' } });
  assert.deepEqual(buildOpsEvents(data, [], nowMs), []);
  assert.deepEqual(buildOpsEvents(null, [], nowMs), []);
});
