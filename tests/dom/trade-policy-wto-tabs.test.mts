import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TradePolicyPanel } from '@/components/TradePolicyPanel';
import type { GetTariffTrendsResponse } from '@/services/trade';
import { initTestI18n } from './helpers/i18n.mts';

// Task 10 folded the desktop guard `!isDesktopRuntime() || isFeatureAvailable('wtoTrade')`
// into `!isFeatureAvailable('wtoTrade')`, which hid every WTO tab for everyone
// (the toggle defaults to on). With the toggle on, WTO data must render.

function tariffs(): GetTariffTrendsResponse {
  return {
    datapoints: [{
      reportingCountry: 'USA',
      partnerCountry: 'CHN',
      productSector: 'All products',
      year: 2025,
      tariffRate: 3.4,
      boundRate: 3.4,
      indicatorCode: 'TP_A_0010',
      weightedRate: 2.1,
    }],
    fetchedAt: '2026-11-19T00:00:00Z',
    upstreamUnavailable: false,
    unavailableReason: 0,
    coverageStartYear: 2025,
    coverageEndYear: 2025,
  } as unknown as GetTariffTrendsResponse;
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('TradePolicyPanel WTO tabs', () => {
  it('renders the restrictions and tariffs tabs when WTO data arrives', async () => {
    const panel = new TradePolicyPanel();
    const root = panel.getElement();
    document.body.appendChild(root);

    panel.updateTariffs(tariffs());

    await vi.waitFor(() => expect(root.querySelector('.panel-tabs')).not.toBeNull());
    expect(root.querySelector('.panel-tab[data-tab="restrictions"]')).not.toBeNull();
    expect(root.querySelector('.panel-tab[data-tab="tariffs"]')).not.toBeNull();
    expect(root.querySelector('.panel-tab.active')?.getAttribute('data-tab')).toBe('restrictions');
  });
});
