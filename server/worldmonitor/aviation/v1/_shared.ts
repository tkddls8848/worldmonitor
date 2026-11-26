import { XMLParser } from 'fast-xml-parser';
import type {
  AirportDelayAlert,
  FlightDelayType,
  FlightDelaySeverity,
  FlightDelaySource,
  AirportRegion,
} from '../../../../src/generated/server/worldmonitor/aviation/v1/service_server';
import type { MonitoredAirport } from '../../../../src/types';
import {
  FAA_AIRPORTS,
} from '../../../../src/config/airports';
import { readCachedJson } from '../../../_shared/redis';
export { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/personal-providers';
export { parseStringArray } from '../../../_shared/parse-string-array';


export function isValidAirportDelayAlert(value: unknown): value is AirportDelayAlert {
  if (!value || typeof value !== 'object') return false;
  const alert = value as Partial<AirportDelayAlert>;
  return typeof alert.iata === 'string'
    && (alert.reason === undefined || typeof alert.reason === 'string')
    && (alert.delayedFlightsPct === undefined || Number.isFinite(alert.delayedFlightsPct))
    && (alert.avgDelayMinutes === undefined || Number.isFinite(alert.avgDelayMinutes))
    && (alert.cancelledFlights === undefined || Number.isFinite(alert.cancelledFlights))
    && (alert.totalFlights === undefined || Number.isFinite(alert.totalFlights));
}

export const FAA_URL = 'https://nasstatus.faa.gov/api/airport-status-information';

// Shared by every route that turns a caller-supplied airport code into a PAID
export const IATA_RE = /^[A-Z]{3}$/;


// ---------- XML Parser ----------

export const xmlParser = new XMLParser({
  ignoreAttributes: true,
  isArray: (_name: string, jpath: unknown) => {
    // Force arrays for list items regardless of count to prevent single-item-as-object bug
    return typeof jpath === 'string' && /\.(Ground_Delay|Ground_Stop|Delay|Airport)$/.test(jpath);
  },
});

// ---------- Internal types ----------

export interface FAADelayInfo {
  airport: string;
  reason: string;
  avgDelay: number;
  type: string;
}

// ---------- Helpers ----------

export function parseDelayTypeFromReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('ground stop')) return 'ground_stop';
  if (r.includes('ground delay') || r.includes('gdp')) return 'ground_delay';
  if (r.includes('departure')) return 'departure_delay';
  if (r.includes('arrival')) return 'arrival_delay';
  if (r.includes('clos')) return 'ground_stop';
  return 'general';
}

export function parseFaaXml(xml: string): Map<string, FAADelayInfo> {
  const delays = new Map<string, FAADelayInfo>();
  const parsed = xmlParser.parse(xml);
  const root = parsed?.AIRPORT_STATUS_INFORMATION;
  if (!root) return delays;

  // Delay_type may be array or single object
  const delayTypes = Array.isArray(root.Delay_type)
    ? root.Delay_type
    : root.Delay_type ? [root.Delay_type] : [];

  for (const dt of delayTypes) {
    // Ground Delays
    if (dt.Ground_Delay_List?.Ground_Delay) {
      for (const gd of dt.Ground_Delay_List.Ground_Delay) {
        if (gd.ARPT) {
          delays.set(gd.ARPT, {
            airport: gd.ARPT,
            reason: gd.Reason || 'Ground delay',
            avgDelay: gd.Avg ? parseInt(gd.Avg, 10) : 30,
            type: 'ground_delay',
          });
        }
      }
    }
    // Ground Stops
    if (dt.Ground_Stop_List?.Ground_Stop) {
      for (const gs of dt.Ground_Stop_List.Ground_Stop) {
        if (gs.ARPT) {
          delays.set(gs.ARPT, {
            airport: gs.ARPT,
            reason: gs.Reason || 'Ground stop',
            avgDelay: 60,
            type: 'ground_stop',
          });
        }
      }
    }
    // Arrival/Departure Delays
    if (dt.Arrival_Departure_Delay_List?.Delay) {
      for (const d of dt.Arrival_Departure_Delay_List.Delay) {
        if (d.ARPT) {
          const min = parseInt(d.Arrival_Delay?.Min || d.Departure_Delay?.Min || '15', 10);
          const max = parseInt(d.Arrival_Delay?.Max || d.Departure_Delay?.Max || '30', 10);
          const existing = delays.get(d.ARPT);
          // Don't downgrade ground_stop to lesser delay
          if (!existing || existing.type !== 'ground_stop') {
            delays.set(d.ARPT, {
              airport: d.ARPT,
              reason: d.Reason || 'Delays',
              avgDelay: Math.round((min + max) / 2),
              type: parseDelayTypeFromReason(d.Reason || ''),
            });
          }
        }
      }
    }
    // Airport Closures
    if (dt.Airport_Closure_List?.Airport) {
      for (const ac of dt.Airport_Closure_List.Airport) {
        if (ac.ARPT && FAA_AIRPORTS.includes(ac.ARPT)) {
          delays.set(ac.ARPT, {
            airport: ac.ARPT,
            reason: 'Airport closure',
            avgDelay: 120,
            type: 'ground_stop',
          });
        }
      }
    }
  }

  return delays;
}

