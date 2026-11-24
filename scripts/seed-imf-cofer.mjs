import { XMLParser } from 'fast-xml-parser';
import { DAY_MIN, tokensToContentMeta } from './_content-age-helpers.mjs';
import { fetchIndicator, numeric, runIndicatorSeed } from './lib/global-indicators.mjs';

const ENDPOINT = 'https://api.imf.org/external/sdmx/2.1/data/IMF.STA,COFER,/G001....Q';
const CURRENCIES = { CI_USD: 'USD', CI_EUR: 'EUR', CI_JPY: 'JPY', CI_GBP: 'GBP', CI_CNY: 'CNY',
  CI_AUD: 'AUD', CI_CAD: 'CAD', CI_CHF: 'CHF', CI_OTHC: 'other' };
const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true,
  processEntities: false, isArray: (name) => name === 'Series' || name === 'Obs',
});

export function parseCofer(xml) {
  const series = parser.parse(xml)?.StructureSpecificData?.DataSet?.Series ?? [];
  const quarters = new Map();
  for (const row of series) {
    if (row.COUNTRY !== 'G001' || row.FREQUENCY !== 'Q') continue;
    for (const observation of row.Obs ?? []) {
      const period = observation.TIME_PERIOD;
      const value = numeric(observation.OBS_VALUE);
      if (!/^\d{4}-Q[1-4]$/.test(period) || value == null || value < 0) continue;
      if (!quarters.has(period)) quarters.set(period, { period, totalUsd: null, shares: {}, imputedShare: null });
      const quarter = quarters.get(period);
      if (row.INDICATOR === 'TFXRA' && row.TYPE_OF_TRANSFORMATION === 'NV_USD' && row.FXR_CURRENCY === 'CI_T' && row.SCALE === '6') {
        // SCALE describes the preferred display unit. This SDMX feed sends raw USD.
        quarter.totalUsd = value;
      }
      if (row.TYPE_OF_TRANSFORMATION !== 'SHRO_PT' || value > 100) continue;
      const currency = Object.hasOwn(CURRENCIES, row.FXR_CURRENCY) ? CURRENCIES[row.FXR_CURRENCY] : null;
      if (row.INDICATOR === 'AFXRA' && currency) quarter.shares[currency] = value;
      if (row.INDICATOR === 'UFXRA') quarter.shares.unallocated = value;
      if (row.INDICATOR === 'TFXRA_IMP') quarter.imputedShare = value;
    }
  }
  const history = [...quarters.values()].filter((row) => row.totalUsd > 0 && row.shares.USD != null)
    .sort((a, b) => a.period.localeCompare(b.period)).slice(-40);
  const current = history.at(-1);
  if (!current) throw new Error('IMF COFER has no world totals with a USD share');
  const yearAgo = `${Number(current.period.slice(0, 4)) - 1}${current.period.slice(4)}`;
  const prior = history.find((row) => row.period === yearAgo);
  const usdYoyPp = prior ? current.shares.USD - prior.shares.USD : null;
  return { latest: { ...current, usdYoyPp }, history };
}

await runIndicatorSeed(import.meta.url, 'imf-cofer', 'economic:imf-cofer:v1', async () => {
  const start = new Date().getUTCFullYear() - 10;
  const response = await fetchIndicator(`${ENDPOINT}?startPeriod=${start}-Q1`, {
    Accept: 'application/vnd.sdmx.structurespecificdata+xml;version=2.1',
  });
  return parseCofer(await response.text());
}, {
  recordCount: ({ history }) => history.length,
  contentMeta: ({ history }, now) => tokensToContentMeta(history.map(({ period }) => period), now),
  // With period-start timestamps, 80% of this budget spans three quarters.
  // The prewarning therefore starts after the next quarterly release is due.
  maxContentAgeMin: 345 * DAY_MIN,
});
