import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEcosMacro, mapKeyStatistics, validateEcosMacro } from '../scripts/lib/ecos-macro.mjs';

const keyRows = [
  { KEYSTAT_NAME: '한국은행 기준금리', DATA_VALUE: '3.25', CYCLE: '20261120', UNIT_NAME: '%' },
  { KEYSTAT_NAME: '원/달러 환율(종가)', DATA_VALUE: '1,336.2', CYCLE: '20261120', UNIT_NAME: '원' },
  { KEYSTAT_NAME: '외환보유액', DATA_VALUE: '443,158,544', CYCLE: '202610', UNIT_NAME: '천달러' },
];

describe('ECOS macro mapping', () => {
  it('maps known names, parses comma separated values, and ignores missing indicators', () => {
    assert.deepEqual(mapKeyStatistics(keyRows).map(({ id, value }) => [id, value]), [
      ['base-rate', 3.25], ['usdkrw', 1336.2], ['fx-reserves', 443158544],
    ]);
  });

  it('computes period change from StatisticSearch and returns the schema', async () => {
    const fetchFn = async (url) => {
      if (url.includes('/KeyStatisticList/')) return Response.json({ KeyStatisticList: { row: keyRows } });
      if (url.includes('/901Y009/')) return Response.json({ StatisticSearch: { row: Array.from({ length: 15 }, (_, index) => ({
        TIME: new Date(Date.UTC(2025, index, 1)).toISOString().slice(0, 7).replace('-', ''),
        DATA_VALUE: String(100 + index),
      })) } });
      if (url.includes('/817Y002/')) return Response.json({ StatisticSearch: { row: [
        { TIME: '20261119', DATA_VALUE: '3.5' }, { TIME: '20261120', DATA_VALUE: '3.6' },
      ] } });
      if (url.includes('/722Y001/')) return Response.json({ StatisticSearch: { row: [
        { TIME: '20261119', DATA_VALUE: '3.0' }, { TIME: '20261120', DATA_VALUE: '3.1' },
      ] } });
      if (url.includes('/731Y003/')) return Response.json({ StatisticSearch: { row: [
        { TIME: '20261119', DATA_VALUE: '1,330' }, { TIME: '20261120', DATA_VALUE: '1,336.2' },
      ] } });
      return Response.json({ RESULT: { CODE: 'INFO-200', MESSAGE: 'no data' } });
    };
    const data = await buildEcosMacro({ apiKey: 'fixture-key', now: Date.UTC(2026, 10, 22), fetchFn });
    assert.ok(Math.abs((data.indicators.find((item) => item.id === 'usdkrw')?.change ?? 0) - 6.2) < 1e-9);
    assert.ok(Math.abs((data.indicators.find((item) => item.id === 'ktb10y')?.change ?? 0) - 0.1) < 1e-9);
    const cpi = data.indicators.find((item) => item.id === 'cpi-yoy');
    assert.equal(cpi?.period, '202603');
    assert.ok(cpi && Number.isFinite(cpi.value) && Number.isFinite(cpi.change));
    assert.equal(validateEcosMacro(data), true);
  });

  it('treats INFO-200 as empty and fails gracefully on ECOS ERROR payloads', async () => {
    const empty = await buildEcosMacro({ apiKey: 'fixture-key', fetchFn: async () => Response.json({ RESULT: { CODE: 'INFO-200' } }) });
    assert.deepEqual(empty.indicators, []);
    await assert.rejects(() => buildEcosMacro({ apiKey: 'fixture-key', fetchFn: async () => Response.json({ RESULT: { CODE: 'ERROR-001', MESSAGE: 'bad key' } }) }), /ERROR-001/);
  });
});
