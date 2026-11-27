/** Market quotes preserve sub-cent prices (#9705). */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import type { MarketData } from '@/types';

const { MarketPanel } = await import('@/components/MarketPanel');

const CONTENT_DEBOUNCE_MS = 150;
const numberToLocaleString = Number.prototype.toLocaleString;

const PRICES = [0.00024, 1e-8, 1e-12, -0.00024, -1e-12, 0, 0.123456, 0.5, 12.5, 1500, -0.5] as const;

const EXPECTED = [
  '$0.00024',
  '$0.00000001',
  '<$0.00000001',
  '$-0.00024',
  '>-$0.00000001',
  '$0.00',
  '$0.123456',
  '$0.50',
  '$12.50',
  '$1,500',
  '$-0.50',
];

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 1);
}

function priceTexts(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('.market-price'), (el) => el.textContent ?? '');
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (this: number, locales, options) {
    return numberToLocaleString.call(this, locales ?? 'en-US', options);
  });
  document.body.replaceChildren();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('sub-cent asset prices stay visible (#9705)', () => {
  it('keeps sub-cent prices visible in the market panel', async () => {
    const markets = new MarketPanel();
    document.body.append(markets.getElement());

    const marketRows: MarketData[] = PRICES.map((price, index) => ({
      symbol: `M${index}`,
      name: `Market ${index}`,
      display: `M${index}`,
      price,
      change: 0,
    }));

    markets.renderMarkets(marketRows);
    await flush();

    expect(priceTexts(markets.getElement())).toEqual(EXPECTED);

    for (const text of priceTexts(markets.getElement())) {
      expect(text.length).toBeLessThanOrEqual(16);
    }
  });
});
