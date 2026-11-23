import type { WorldOverviewSnapshot } from '../../shared/world-overview.js';
import { kstDate } from '../../shared/world-overview.js';
import type { BreakingAlert } from '@/services/breaking-news-alerts';
import type { FederalRegisterDocument, OpsCounters, OpsEvent, OpsMetrics, ThreatLevel } from '@/types/world-overview';
import type { IodaOutage } from '@/services/internet-outages-ioda';
import type { KrDartDisclosure } from '@/services/kr-dart';
import { federalRegisterLabel } from '@/services/federal-register';

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
  outages: readonly IodaOutage[] = [],
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
    outages: activeOutages(outages, nowMs).length,
  };
  // Calibrated so the late-2026 baseline (4 wars, ~17 high-intensity conflicts) reads 고위험 (2), not saturated.
  const raw = Math.min(100,
    8 * counters.wars
      + 2 * counters.highConflicts
      + 1 * counters.worsening
      + 0.2 * counters.breaking24h
      + 0.02 * counters.sanctionPairs
      + 0.5 * counters.outages,
  );
  const threatScore = Math.round(raw * 10) / 10;
  return { threatLevel: levelForScore(threatScore), threatScore, counters };
}

export function buildOpsEvents(
  snapshot: WorldOverviewSnapshot | null,
  alerts: readonly BreakingAlert[],
  nowMs: number,
  extras: { outages?: readonly IodaOutage[]; disclosures?: readonly KrDartDisclosure[]; federalRegister?: readonly FederalRegisterDocument[] } = {},
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

  const disclosures = [...(extras.disclosures ?? [])]
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, 15);
  for (const filing of disclosures) events.push({
    id: `dart:${filing.id}`,
    at: filing.at,
    kind: 'disclosure',
    title: `${filing.corpName} · ${filing.title}`,
    iso2: 'KR',
    severity: filing.kind === 'major' ? 'medium' : 'low',
    url: filing.url,
  });

  for (const outage of activeOutages(extras.outages ?? [], nowMs)) {
    events.push({
      id: `ioda:outage:${outage.id}`,
      at: outage.end ?? outage.start,
      kind: 'outage',
      title: `인터넷 차단 · ${countryName(outage.iso2)} (${outage.signals.join(', ')})`,
      iso2: outage.iso2,
      severity: outage.severity,
      url: outage.url,
    });
  }

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

  // Publication dates have day precision. Reserve a few rows so today's
  // timestamped alerts and snapshot updates cannot push all of them out.
  const federalEvents: OpsEvent[] = (extras.federalRegister ?? [])
    .filter((item) => item.type === 'Executive Order' || ['tariff', 'sanctions', 'export-control'].includes(item.topic))
    .slice(0, 8)
    .map((item) => ({
      id: `federal-register:${item.id}`,
      at: Date.parse(item.date),
      kind: 'federal-register',
      title: `미 연방관보 · ${federalRegisterLabel(item)} · ${item.title}`,
      iso2: item.countries[0],
      severity: 'medium',
      url: item.url,
    }));
  const newestFirst = (a: OpsEvent, b: OpsEvent) => b.at - a.at || a.id.localeCompare(b.id);
  const seen = new Set<string>();
  const recentEvents = events
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    })
    .sort(newestFirst)
    .slice(0, 50 - federalEvents.length);
  return [...recentEvents, ...federalEvents].sort(newestFirst);
}

const OUTAGE_RECENT_MS = 6 * 60 * 60 * 1000;
function countryName(iso2: string): string {
  try { return new Intl.DisplayNames(['ko'], { type: 'region' }).of(iso2.toUpperCase()) ?? iso2; }
  catch { return iso2; }
}
/**
 * Outages the battle board counts: active or ended in the last 6 h, backed by more
 * than IODA's darknet telescope alone (merit-nt-only alerts are noisy), and one —
 * the most recent — per country.
 */
function activeOutages(outages: readonly IodaOutage[], nowMs: number): IodaOutage[] {
  const latestByCountry = new Map<string, IodaOutage>();
  for (const outage of outages) {
    const recent = outage.end === null || (outage.end <= nowMs && outage.end >= nowMs - OUTAGE_RECENT_MS);
    const corroborated = outage.signals.some((signal) => signal !== 'merit-nt');
    if (!recent || !corroborated) continue;
    const seen = latestByCountry.get(outage.iso2);
    if (!seen || (outage.end ?? outage.start) > (seen.end ?? seen.start)) latestByCountry.set(outage.iso2, outage);
  }
  return [...latestByCountry.values()];
}
