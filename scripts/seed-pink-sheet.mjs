import * as XLSX from '@e965/xlsx';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { fetchIndicator, numeric, runIndicatorSeed, shiftMonth } from './lib/global-indicators.mjs';

const LANDING_PAGE = 'https://www.worldbank.org/en/research/commodity-markets';
const WORKBOOK_ORIGIN = 'https://thedocs.worldbank.org';
const LABELS = {
  energy: 'energy', 'non-energy': 'nonEnergy', agriculture: 'agriculture', food: 'food',
  fertilizers: 'fertilizers', 'metals & minerals': 'metals', 'precious metals': 'preciousMetals',
};

export function findPinkSheetWorkbook(html) {
  const url = /href=["'](https:\/\/thedocs\.worldbank\.org\/en\/doc\/[\w-]+\/related\/CMO-Historical-Data-Monthly\.xlsx)["']/i.exec(html)?.[1];
  if (!url) throw new Error('World Bank Commodity Markets page has no monthly workbook link');
  return new URL(new URL(url).pathname, WORKBOOK_ORIGIN).href;
}

export function parsePinkSheet(bytes) {
  const workbook = XLSX.read(bytes, { sheets: 'Monthly Indices' });
  const sheet = workbook.Sheets['Monthly Indices'];
  if (!sheet) throw new Error('Pink Sheet workbook has no Monthly Indices sheet');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  const firstMonth = rows.findIndex((row) => /^\d{4}M(0[1-9]|1[0-2])$/.test(row[0]));
  if (firstMonth < 0) throw new Error('Pink Sheet has no monthly observations');
  const columns = new Map();
  for (const row of rows.slice(0, firstMonth)) {
    row.forEach((cell, index) => {
      const label = String(cell).toLowerCase().replace(/\s+/g, ' ').replace(/\s+\*+$/, '').trim();
      if (Object.hasOwn(LABELS, label)) columns.set(LABELS[label], index);
    });
  }
  if (columns.size !== Object.keys(LABELS).length) throw new Error('Pink Sheet index headings changed');
  const points = new Map();
  for (const [date, ...values] of rows.slice(firstMonth)) {
    if (!/^\d{4}M(0[1-9]|1[0-2])$/.test(date)) continue;
    const indices = Object.fromEntries([...columns].map(([key, column]) => [key, numeric(values[column - 1])]));
    if (Object.values(indices).every((value) => value > 0)) points.set(date.replace('M', '-'), indices);
  }
  const history = [...points.keys()].sort().slice(-60).map((period) => ({ period, indices: points.get(period) }));
  const current = history.at(-1);
  if (!current) throw new Error('Pink Sheet has no complete monthly observations');
  const previous = points.get(shiftMonth(current.period, -1));
  const yearAgo = points.get(shiftMonth(current.period, -12));
  const indices = Object.fromEntries(Object.entries(current.indices).map(([key, value]) => [key, {
    value,
    momPct: previous ? (value / previous[key] - 1) * 100 : null,
    yoyPct: yearAgo ? (value / yearAgo[key] - 1) * 100 : null,
  }]));
  const spikes = history.slice(-3).flatMap(({ period, indices: levels }) => {
    const prior = points.get(shiftMonth(period, -1));
    if (!prior) return [];
    return Object.entries(levels).flatMap(([key, value]) => {
      const delta = value - prior[key];
      return Math.abs(delta) > prior[key] / 10 ? [{ period, key, momPct: delta / prior[key] * 100 }] : [];
    });
  });
  return { latest: { period: current.period, indices }, history, spikes };
}

await runIndicatorSeed(import.meta.url, 'pink-sheet', 'economic:pink-sheet:v1', async () => {
  const page = await (await fetchIndicator(LANDING_PAGE)).text();
  const workbook = await fetchIndicator(findPinkSheetWorkbook(page));
  return parsePinkSheet(await workbook.arrayBuffer());
}, {
  recordCount: ({ history }) => history.length,
  contentMeta: ({ history }, now) => tokensToContentMeta(history.map(({ period }) => period), now),
  maxContentAgeMin: 75 * DAY_MIN, // Monthly observations are released the following month.
});
