export const ECOS_BASE = 'https://ecos.bok.or.kr/api';
export const ECOS_USER_AGENT = 'WorldMonitor personal data collector (https://www.worldmonitor.app)';

const DEFINITIONS = [
  { id: 'base-rate', names: ['한국은행 기준금리'], series: ['722Y001', 'D', '0101000'] },
  { id: 'usdkrw', names: ['원/달러 환율(종가)'], series: ['731Y003', 'D', '0000013'] },
  { id: 'ktb3y', names: ['국고채수익률(3년)'], series: ['817Y002', 'D', '010200000'] },
  { id: 'kospi', names: ['코스피지수'], series: ['802Y001', 'D', '0001000'] },
  { id: 'current-account', names: ['경상수지'], series: ['301Y017', 'M', 'SA000'] },
  { id: 'exports', names: ['수출금액지수'], series: ['403Y001', 'M', '*AA'] },
  { id: 'unemployment', names: ['실업률'], series: ['901Y027', 'M', 'I61BC'] },
  { id: 'fx-reserves', names: ['외환보유액'], series: ['732Y001', 'M', '04'] },
];

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.replaceAll(',', '').trim();
  if (!normalized || normalized === '-' || normalized === '...') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowsFor(payload, service) {
  if (!payload || typeof payload !== 'object') throw new Error('ECOS response is not an object');
  if (payload.RESULT) {
    const code = String(payload.RESULT.CODE ?? '');
    if (code === 'INFO-200') return [];
    throw new Error(`ECOS ${service} failed: ${code || 'unknown error'}`);
  }
  const rows = payload[service]?.row;
  if (!Array.isArray(rows)) throw new Error(`ECOS ${service} response has no rows`);
  return rows;
}

async function getRows(url, service, fetchFn) {
  const response = await fetchFn(url, { headers: { Accept: 'application/json', 'User-Agent': ECOS_USER_AGENT } });
  if (!response.ok) throw new Error(`ECOS HTTP ${response.status}`);
  return rowsFor(await response.json(), service);
}

export function mapKeyStatistics(rows) {
  const byName = new Map(rows.map((row) => [String(row.KEYSTAT_NAME ?? '').trim(), row]));
  const result = [];
  for (const def of DEFINITIONS) {
    const row = def.names.map((name) => byName.get(name)).find(Boolean);
    const value = parseNumber(row?.DATA_VALUE);
    if (!row || value === null) continue;
    result.push({ id: def.id, nameKo: row.KEYSTAT_NAME, value, unit: String(row.UNIT_NAME ?? ''), period: String(row.CYCLE ?? ''), change: null, changeKind: null });
  }
  return result;
}

function dateBounds(cycle, now) {
  const date = new Date(now);
  if (cycle === 'D') {
    const end = date.toISOString().slice(0, 10).replaceAll('-', '');
    date.setDate(date.getDate() - 30);
    return [date.toISOString().slice(0, 10).replaceAll('-', ''), end];
  }
  const end = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
  date.setMonth(date.getMonth() - 14);
  return [`${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`, end];
}

async function searchSeries(key, stat, cycle, start, end, item, fetchFn) {
  const url = `${ECOS_BASE}/StatisticSearch/${encodeURIComponent(key)}/json/kr/1/100/${stat}/${cycle}/${start}/${end}/${item}`;
  return getRows(url, 'StatisticSearch', fetchFn);
}

function sortedValues(rows) {
  return rows.map((row) => ({ period: String(row.TIME ?? ''), value: parseNumber(row.DATA_VALUE) }))
    .filter((row) => row.period && row.value !== null).sort((a, b) => a.period.localeCompare(b.period));
}

export async function buildEcosMacro({ apiKey, now = Date.now(), fetchFn = fetch }) {
  if (!apiKey) throw new Error('Missing ECOS_API_KEY');
  const keyUrl = `${ECOS_BASE}/KeyStatisticList/${encodeURIComponent(apiKey)}/json/kr/1/100/`;
  const keyRows = await getRows(keyUrl, 'KeyStatisticList', fetchFn);
  const indicators = mapKeyStatistics(keyRows);
  // The 100-key snapshot includes the 3-year tenor; ECOS also publishes the
  // 10-year benchmark in its market-rate series, so include that longer tenor.
  try {
    const [start, end] = dateBounds('D', now);
    const rows = sortedValues(await searchSeries(apiKey, '817Y002', 'D', start, end, '010210000', fetchFn));
    const latest = rows.at(-1);
    const previous = rows.at(-2);
    if (latest) indicators.push({ id: 'ktb10y', nameKo: '국고채수익률(10년)', value: latest.value, unit: '%', period: latest.period, change: previous ? latest.value - previous.value : null, changeKind: previous ? 'abs' : null });
  } catch {
    // The rest of the 100-key snapshot remains useful if the additional tenor is unavailable.
  }
  const lookup = new Map(indicators.map((indicator) => [indicator.id, indicator]));
  const byId = new Map(DEFINITIONS.map((def) => [def.id, def]));

  // Add CPI inflation as a year-over-year rate from the monthly CPI index.
  const [monthStart, monthEnd] = dateBounds('M', now);
  const cpiRows = sortedValues(await searchSeries(apiKey, '901Y009', 'M', monthStart, monthEnd, '0', fetchFn));
  if (cpiRows.length >= 13) {
    const current = cpiRows.at(-1);
    const yearAgo = cpiRows.at(-13);
    const previousMonth = cpiRows.at(-2);
    const value = (current.value / yearAgo.value - 1) * 100;
    const previousRate = (previousMonth.value / cpiRows.at(-14)?.value - 1) * 100;
    indicators.push({ id: 'cpi-yoy', nameKo: '소비자물가지수 상승률(전년동월비)', value, unit: '%', period: current.period, change: Number.isFinite(previousRate) ? value - previousRate : null, changeKind: Number.isFinite(previousRate) ? 'abs' : null });
  }

  for (const def of DEFINITIONS) {
    const indicator = lookup.get(def.id);
    if (!indicator) continue;
    try {
      const [start, end] = dateBounds(def.series[1], now);
      const values = sortedValues(await searchSeries(apiKey, ...def.series.slice(0, 2), start, end, def.series[2], fetchFn));
      const latest = values.at(-1);
      const previous = values.at(-2);
      const sameObservation = latest && latest.period === indicator.period
        && Math.abs(latest.value - indicator.value) <= Math.max(0.0001, Math.abs(indicator.value) * 1e-8);
      if (sameObservation && previous) { indicator.change = latest.value - previous.value; indicator.changeKind = 'abs'; }
    } catch {
      // Keep the KeyStatisticList observation when a particular history lookup is unavailable.
    }
  }
  return { asOf: now, indicators };
}

export function validateEcosMacro(value) {
  return !!value && Number.isFinite(value.asOf) && Array.isArray(value.indicators)
    && value.indicators.every((item) => typeof item.id === 'string' && typeof item.nameKo === 'string'
      && Number.isFinite(item.value) && typeof item.unit === 'string' && typeof item.period === 'string'
      && (item.change === null || Number.isFinite(item.change))
      && [null, 'abs', 'pct', 'bp'].includes(item.changeKind));
}
