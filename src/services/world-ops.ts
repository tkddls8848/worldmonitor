import type { WorldOverviewSnapshot } from '../../shared/world-overview.js';
import { kstDate } from '../../shared/world-overview.js';
import type { BreakingAlert } from '@/services/breaking-news-alerts';
import type { OpsCounters, OpsEvent, OpsMetrics, ThreatLevel } from '@/types/world-overview';

export const THREAT_LEVEL_LABEL_KO: Record<ThreatLevel, string> = {
  1: '최고 위기',
  2: '고위험',
  3: '경계',
  4: '주의',
  5: '평시',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function levelForScore(score: number): ThreatLevel {
  if (score >= 80) return 1;
  if (score >= 60) return 2;
  if (score >= 40) return 3;
  if (score >= 20) return 4;
  return 5;
}

export function computeOpsMetrics(
  snapshot: WorldOverviewSnapshot,
  breakingAlertTimes: readonly number[],
  nowMs: number,
): OpsMetrics {
  const countries = Object.values(snapshot.countries);
  const counters: OpsCounters = {
    wars: countries.filter((country) => country.level === 'war').length,
    highConflicts: countries.filter((country) => country.level === 'high').length,
    worsening: snapshot.relations.filter((relation) =>
      relation.trend?.state === 'rising' || relation.trend?.state === 'surging').length,
    sanctionPairs: snapshot.relations.filter((relation) => relation.kind === 'sanction').length,
    aiRelations: snapshot.relations.filter((relation) => relation.origin === 'ai').length,
    breaking24h: breakingAlertTimes.filter((at) => at >= nowMs - DAY_MS && at <= nowMs).length,
  };
  // Calibrated so the late-2026 baseline (4 wars, ~17 high-intensity conflicts) reads 고위험 (2), not saturated.
  const raw = Math.min(100,
    8 * counters.wars
      + 2 * counters.highConflicts
      + 1 * counters.worsening
      + 0.2 * counters.breaking24h
      + 0.02 * counters.sanctionPairs,
  );
  const threatScore = Math.round(raw * 10) / 10;
  return { threatLevel: levelForScore(threatScore), threatScore, counters };
}

export function buildOpsEvents(
  snapshot: WorldOverviewSnapshot | null,
  alerts: readonly BreakingAlert[],
  nowMs: number,
): OpsEvent[] {
  const events: OpsEvent[] = alerts.map((alert) => ({
    id: `wm:breaking-news:${alert.id}`,
    at: alert.timestamp.getTime(),
    kind: 'breaking',
    title: alert.headline,
    ...(alert.countryCode ? { iso2: alert.countryCode } : {}),
    severity: alert.threatLevel === 'critical' ? 'critical' : 'high',
    ...(alert.link ? { url: alert.link } : {}),
  }));

  if (snapshot) {
    if (snapshot.ai.date === kstDate(nowMs)) {
      for (const relation of snapshot.relations) {
        if (relation.origin !== 'ai') continue;
        events.push({
          id: `world-overview:relation:${relation.id}`,
          at: snapshot.generatedAt,
          kind: 'relation',
          title: relation.label,
          iso2: relation.to,
          severity: relation.kind === 'tension' || relation.kind === 'sanction' ? 'high' : 'medium',
          ...(relation.sources[0]?.url ? { url: relation.sources[0].url } : {}),
        });
      }
    }

    for (const [iso2, country] of Object.entries(snapshot.countries)) {
      if (!country.issue) continue;
      events.push({
        id: `world-overview:issue:${snapshot.date}:${iso2}`,
        at: snapshot.generatedAt,
        kind: 'issue',
        title: country.issue.summaryKo,
        iso2,
        severity: 'medium',
        ...(country.issue.sources[0]?.url ? { url: country.issue.sources[0].url } : {}),
      });
    }
  }

  const seen = new Set<string>();
  return events
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    })
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, 50);
}
