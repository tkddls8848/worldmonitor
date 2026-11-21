import iso3ToIso2 from '../shared/iso3-to-iso2.json' with { type: 'json' };
import majorConfig from '../shared/world-overview-config.json' with { type: 'json' };
import legacyPairs from './shared/gdelt-tension-pairs.json' with { type: 'json' };
import { addDays, pairKey } from '../shared/world-overview.js';
import { GDELT_PUBLICATION_LEAD_MS, gdeltTimestampToMs } from './_conflict-gdelt-bulk.mjs';

export const WORLD_PAIR_TREND = Object.freeze({
  recentHours: 24, baselineHours: 144, retainHours: 192, minCoverage: 0.5,
  risingRatio: 1.3, easingRatio: 0.7, surgeRatio: 3,
  minRecentEventsPerDay: 5, minBaselineEventsPerDay: 5, surgeMinEventsPerDay: 20,
});

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const empty = (nowMs) => ({ cursor: '', hours: {}, trackedSince: {}, trends: {}, updatedAt: nowMs, scope: { majorPairs: 0, aiPairs: 0 } });

export function parseWorldPairExport(csv) {
  const result = {};
  for (const line of String(csv).split(/\r?\n/)) {
    const fields = line.split('\t');
    if (fields.length < 35 || (fields[29] !== '3' && fields[29] !== '4')) continue;
    const a = iso3ToIso2[fields[7]?.trim().toUpperCase()];
    const b = iso3ToIso2[fields[17]?.trim().toUpperCase()];
    if (!a || !b || a === b) continue;
    const mentions = Number(fields[31]);
    const goldstein = Number(fields[30]);
    const intensity = Number.isFinite(mentions) && mentions >= 0 && Number.isFinite(goldstein)
      ? mentions * Math.max(0, -goldstein) : 0;
    const key = pairKey(a, b);
    const counts = result[key] ??= [0, 0];
    counts[0] += 1;
    counts[1] += intensity;
  }
  return result;
}

export function buildTrackedPairs(majorCountries, aiTrackedPairs, today, retentionDays) {
  const tracked = new Set();
  for (let i = 0; i < majorCountries.length; i++) {
    for (let j = i + 1; j < majorCountries.length; j++) tracked.add(pairKey(majorCountries[i], majorCountries[j]));
  }
  const cutoff = addDays(today, -(retentionDays - 1));
  for (const [pair, date] of Object.entries(aiTrackedPairs ?? {})) {
    if (typeof date === 'string' && date >= cutoff && date <= today) tracked.add(pair);
  }
  return tracked;
}

export function seedFromDyadStore(dyad, nowMs) {
  if (!dyad || typeof dyad !== 'object' || !dyad.days) return null;
  const config = new Map(legacyPairs.filter((p) => Array.isArray(p.countries) && p.countries.length === 2)
    .map((p) => [p.id, pairKey(...p.countries)]));
  const result = empty(nowMs);
  result.cursor = typeof dyad.cursor === 'string' ? dyad.cursor : '';
  for (const [date, day] of Object.entries(dyad.days)) {
    for (const [hour, bucket] of Object.entries(day?.hours ?? {})) {
      const stamp = `${date.replaceAll('-', '')}${hour.padStart(2, '0')}`;
      const pairs = {};
      for (const [id, counts] of Object.entries(bucket?.pairs ?? {})) {
        const key = config.get(id);
        if (key && Array.isArray(counts)) {
          pairs[key] = [...counts];
          const timestamp = Date.parse(`${date}T${hour.padStart(2, '0')}:00:00Z`);
          if (Number.isFinite(timestamp) && result.trackedSince[key] === undefined) result.trackedSince[key] = timestamp;
        }
      }
      if (Object.keys(pairs).length || Number(bucket?.cohorts) > 0) result.hours[stamp] = { cohorts: Number(bucket.cohorts) || 0, pairs };
    }
  }
  return result;
}

