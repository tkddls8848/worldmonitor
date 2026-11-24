import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SHIPPING_CARRIERS, scoreShippingStress } from '../shared/shipping-stress.js';
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { fetchYahooQuoteChart } from './_yahoo-fetch.mjs';

const KEY = 'supply_chain:shipping_stress:v1';
const TTL_SECONDS = 3600;

export async function fetchShippingStress(fetchQuote = fetchYahooQuoteChart) {
  const carriers = [];
  for (const carrier of SHIPPING_CARRIERS) {
    await sleep(150);
    try {
      const quote = await fetchQuote(carrier.symbol);
      if (quote) carriers.push({ ...carrier, price: quote.price, changePct: quote.change, sparkline: quote.sparkline });
    } catch (error) {
      console.warn(`[shipping-stress] ${carrier.symbol}: ${error.message}`);
    }
  }
  if (!carriers.length) throw new Error('Yahoo Finance supplied no carrier quotes');
  return { carriers, ...scoreShippingStress(carriers), fetchedAt: Date.now() };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  loadEnvFile(import.meta.url);
  await runSeed('supply_chain', 'shipping_stress', KEY, () => fetchShippingStress(), {
    ttlSeconds: TTL_SECONDS,
    declareRecords: (data) => data.carriers.length,
    schemaVersion: 1,
    sourceVersion: 'shipping-stress',
  });
}
