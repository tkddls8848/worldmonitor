// The reviewed NASA OMI/Aura NO2 activity contract shared by the seeder
// (scripts/seed-no2-activity.mjs) and every reader, starting with the China
// activity nowcast (server/worldmonitor/economic/v1/get-china-activity-nowcast.ts).
// The region registry is generated (scripts/generate-no2-regions.mjs); the
// method constants, the holiday calendars, and the dataset validator live
// here so a reader cannot drift from the producer: a dataset is an activity
// observation only when it carries exactly this method.

import registry from './no2-regions.generated.mjs';

export const NO2_ACTIVITY_KEY = 'economic:no2-activity:v1';
export const NO2_ACTIVITY_SERIES_KEY_PREFIX = 'economic:no2-activity:series:v2:';
export const NO2_ACTIVITY_SEED_META_KEY = 'seed-meta:economic:no2-activity';
export const NO2_ACTIVITY_ACTIVATION_KEY = 'seed-activated:economic:no2-activity';
export const NO2_ACTIVITY_METHOD_VERSION = 'no2-activity/v2';
export const NO2_ACTIVITY_SOURCE_VERSION = 'nasa-omi-omno2d-004-v1';
export const NO2_ATTRIBUTION_PREFIX = 'NASA OMI/Aura OMNO2d (GES DISC)';
export const NO2_ACTIVITY_SOURCE = Object.freeze({
  publisherId: 'publisher:nasa-omi',
  dataset: 'OMNO2d.004',
  band: 'ColumnAmountNO2TropCloudScreened',
  unit: 'mol/m2',
});
export const NO2_ACTIVITY_MAX_REFRESH_AGE_MS = 7 * 86_400_000;

export const NO2_REGIONS = Object.freeze(registry.regions.map((region) => Object.freeze({
  ...region,
  bbox: Object.freeze([...region.bbox]),
})));

export const NO2_DIRECTIONS = Object.freeze(['strengthening', 'weakening', 'unchanged']);

export const NO2_ACTIVITY_METHOD = Object.freeze({
  windowDays: 56,
  windowEndLagDays: 3,
  refreshDays: 10,
  minValidFraction: 0.2,
  minValidDays: 14,
  baselineYears: 3,
  minBaselineYears: 2,
  deadBandPercent: 10,
  gridResolutionDegrees: 0.25,
  backfillDaysPerRun: 60,
  holidayMask: Object.freeze({ daysBefore: 7, daysAfter: 14 }),
});

/** The China nowcast composite over the Chinese clusters. */
export const CHINA_NO2_COMPOSITE = Object.freeze({
  regionIds: Object.freeze(NO2_REGIONS
    .filter((region) => region.kind === 'cluster' && region.countryCode === 'CN')
    .map((region) => region.id)),
  minRegions: 2,
});

/** Chinese New Year (first day of the lunar year), UTC calendar dates. */
export const LUNAR_NEW_YEAR_DATES = Object.freeze({
  2018: '2018-02-16',
  2019: '2019-02-05',
  2020: '2020-01-25',
  2021: '2021-02-12',
  2022: '2022-02-01',
  2023: '2023-01-22',
  2024: '2024-02-10',
  2025: '2025-01-29',
  2026: '2026-02-17',
  2027: '2027-02-06',
  2028: '2028-01-26',
  2029: '2029-02-13',
  2030: '2030-02-03',
});

export const NO2_REGION_EXCLUSIONS = Object.freeze([
  'request_failed',
  'baseline_backfill_pending',
  'insufficient_valid_days',
  'insufficient_baseline_years',
]);

export const NO2_COMPOSITE_EXCLUSIONS = Object.freeze([
  'insufficient_regions',
]);

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MS_PER_DAY = 86_400_000;

export function dateMs(isoDate) {
  if (typeof isoDate !== 'string' || !ISO_DATE.test(isoDate)) return Number.NaN;
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  // Date.parse normalizes an impossible day such as 02-30 into March; only a
  // date that round-trips is a calendar date.
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === isoDate ? ms : Number.NaN;
}

/**
 * True when the UTC calendar date falls inside the holiday mask of the named
 * calendar. Masked days are dropped from every window, current and baseline,
 * so a holiday that moves between years cannot read as an activity change.
 * Regions without a calendar, and years outside the table, are never masked.
 */
export function isHolidayMasked(isoDate, holidayCalendar, method = NO2_ACTIVITY_METHOD) {
  if (holidayCalendar !== 'lunar_new_year') return false;
  const ms = dateMs(isoDate);
  if (!Number.isFinite(ms)) return false;
  const newYear = LUNAR_NEW_YEAR_DATES[Number(isoDate.slice(0, 4))];
  if (!newYear) return false;
  const newYearMs = dateMs(newYear);
  return ms >= newYearMs - method.holidayMask.daysBefore * MS_PER_DAY
    && ms <= newYearMs + method.holidayMask.daysAfter * MS_PER_DAY;
}

export function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** The dead-banded signal and its direction for a year-over-year percent change. */
export function signalFor(changePercent, method = NO2_ACTIVITY_METHOD) {
  const signalValue = Math.abs(changePercent) < method.deadBandPercent ? 0 : changePercent;
  return {
    signalValue,
    direction: signalValue > 0 ? 'strengthening' : signalValue < 0 ? 'weakening' : 'unchanged',
  };
}