export function mergeWorldPairHours(previous, batches, tracked, nowMs) {
  const result = empty(nowMs);
  const pairs = new Set(tracked);
  result.cursor = previous?.cursor ?? '';
  result.hours = structuredClone(previous?.hours ?? {});
  result.trackedSince = Object.fromEntries(Object.entries(previous?.trackedSince ?? {}).filter(([p]) => pairs.has(p)));
  for (const hour of Object.values(result.hours)) {
    for (const pair of Object.keys(hour.pairs ?? {})) if (!pairs.has(pair)) delete hour.pairs[pair];
  }
  for (const batch of [...(batches ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    if (batch.timestamp <= result.cursor) continue;
    const timestampMs = gdeltTimestampToMs(batch.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs > nowMs + GDELT_PUBLICATION_LEAD_MS) throw new Error('Invalid world pair cohort timestamp');
    const hourKey = batch.timestamp.slice(0, 10);
    const hour = result.hours[hourKey] ??= { cohorts: 0, pairs: {} };
    hour.cohorts++;
    for (const [pair, value] of Object.entries(batch.worldPairs ?? {})) {
      if (!pairs.has(pair) || !Array.isArray(value)) continue;
      const prior = hour.pairs[pair] ?? [0, 0];
      hour.pairs[pair] = [prior[0] + (Number(value[0]) || 0), prior[1] + (Number(value[1]) || 0)];
    }
    for (const pair of pairs) if (result.trackedSince[pair] === undefined) result.trackedSince[pair] = timestampMs;
    result.cursor = batch.timestamp;
  }
  const minHour = Math.floor(nowMs / HOUR_MS) - WORLD_PAIR_TREND.retainHours;
  for (const key of Object.keys(result.hours)) if (Date.parse(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T${key.slice(8, 10)}:00:00Z`) / HOUR_MS < minHour) delete result.hours[key];
  for (const pair of pairs) if (result.trackedSince[pair] === undefined) result.trackedSince[pair] = nowMs;
  return result;
}

export function scoreWorldPairTrends(store, nowMs) {
  const cursor = store?.cursor ?? '';
  if (!/^\d{14}$/.test(cursor)) return {};
  const cursorMs = gdeltTimestampToMs(cursor);
  const endHour = Math.floor(cursorMs / HOUR_MS) - (cursor.slice(10, 12) === '45' ? 0 : 1);
  const trends = {};
  for (const [pair, trackedSince] of Object.entries(store.trackedSince ?? {})) {
    const collectWindow = (start, length) => {
      let cohorts = 0; let events = 0; let intensity = 0;
      for (let i = 0; i < length; i++) {
        const hour = store.hours?.[new Date((start + i) * HOUR_MS).toISOString().slice(0, 13).replace(/[-T:]/g, '')];
        if (!hour) continue;
        cohorts += hour.cohorts;
        events += hour.pairs?.[pair]?.[0] ?? 0;
        intensity += hour.pairs?.[pair]?.[1] ?? 0;
      }
      return { cohorts, events, intensity, eventsPerDay: cohorts ? events / cohorts * 96 : 0, intensityPerDay: cohorts ? intensity / cohorts * 96 : 0 };
    };
    const recent = collectWindow(endHour - 23, 24);
    const baseline = collectWindow(endHour - 167, 144);
    const baselineAvailable = trackedSince <= (endHour - 167) * HOUR_MS;
    const ratio = baseline.intensity > 0 ? Number((recent.intensityPerDay / baseline.intensityPerDay).toFixed(2)) : null;
    let state = 'collecting';
    if (baselineAvailable && recent.cohorts >= 24 * 4 * WORLD_PAIR_TREND.minCoverage && baseline.cohorts >= 144 * 4 * WORLD_PAIR_TREND.minCoverage) {
      state = recent.eventsPerDay >= WORLD_PAIR_TREND.surgeMinEventsPerDay && (ratio === null ? recent.intensityPerDay > 0 : ratio >= WORLD_PAIR_TREND.surgeRatio) ? 'surging'
        : ratio !== null && ratio >= WORLD_PAIR_TREND.risingRatio && recent.eventsPerDay >= WORLD_PAIR_TREND.minRecentEventsPerDay ? 'rising'
          : ratio !== null && ratio <= WORLD_PAIR_TREND.easingRatio && baseline.eventsPerDay >= WORLD_PAIR_TREND.minBaselineEventsPerDay ? 'easing' : 'steady';
    }
    trends[pair] = { state, recentEventsPerDay: recent.eventsPerDay, baselineEventsPerDay: baselineAvailable ? baseline.eventsPerDay : null,
      recentIntensityPerDay: recent.intensityPerDay, baselineIntensityPerDay: baselineAvailable ? baseline.intensityPerDay : null, ratio, trackedSince };
  }
  return trends;
}

export const WORLD_PAIR_MAJOR_COUNTRIES = majorConfig.majorCountries;
