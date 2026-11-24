import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHOKEPOINT_THREAT_LEVELS } from '../shared/chokepoint-threat-levels.js';
import { detectTrafficAnomaly, summarizePortwatchHistory } from '../shared/chokepoint-traffic-anomaly.js';
import { loadEnvFile, readSeedSnapshot, runSeed } from './_seed-utils.mjs';

const KEY = 'supply_chain:transit-summaries:v1';
const TTL_SECONDS = 3600;
const PORTWATCH_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export function buildTransitSummaries(snapshot, now = Date.now()) {
  const summaries = {};
  const histories = {};
  for (const [id, threatLevel] of Object.entries(CHOKEPOINT_THREAT_LEVELS)) {
    const entry = snapshot?.data?.[id];
    const sourceTime = entry?.fetchedAt ?? snapshot?.meta?.fetchedAt;
    if (!Number.isFinite(sourceTime) || sourceTime > now || now - sourceTime > PORTWATCH_MAX_AGE_MS) continue;
    const history = Array.isArray(entry?.history) ? entry.history : [];
    const official = summarizePortwatchHistory(history, entry?.baseline);
    if (official.latestDate == null || !Number.isFinite(entry.wowChangePct)) continue;

    // These fields describe live AIS crossings and incident reports. The public
    // PortWatch time series supplies daily counts and traffic changes only.
    summaries[id] = {
      todayTotal: null, todayTanker: null, todayCargo: null, todayOther: null,
      wowChangePct: entry.wowChangePct,
      officialLatestDate: official.latestDate,
      officialLatestTotal: official.latestTotal,
      officialAvg7d: official.avg7d,
      baselineAvgDaily: official.baselineAvgDaily,
      baselineFrom: official.baselineFrom,
      baselineTo: official.baselineTo,
      riskLevel: '', incidentCount7d: 0, disruptionPct: 0, riskSummary: '', riskReportAction: '',
      anomaly: detectTrafficAnomaly(history, threatLevel),
      dataAvailable: true,
    };
    histories[id] = history;
  }
  if (!Object.keys(summaries).length) throw new Error('No current PortWatch chokepoint history');
  return { summaries, histories, fetchedAt: now };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  loadEnvFile(import.meta.url);
  await runSeed('supply_chain', 'transit-summaries', KEY, async () => {
    const snapshot = await readSeedSnapshot('supply_chain:portwatch:v1', { strict: true, includeEnvelopeMeta: true });
    return buildTransitSummaries(snapshot);
  }, {
    ttlSeconds: TTL_SECONDS,
    extendTtlOnFailure: false,
    declareRecords: (data) => Object.keys(data.summaries).length,
    publishTransform: ({ summaries, fetchedAt }) => ({ summaries, fetchedAt }),
    extraKeys: Object.keys(CHOKEPOINT_THREAT_LEVELS).map((chokepointId) => ({
      key: `supply_chain:transit-summaries:history:v1:${chokepointId}`,
      transform: ({ histories, fetchedAt }) => ({ chokepointId, history: histories[chokepointId] ?? [], fetchedAt }),
      declareRecords: ({ history }) => history.length,
    })),
    schemaVersion: 1,
    sourceVersion: 'transit-summaries-portwatch',
  });
}
