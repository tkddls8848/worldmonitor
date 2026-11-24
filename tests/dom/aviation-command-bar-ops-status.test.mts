import { afterEach, expect, it, vi } from 'vitest';

const summaries = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/services/aviation', () => ({
  fetchFlightDelays: async () => summaries.rows,
  fetchFlightPrices: async () => ({ quotes: [] }),
  fetchAviationNews: async () => [],
  fetchGoogleFlights: async () => ({ flights: [] }),
}));

import { AviationCommandBar } from '@/components/AviationCommandBar';

afterEach(() => { document.body.innerHTML = ''; });

const row = { iata: 'IKA', icao: 'OIIE', name: 'Imam Khomeini International', avgDelayMinutes: 0, delayType: 'general' };

it.each([
  ['notam', 'normal', 'general', 'Open'],
  ['notam', 'severe', 'closure', 'Airport closed for maintenance'],
  ['notam', 'major', 'general', 'Airspace restriction'],
  ['faa', 'normal', 'general', 'Normal ops'],
] as const)('an ops row sourced to %s shows %s %s with its cause', async (source, severity, delayType, text) => {
  summaries.rows = [{ ...row, source, severity, delayType, reason: text }];
  const bar = new AviationCommandBar();
  bar.open();
  const input = document.querySelector<HTMLInputElement>('#aviation-cmd-input')!;
  input.value = 'ops IKA';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  await vi.waitFor(() => expect(document.querySelector('#aviation-cmd-result .cmd-row')).not.toBeNull());
  expect(document.querySelector('#aviation-cmd-result .cmd-row')!.textContent).toContain(text);
  bar.destroy();
});