// ---------- Proto enum mappers ----------

export function toProtoDelayType(t: string): FlightDelayType {
  const map: Record<string, FlightDelayType> = {
    ground_stop: 'FLIGHT_DELAY_TYPE_GROUND_STOP',
    ground_delay: 'FLIGHT_DELAY_TYPE_GROUND_DELAY',
    departure_delay: 'FLIGHT_DELAY_TYPE_DEPARTURE_DELAY',
    arrival_delay: 'FLIGHT_DELAY_TYPE_ARRIVAL_DELAY',
    general: 'FLIGHT_DELAY_TYPE_GENERAL',
    closure: 'FLIGHT_DELAY_TYPE_CLOSURE',
  };
  return map[t] || 'FLIGHT_DELAY_TYPE_GENERAL';
}

export function toProtoSeverity(s: string): FlightDelaySeverity {
  const map: Record<string, FlightDelaySeverity> = {
    normal: 'FLIGHT_DELAY_SEVERITY_NORMAL',
    minor: 'FLIGHT_DELAY_SEVERITY_MINOR',
    moderate: 'FLIGHT_DELAY_SEVERITY_MODERATE',
    major: 'FLIGHT_DELAY_SEVERITY_MAJOR',
    severe: 'FLIGHT_DELAY_SEVERITY_SEVERE',
    unknown: 'FLIGHT_DELAY_SEVERITY_UNKNOWN',
  };
  // #3707: default to UNKNOWN (not NORMAL) for unrecognised input — the whole
  // point of the fix is to refuse to render uncovered/unmappable airports as
  // healthy.
  return map[s] || 'FLIGHT_DELAY_SEVERITY_UNKNOWN';
}

export function toProtoRegion(r: string): AirportRegion {
  const map: Record<string, AirportRegion> = {
    americas: 'AIRPORT_REGION_AMERICAS',
    europe: 'AIRPORT_REGION_EUROPE',
    apac: 'AIRPORT_REGION_APAC',
    mena: 'AIRPORT_REGION_MENA',
    africa: 'AIRPORT_REGION_AFRICA',
  };
  return map[r] || 'AIRPORT_REGION_UNSPECIFIED';
}

export function toProtoSource(s: string): FlightDelaySource {
  const map: Record<string, FlightDelaySource> = {
    unspecified: 'FLIGHT_DELAY_SOURCE_UNSPECIFIED',
    faa: 'FLIGHT_DELAY_SOURCE_FAA',
    eurocontrol: 'FLIGHT_DELAY_SOURCE_EUROCONTROL',
    computed: 'FLIGHT_DELAY_SOURCE_COMPUTED',
    notam: 'FLIGHT_DELAY_SOURCE_NOTAM',
  };
  return map[s] || 'FLIGHT_DELAY_SOURCE_COMPUTED';
}

// ---------- Severity classification ----------

export function severityFromCancelRate(cancelRate: number): string {
  if (cancelRate >= 80) return 'severe';
  if (cancelRate >= 50) return 'major';
  if (cancelRate >= 20) return 'moderate';
  if (cancelRate >= 10) return 'minor';
  return 'normal';
}

export function buildNotamAlert(
  airport: MonitoredAirport,
  reason: string,
  severity: 'severe' | 'major' | 'normal' = 'severe',
  delayType: 'closure' | 'general' = 'closure',
): AirportDelayAlert {
  return {
    id: `notam-${airport.iata}`,
    iata: airport.iata,
    icao: airport.icao,
    name: airport.name,
    city: airport.city,
    country: airport.country,
    location: { latitude: airport.lat, longitude: airport.lon },
    region: toProtoRegion(airport.region),
    delayType: toProtoDelayType(delayType),
    severity: toProtoSeverity(severity),
    avgDelayMinutes: 0,
    delayedFlightsPct: 0,
    cancelledFlights: 0,
    totalFlights: 0,
    reason: reason.length > 200 ? reason.slice(0, 200) + '…' : reason,
    source: toProtoSource('notam'),
    updatedAt: Date.now(),
  };
}

