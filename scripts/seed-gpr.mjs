import * as XLSX from '@e965/xlsx';
import iso3ToIso2 from '../shared/iso3-to-iso2.json' with { type: 'json' };
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { DAY_MS, fetchIndicator, numeric, runIndicatorSeed } from './lib/global-indicators.mjs';

const DAILY_URL = 'https://www.matteoiacoviello.com/gpr_files/data_gpr_daily_recent.xls';
const MONTHLY_URL = 'https://www.matteoiacoviello.com/gpr_files/data_gpr_export.xls';
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function readRows(bytes) {
  const workbook = XLSX.read(bytes);
  return XLSX.utils.sheet_to_json(workbook.Sheets.Sheet1, { header: 1, blankrows: false });
}

export function parseGpr(dailyBytes, monthlyBytes) {
  const [dailyHeader, ...dailyRows] = readRows(dailyBytes);
  const dayIndex = dailyHeader.indexOf('DAY');
  const valueIndex = dailyHeader.indexOf('GPRD');
  const dailyByDate = new Map();
  for (const row of dailyRows) {
    const compact = String(row[dayIndex]);
    const date = /^\d{8}$/.test(compact) ? compact.replace(/^(....)(..)(..)$/, '$1-$2-$3') : '';
    const at = Date.parse(date);
    const value = numeric(row[valueIndex]);
    if (Number.isFinite(at) && value != null && value >= 0) dailyByDate.set(at, { date, value });
  }
  const points = [...dailyByDate.keys()].sort((a, b) => a - b);
  const latest = points.at(-1);
  if (latest === undefined) throw new Error('GPR daily workbook has no observations');

  // Compare each day with its own trailing year. The threshold excludes the tested observation.
  const measurements = points.filter((at) => at > latest - 30 * DAY_MS).map((at) => {
    const baseline = points.filter((day) => day >= at - 365 * DAY_MS && day < at)
      .map((day) => dailyByDate.get(day).value).sort((a, b) => a - b);
    const recent = points.filter((day) => day > at - 30 * DAY_MS && day <= at)
      .map((day) => dailyByDate.get(day).value);
    if (baseline.length < 350 || recent.length < 28) throw new Error('GPR daily history has gaps in its comparison windows');
    const normal = mean(baseline);
    const average30d = mean(recent);
    const percentile99 = baseline[Math.ceil(0.99 * baseline.length) - 1];
    const { date, value } = dailyByDate.get(at);
    return { date, value, average30d, normal, percentile99, dailySpike: value > percentile99, sustainedSpike: average30d > normal * 1.5 };
  });
  const [monthlyHeader, ...monthlyRows] = readRows(monthlyBytes);
  const monthIndex = monthlyHeader.indexOf('month');
  const columns = monthlyHeader.flatMap((column, index) => {
    const code = /^GPRC_([A-Z]{3})$/.exec(column)?.[1];
    return code && iso3ToIso2[code] ? [[iso3ToIso2[code], index]] : [];
  });
  const countries = {};
  for (const row of monthlyRows) {
    const serial = numeric(row[monthIndex]);
    const month = serial === null ? null : XLSX.SSF.parse_date_code(serial);
    if (!month || month.y < 1985) continue;
    const period = `${month.y}-${String(month.m).padStart(2, '0')}`;
    for (const [code, index] of columns) {
      const value = numeric(row[index]);
      if (value != null && value >= 0 && (!countries[code] || period > countries[code].period)) {
        countries[code] = { period, value };
      }
    }
  }
  if (!Object.keys(countries).length) throw new Error('GPR monthly workbook has no country observations');
  return {
    latest: measurements.at(-1),
    spikes: measurements.filter((point) => point.dailySpike || point.sustainedSpike),
    daily: points.filter((at) => at > latest - 730 * DAY_MS).map((at) => dailyByDate.get(at)),
    countries,
  };
}

await runIndicatorSeed(import.meta.url, 'gpr', 'economic:gpr:v1', async () => {
  const [daily, monthly] = await Promise.all([DAILY_URL, MONTHLY_URL].map(async (url) =>
    (await fetchIndicator(url)).arrayBuffer()));
  return parseGpr(daily, monthly);
}, {
  recordCount: ({ daily, countries }) => daily.length + Object.keys(countries).length,
  maxStaleMin: 1080,
  contentMeta: ({ daily }, now) => tokensToContentMeta([daily[0]?.date, daily.at(-1)?.date], now),
  maxContentAgeMin: 14 * DAY_MIN, // Daily observations are published in a weekly file.
});