/**
 * The median change across the named regions, dead banded. Regions with an
 * exclusion are left out; fewer than `minRegions` eligible regions is itself
 * an exclusion, never a flat reading.
 */
export function composeRegions(dataset, regionIds, minRegions, method = NO2_ACTIVITY_METHOD) {
  const eligible = regionIds
    .map((id) => dataset.regions[id])
    .filter((region) => region !== undefined && region.exclusion === null);
  const eligibleIds = eligible.map((region) => region.id);
  if (eligible.length < minRegions) {
    return { changePercent: null, signalValue: null, direction: null, regionIds: eligibleIds, exclusion: 'insufficient_regions' };
  }
  const changePercent = median(eligible.map((region) => region.changePercent));
  return { changePercent, ...signalFor(changePercent, method), regionIds: eligibleIds, exclusion: null };
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isIsoDate = (value) => Number.isFinite(dateMs(value));
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?Z$/;
const isInstant = (value) => typeof value === 'string'
  && ISO_INSTANT.test(value)
  && isIsoDate(value.slice(0, 10))
  && Number.isFinite(Date.parse(value));

function isWindow(value) {
  return isRecord(value)
    && isIsoDate(value.windowStart)
    && isIsoDate(value.windowEnd)
    && dateMs(value.windowStart) <= dateMs(value.windowEnd)
    && isCount(value.validDays)
    && isCount(value.maskedDays)
    && (value.meanNo2MolM2 === null || isFiniteNumber(value.meanNo2MolM2))
    && (value.meanValidFraction === null
      || (isFiniteNumber(value.meanValidFraction) && value.meanValidFraction >= 0 && value.meanValidFraction <= 1))
    && (value.validDays === 0) === (value.meanNo2MolM2 === null);
}

function isBaselineYear(value) {
  return isWindow(value) && Number.isInteger(value.year) && value.year >= 2018;
}

function isSeriesCoverage(value) {
  return isRecord(value)
    && (value.refreshedAt === null || isInstant(value.refreshedAt))
    && isCount(value.days)
    && (value.firstDate === null || isIsoDate(value.firstDate))
    && (value.lastDate === null || isIsoDate(value.lastDate))
    && (value.days === 0) === (value.firstDate === null)
    && (value.days === 0) === (value.lastDate === null)
    && Array.isArray(value.backfilledYears)
    && value.backfilledYears.every((year) => Number.isInteger(year) && year >= 2018);
}

function isRegion(value, definition, method) {
  if (!isRecord(value) || value.id !== definition.id || value.kind !== definition.kind
    || value.label !== definition.label || value.countryCode !== definition.countryCode
    || value.resolutionDegrees !== definition.resolutionDegrees) return false;
  if (!Array.isArray(value.bbox) || value.bbox.length !== 4
    || value.bbox.some((edge, index) => edge !== definition.bbox[index])) return false;
  if (!isWindow(value.current) || !isSeriesCoverage(value.series)) return false;
  if (!isRecord(value.baseline) || !Array.isArray(value.baseline.years)
    || !value.baseline.years.every(isBaselineYear)
    || !(value.baseline.meanNo2MolM2 === null
      || (isFiniteNumber(value.baseline.meanNo2MolM2) && value.baseline.meanNo2MolM2 > 0))) return false;
  if (value.exclusion === null) {
    if (!isFiniteNumber(value.changePercent)) return false;
    const expected = signalFor(value.changePercent, method);
    return value.signalValue === expected.signalValue && value.direction === expected.direction;
  }
  return NO2_REGION_EXCLUSIONS.includes(value.exclusion)
    && value.changePercent === null
    && value.signalValue === null
    && value.direction === null;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameMethod(value, method) {
  return isRecord(value) && canonical(value) === canonical(method);
}

function isSource(value) {
  return isRecord(value)
    && Object.entries(NO2_ACTIVITY_SOURCE).every(([key, expected]) => value[key] === expected)
    && typeof value.attribution === 'string'
    && value.attribution.startsWith(NO2_ATTRIBUTION_PREFIX)
    && isCount(value.requestCount)
    && isCount(value.bytesDownloaded);
}

/**
 * The published dataset is usable only when it carries the reviewed method
 * verbatim and one record per registered region, keyed by id, each internally
 * consistent (signal and direction derived from its change). Anything else
 * reads as unusable: the seeder refuses to publish it and readers refuse to
 * consume it.
 */
export function validateNo2ActivityDataset(value, method = NO2_ACTIVITY_METHOD) {
  if (!isRecord(value)) return false;
  if (value.methodVersion !== NO2_ACTIVITY_METHOD_VERSION) return false;
  if (!isInstant(value.generatedAt)) return false;
  if (!sameMethod(value.method, method)) return false;
  if (!isSource(value.source)) return false;
  if (!isRecord(value.regions) || Object.keys(value.regions).length !== NO2_REGIONS.length) return false;
  const generatedAtMs = Date.parse(value.generatedAt);
  return NO2_REGIONS.every((definition) => {
    const region = value.regions[definition.id];
    return isRegion(region, definition, method)
      && (region.series.refreshedAt === null || Date.parse(region.series.refreshedAt) <= generatedAtMs)
      && (region.exclusion !== null || (region.series.refreshedAt !== null
        && generatedAtMs - Date.parse(region.series.refreshedAt) <= NO2_ACTIVITY_MAX_REFRESH_AGE_MS))
      && dateMs(region.current.windowEnd) + MS_PER_DAY <= generatedAtMs;
  });
}
