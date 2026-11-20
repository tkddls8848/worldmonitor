/**
 * The venues keep Washington hours. A reader in Seoul sees them all closed
 * every evening, so the panel prints the venues' local clock beside the
 * update time, and "closed" is worded as closed now, not closed down.
 */
import { afterEach, expect, it, vi } from 'vitest';
import ko from '../../src/locales/ko.json';
import type { PizzIntStatus } from '@/types';

vi.mock('@/services/i18n', () => ({
  t: (key: string) => key,
  getCurrentLanguageTag: () => 'en',
}));

import { PizzIntIndicator } from '@/components/PizzIntIndicator';

afterEach(() => { vi.useRealTimers(); });

it('shows the Washington clock next to the update time', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T10:51:00Z'));
  const indicator = new PizzIntIndicator();
  const status: PizzIntStatus = {
    defconLevel: 5, defconLabel: 'Normal Activity', aggregateActivity: 0,
    activeSpikes: 0, locationsMonitored: 1, locationsOpen: 0,
    lastUpdate: new Date(), dataFreshness: 'fresh',
    locations: [{
      place_id: 'venue', name: 'Pizza', address: '', current_popularity: 0,
      percentage_of_usual: null, is_spike: false, spike_magnitude: 0,
      data_source: 'google', recorded_at: new Date().toISOString(),
      data_freshness: 'fresh', is_closed_now: true,
    }],
  };
  indicator.updateStatus(status);
  const updated = indicator.getElement().querySelector('.pizzint-updated')!.textContent;
  expect(updated).toBe('components.pizzint.updated · 5:51 AM Eastern Time');
  expect(indicator.getElement().querySelector('.pizzint-location-status')!.textContent).toBe('components.pizzint.statusClosed');
});

it('words a closed venue as closed for now in Korean', () => {
  expect(ko.components.pizzint.statusClosed).toBe('영업 종료');
});
