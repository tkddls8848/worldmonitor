/** Keyboard disclosure and focus restoration for the country sector table (#7023). */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import type { CountryBriefSource } from '@/services/country-brief-source';
import type {
  GetCountryChokepointIndexResponse,
  SectorExposureSummary,
} from '@/services/supply-chain';

beforeEach(() => {
  document.body.innerHTML = '';
});
describe('CountryDeepDivePanel sector rows (#7023)', () => {
  type CdpInternals = {
    tradeExposureBody: HTMLElement | null;
    cachedTradeExposureData: GetCountryChokepointIndexResponse | null;
    cachedSectors: SectorExposureSummary[];
    renderTradeExposureContent(): void;
  };

  const exposureData: GetCountryChokepointIndexResponse = {
    iso2: 'US',
    hs2: '',
    exposures: [],
    primaryChokepointId: '',
    vulnerabilityIndex: 42,
    fetchedAt: '2026-09-01T00:00:00Z',
  };

  const sectors: SectorExposureSummary[] = [
    {
      hs2: '85',
      label: 'Electronics',
      dependencyFlag: 'DEPENDENCY_FLAG_DIVERSIFIABLE',
      primaryChokepointId: 'test-electronics-route',
      primaryChokepointName: 'Malacca',
      exposureScore: 61,
      vulnerabilityIndex: 42,
      primaryExporterIso2: 'CN',
      primaryExporterShare: 0.4,
    },
    {
      hs2: '27',
      label: 'Fuels',
      dependencyFlag: 'DEPENDENCY_FLAG_COMPOUND_RISK',
      primaryChokepointId: 'test-fuels-route',
      primaryChokepointName: 'Hormuz',
      exposureScore: 88,
      vulnerabilityIndex: 64,
      primaryExporterIso2: 'SA',
      primaryExporterShare: 0.3,
    },
  ];

  function renderedRows(source?: CountryBriefSource, suppliedSectors = sectors): { body: HTMLElement; panel: CountryDeepDivePanel } {
    const panel = new CountryDeepDivePanel(null, source);
    const internals = panel as unknown as CdpInternals;
    const body = document.createElement('div');
    document.body.appendChild(body);
    internals.tradeExposureBody = body;
    internals.cachedTradeExposureData = exposureData;
    internals.cachedSectors = suppliedSectors;
    internals.renderTradeExposureContent();
    return { body, panel };
  }

  it.each([
    ['WAR_RISK_TIER_UNSPECIFIED', 'Unknown'],
    ['WAR_RISK_TIER_NORMAL', 'Normal'],
    ['WAR_RISK_TIER_ELEVATED', 'Elevated'],
    ['WAR_RISK_TIER_HIGH', 'High'],
    ['WAR_RISK_TIER_CRITICAL', 'Critical'],
    ['WAR_RISK_TIER_WAR_ZONE', 'War Zone'],
    ['FUTURE_UNRECOGNIZED_TIER', 'FUTURE_UNRECOGNIZED_TIER'],
  ])('renders bypass risk %s as %s through the sector disclosure', async (tier, label) => {
    const externalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Synthetic bypass fixtures forbid network reads'));
    const bypass = vi.fn(async () => ({ options: [{
      name: 'Synthetic bypass', addedTransitDays: 1, addedCostMultiplier: 1.03, bypassWarRiskTier: tier,
    }] }));
    const source = { canRequestPremium: () => true, bypass } as unknown as CountryBriefSource;
    const { body, panel } = renderedRows(source, [{ ...sectors[1]!, primaryChokepointId: 'malacca_strait', primaryChokepointName: 'Strait of Malacca' }]);
    try {
      body.querySelector<HTMLButtonElement>('button.cdp-sector-toggle')!.click();
      await vi.waitFor(() => {
        const cells = body.querySelectorAll('.cdp-sector-detail-row table tbody tr td');
        expect([...cells].map(cell => cell.textContent)).toEqual(['Synthetic bypass', '+1d', '+3%', label]);
      });
      expect(bypass).toHaveBeenCalledTimes(1);
      expect(bypass).toHaveBeenCalledWith('malacca_strait', expect.any(AbortSignal));
      expect(externalFetch).not.toHaveBeenCalled();
    } finally {
      panel.hide();
      externalFetch.mockRestore();
    }
  });

  it('keeps row semantics and puts disclosure state on native buttons', () => {
    const { body } = renderedRows();
    const rows = [...body.querySelectorAll<HTMLElement>('tr.cdp-sector-row')];
    const buttons = [...body.querySelectorAll<HTMLButtonElement>('button.cdp-sector-toggle')];

    expect(rows).toHaveLength(2);
    expect(buttons).toHaveLength(2);
    for (const row of rows) {
      expect(row.hasAttribute('tabindex')).toBe(false);
      expect(row.hasAttribute('aria-expanded')).toBe(false);
      expect(row.hasAttribute('role')).toBe(false);
    }
    for (const button of buttons) {
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(button.getAttribute('aria-controls')).toBe(`cdp-sector-detail-${button.dataset.hs2}`);
    }
  });

  it('scopes every rendered header cell to its column', () => {
    const { body } = renderedRows();
    const headers = [...body.querySelectorAll<HTMLTableCellElement>('th')];

    expect(headers.map((th) => th.textContent)).toEqual(['Sector', 'Chokepoint', 'Risk']);
    for (const th of headers) {
      expect(th.getAttribute('scope')).toBe('col');
    }
  });

  it('expands and collapses through the real handler while preserving focus', () => {
    const { body } = renderedRows();
    const button = body.querySelector<HTMLButtonElement>('button.cdp-sector-toggle[data-hs2="27"]')!;

    button.focus();
    button.click();

    const expanded = body.querySelector<HTMLButtonElement>('button.cdp-sector-toggle[data-hs2="27"]')!;
    const detailId = expanded.getAttribute('aria-controls')!;
    const detail = body.querySelector<HTMLElement>(`#${detailId}`);
    expect(expanded.getAttribute('aria-expanded')).toBe('true');
    expect(detail?.classList.contains('cdp-sector-detail-row')).toBe(true);
    expect(detail?.textContent).toContain('No maritime route data');
    expect(document.activeElement).toBe(expanded);

    expanded.click();

    const collapsed = body.querySelector<HTMLButtonElement>('button.cdp-sector-toggle[data-hs2="27"]')!;
    expect(collapsed.getAttribute('aria-expanded')).toBe('false');
    expect(body.querySelector(`#${detailId}`)).toBeNull();
    expect(document.activeElement).toBe(collapsed);
  });
});
