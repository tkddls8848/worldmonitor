import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, countryFromRows, parseTradeResponse, percentChange } from '../scripts/seed-kr-customs-trade.mjs';

test('parses XML and JSON payloads and rejects data.go.kr error envelopes', () => {
  assert.deepEqual(parseTradeResponse('<response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body><items><item><statCd>US</statCd><expDlr>123</expDlr></item></items></body></response>'), [{ statCd: 'US', expDlr: '123' }]);
  assert.deepEqual(parseTradeResponse({ response: { header: { resultCode: '00' }, body: { items: { item: [{ statCd: 'CN' }] } } } }), [{ statCd: 'CN' }]);
  assert.deepEqual(parseTradeResponse('{"response":{"header":{"resultCode":"00"},"body":{"items":{"item":{"statCd":"JP"}}}}}'), [{ statCd: 'JP' }]);
  assert.throws(() => parseTradeResponse('<response><header><resultCode>99</resultCode><resultMsg>SERVICE_KEY_IS_NOT_REGISTERED</resultMsg></header></response>'), /SERVICE_KEY_IS_NOT_REGISTERED/);
  assert.equal(countryFromRows([{ year: '총계', expDlr: '250', impDlr: '80' }, { statCd: 'US', statCdCntnKor1: '미국' }], 'US').iso2, 'US');
});

test('calculates YoY safely and creates monthly and provisional USD snapshot from fixtures', async () => {
  assert.equal(percentChange(120, 100), 20);
  assert.equal(percentChange(120, 0), null);
  const fakeFetch = async (url) => {
    const parsed = new URL(url);
    const service = parsed.pathname.split('/')[2];
    const period = parsed.searchParams.get('strtYymm');
    const xml = service === 'Itemtrade'
      ? `<response><header><resultCode>00</resultCode></header><body><items><item><hsCode>8542310000</hsCode><statKor>전자집적회로</statKor><expDlr>${period === '202510' ? 100 : 200}</expDlr><impDlr>50</impDlr></item><item><hsCode>-</hsCode><year>총계</year><expDlr>${period === '202510' ? 100 : 200}</expDlr><impDlr>50</impDlr></item></items></body></response>`
      : service.startsWith('prlstMmUtPrvi')
        ? `<response><header><resultCode>00</resultCode></header><body><items><item><itemUsdAmt00>100</itemUsdAmt00><priodDt>01~10</priodDt><priodMon>${period}</priodMon></item></items></body></response>`
        : `<response><header><resultCode>00</resultCode></header><body><items><item><year>총계</year><statCd>-</statCd><expDlr>200</expDlr><impDlr>50</impDlr></item><item><year>2026.10</year><statCd>US</statCd><statCdCntnKor1>미국</statCdCntnKor1><expDlr>200</expDlr><impDlr>50</impDlr></item></items></body></response>`;
    return new Response(xml, { status: 200 });
  };
  const snapshot = await buildSnapshot({ apiKey: 'fixture-only', fetchImpl: fakeFetch, now: new Date('2026-11-22T00:00:00Z') });
  assert.equal(snapshot.month, '202610');
  assert.equal(snapshot.total.exportUsd, 200);
  assert.equal(snapshot.total.exportYoyPct, 100);
  assert.equal(snapshot.partners[0].iso2, 'CN');
  assert.equal(snapshot.items.find((item) => item.hs === '8542').nameKo, '반도체');
  assert.equal(snapshot.provisional.exportUsd, 100000);
});