export const NOTAM_OPEN_REASON = 'Open';

/** An airport the NOTAM feed covers that has no closure or restriction NOTAM. */
export function buildNotamOpenAlert(airport: MonitoredAirport): AirportDelayAlert {
  return {
    ...buildNotamAlert(airport, NOTAM_OPEN_REASON, 'normal', 'general'),
    id: `notam-open-${airport.iata}`,
  };
}

// ---------- NOTAM seed loader ----------

const NOTAM_CACHE_KEY = 'aviation:notam:closures:v2';
export interface LoadedNotamResult {
  closedIcaos: string[];
  restrictedIcaos: string[];
  reasons: Record<string, string>;
  // Monitored airports with at least one NOTAM in the FAA NMS feed. Coverage
  // is what lets "no closure NOTAM" mean open rather than unknown.
  coveredIcaos: string[];
}

export interface LoadedNotamRead {
  data: LoadedNotamResult | null;
  unavailable: boolean;
}

export async function loadNotamClosures(): Promise<LoadedNotamRead> {
  try {
    const seed = await readCachedJson(NOTAM_CACHE_KEY, true);
    if (seed.status === 'miss') return { data: null, unavailable: false };
    if (seed.status === 'error') return { data: null, unavailable: true };
    const value = seed.value as Partial<LoadedNotamResult> | null;
    if (!value || !Array.isArray(value.closedIcaos) || !Array.isArray(value.restrictedIcaos)
      || !value.reasons || typeof value.reasons !== 'object') return { data: null, unavailable: true };
    if (!value.closedIcaos.every((icao) => typeof icao === 'string')
      || !value.restrictedIcaos.every((icao) => typeof icao === 'string')
      || !Object.values(value.reasons).every((reason) => typeof reason === 'string')
      || (value.coveredIcaos !== undefined
        && (!Array.isArray(value.coveredIcaos) || !value.coveredIcaos.every((icao) => typeof icao === 'string')))) {
      return { data: null, unavailable: true };
    }
    return { data: {
      closedIcaos: value.closedIcaos,
      restrictedIcaos: value.restrictedIcaos,
      reasons: value.reasons,
      coveredIcaos: value.coveredIcaos ?? [],
    }, unavailable: false };
  } catch (err) {
    console.warn(`[Aviation] NOTAM seed read failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
  return { data: null, unavailable: true };
}

// ---------- NOTAM + flight data merge ----------

const SEV_ORDER = ['normal', 'minor', 'moderate', 'major', 'severe'];

export function mergeNotamWithExistingAlert(
  airport: MonitoredAirport,
  notamReason: string,
  existing: AirportDelayAlert | null,
  severity: 'severe' | 'major' = 'severe',
  delayType: 'closure' | 'general' = 'closure',
): AirportDelayAlert {
  if (!existing || existing.totalFlights === 0) {
    return buildNotamAlert(airport, notamReason, severity, delayType);
  }

  const cancelRate = (existing.cancelledFlights / existing.totalFlights) * 100;
  const notamCancelSev = severityFromCancelRate(cancelRate);
  const notamFloor = 'moderate';

  const existingSevName = (existing.severity ?? '')
    .replace('FLIGHT_DELAY_SEVERITY_', '').toLowerCase() || 'normal';
  const effectiveSev = SEV_ORDER[Math.max(
    SEV_ORDER.indexOf(existingSevName),
    SEV_ORDER.indexOf(notamCancelSev),
    SEV_ORDER.indexOf(notamFloor),
  )] ?? 'moderate';

  const cancelText = `${Math.round(cancelRate)}% cxl`;
  const reason = `NOTAM: ${notamReason.slice(0, 120)} — ${cancelText}`;

  return {
    ...existing,
    id: `notam-${airport.iata}`,
    severity: toProtoSeverity(effectiveSev),
    delayType: toProtoDelayType(delayType),
    reason: reason.length > 200 ? reason.slice(0, 200) + '…' : reason,
    source: toProtoSource('notam'),
    updatedAt: Date.now(),
  };
}
