import Papa from 'papaparse';
import iso3ToIso2 from '../shared/iso3-to-iso2.json' with { type: 'json' };
import { fetchIndicator, MONTH, numeric, runIndicatorSeed, shiftMonth } from './lib/global-indicators.mjs';

const ENDPOINT = 'https://sdmx.oecd.org/public/rest/v1/data/OECD.SDD.STES,DSD_STES@DF_CLI,/.M.LI...AA...H';
const ARCHIVE = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=OECDLOLITOAASTSAM';
const AREAS = new Set('G20 AUS BRA CAN CHN DEU ESP FRA GBR IDN IND ITA JPN KOR MEX TUR USA ZAF ARG RUS SAU OECD'.split(' '));

export function cliPhase(level, change) {
  if (level >= 100) return change >= 0 ? 'expansion' : 'slowdown';
  return change >= 0 ? 'recovery' : 'downturn';
}

export function parseCli(csv, archiveCsv = '') {
  const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });
  const areas = new Map();
  for (const row of data) {
    const { REF_AREA: area, TIME_PERIOD: period } = row;
    const value = numeric(row.OBS_VALUE);
    if (!AREAS.has(area) || !MONTH.test(period) || value == null || row.ADJUSTMENT !== 'AA') continue;
    const code = area === 'G20' || area === 'OECD' ? area : iso3ToIso2[area];
    if (!areas.has(code)) areas.set(code, new Map());
    areas.get(code).set(period, value);
  }
  let fromArchive = false;
  if (!areas.has('OECD') && archiveCsv) {
    const archived = new Map();
    for (const row of Papa.parse(archiveCsv, { header: true, skipEmptyLines: true }).data) {
      const period = row.observation_date?.slice(0, 7);
      const value = numeric(row.OECDLOLITOAASTSAM);
      if (MONTH.test(period) && value != null) archived.set(period, value);
    }
    if (archived.size) {
      areas.set('OECD', archived);
      fromArchive = true;
    }
  }
  const series = {};
  for (const [code, points] of areas) {
    const period = [...points.keys()].sort().at(-1);
    const value = points.get(period);
    const prior = points.get(shiftMonth(period, -1));
    const earlier = points.get(shiftMonth(period, -2));
    if (prior === undefined) continue;
    const change = value - prior;
    const priorChange = earlier === undefined ? 0 : prior - earlier;
    const turningPoint = priorChange > 0 && change < 0 ? 'peak'
      : priorChange < 0 && change > 0 ? 'trough' : null;
    series[code] = { period, value, change, phase: cliPhase(value, change), turningPoint,
      archived: code === 'OECD' && fromArchive };
  }
  if (!series.G20) throw new Error('OECD CLI is missing consecutive G20 observations');
  return { series };
}

await runIndicatorSeed(import.meta.url, 'oecd-cli', async () => {
  const [csv, archive] = await Promise.all([
    fetchIndicator(`${ENDPOINT}?lastNObservations=6&format=csvfile`, {
      Accept: 'text/csv', 'Accept-Encoding': 'identity', 'Accept-Language': 'en',
    }).then((response) => response.text()),
    fetchIndicator(ARCHIVE).then((response) => response.text()).catch((error) => {
      console.warn(`OECD Total archive unavailable: ${error.message}`);
      return '';
    }),
  ]);
  return parseCli(csv, archive);
}, ({ series }) => Object.keys(series).length);
