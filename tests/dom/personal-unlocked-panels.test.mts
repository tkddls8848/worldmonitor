/**
 * Personal edition: the three surfaces that used to sit behind the Pro lock
 * (supply-chain cost shock, the chokepoint scenario engine, and the
 * must render their real content for the single owner,
 * who has no account, no entitlement and no API key. Nothing about access is
 * mocked; the components decide on their own.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';

const mocks = vi.hoisted(() => {
  // The panels fire their own reads; none may leave the test process.
  globalThis.fetch = async () => { throw new Error('personal-unlocked-panels fixtures forbid network reads'); };
  return {
    runScenario: vi.fn(),
    getScenarioStatus: vi.fn(),
  };
});

vi.mock('@/services/scenario', () => ({ runScenario: mocks.runScenario, getScenarioStatus: mocks.getScenarioStatus }));
vi.mock('@/services/supply-chain', () => ({
  getFoodStocks: vi.fn(async () => ({ unavailable: true, records: [] })),
  fetchBypassOptions: async () => ({ options: [] }),
  fetchChokepointHistory: async () => ({ history: [] }),
}));

import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { SupplyChainPanel } from '@/components/SupplyChainPanel';

// Every lock, paywall or upgrade affordance these surfaces have drawn.
const LOCK_SELECTOR = [
  '.panel-locked-state',
  '.panel-locked-cta',
  '.panel-is-locked',
  '.panel-pro-badge',
  '.cdp-pro-locked',
  '.sc-bypass-gate',
  '.sc-scenario-btn--gated',
  '[data-gated]',
].join(', ');

beforeAll(initTestI18n);
afterEach(() => {
  document.getElementById('deep-dive-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('personal edition', () => {
  it('formerly premium panels render without a lock', async () => {
    // Supply-chain cost shock: the country deep dive's multi-sector card.
    const deepDive = new CountryDeepDivePanel();
    deepDive.show('Canada', 'CA', null, null);
    const costShock = document.querySelector('#country-deep-dive-panel');
    expect(costShock).not.toBeNull();
    expect(costShock!.textContent).not.toMatch(/Upgrade to PRO/i);
    expect(costShock!.textContent).not.toMatch(/\bPRO\b|\bPro\b/);
    expect(costShock!.querySelectorAll(LOCK_SELECTOR)).toHaveLength(0);

    // Scenario engine: the chokepoint scenario controls in the supply-chain panel.
    vi.useFakeTimers();
    const supplyChain = new SupplyChainPanel();
    document.body.append(supplyChain.getElement());
    supplyChain.updateChokepointStatus({
      chokepoints: [{
        id: 'hormuz_strait', name: 'Strait of Hormuz', disruptionScore: 20, status: 'yellow',
        affectedCommodities: [], affectedRoutes: [], description: 'Fixture', lat: 26, lon: 56,
      }],
      fetchedAt: Date.now(),
    } as never);
    await vi.advanceTimersByTimeAsync(160);
    supplyChain.getElement().querySelector<HTMLElement>('.trade-restriction-header')!.click();
    await vi.advanceTimersByTimeAsync(160);
    const scenarioButton = supplyChain.getElement().querySelector<HTMLButtonElement>('.sc-scenario-btn');
    expect(scenarioButton).not.toBeNull();
    expect(supplyChain.getElement().querySelectorAll(LOCK_SELECTOR)).toHaveLength(0);
    mocks.runScenario.mockResolvedValue({ jobId: 'scenario:1712345678901:abcdefgh', status: 'pending' });
    mocks.getScenarioStatus.mockReturnValue(new Promise(() => {}));
    scenarioButton!.click();
    await vi.advanceTimersByTimeAsync(160);
    expect(mocks.runScenario).toHaveBeenCalledTimes(1);
    supplyChain.destroy();
    vi.useRealTimers();


  });
});
