/**
 * The label surface outside MapPopup that #8611 wired to vesselTypeLabel: the
 * country brief timeline. (The globe tooltip was the other one; it went with
 * the 3D globe.) A vessel whose only military evidence is AIS ship type 35
 * carries vesselType 'unknown', so it must print the supported 'Military Ops'
 * fact rather than a bare "Unknown".
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';
import type { MilitaryVessel } from '@/types';

import { initTestI18n } from './helpers/i18n.mts';

const timeline = vi.hoisted(() => ({ rendered: [] as unknown[][] }));
vi.mock('@/components/CountryTimeline', () => ({
  CountryTimeline: class {
    render(events: unknown[]) { timeline.rendered.push(events); }
    destroy() {}
  },
}));

import { CountryIntelManager } from '@/app/country-intel';

beforeAll(async () => {
  await initTestI18n();
});

function militaryOpsVessel(overrides: Partial<MilitaryVessel> = {}): MilitaryVessel {
  return {
    id: 'ais-235123456', mmsi: '235123456', name: 'SEA FALCON',
    vesselType: 'unknown', aisShipType: 'Military Ops',
    operator: 'other', operatorCountry: 'YE',
    lat: 12, lon: 44, heading: 0, speed: 4,
    lastAisUpdate: new Date(), confidence: 'low',
    ...overrides,
  };
}

describe('country brief timeline vessel type', () => {
  beforeEach(() => { timeline.rendered.length = 0; });

  function mountTimeline(vessel: MilitaryVessel): string[] {
    const intel = new CountryIntelManager({
      latestClusters: [],
      intelligenceCache: { military: { vessels: [vessel], flights: [] } },
      countryBriefPage: { getTimelineMount: () => document.createElement('div') },
      countryTimeline: null,
    } as unknown as AppContext);
    // 'ZZ' has no geometry and no COUNTRY_BOUNDS entry, so the operatorCountry
    // branch selects the vessel without dragging in country polygons.
    (intel as unknown as {
      mountCountryTimeline: (code: string, country: string) => void;
    }).mountCountryTimeline('ZZ', 'Testland');
    const last = timeline.rendered[timeline.rendered.length - 1] ?? [];
    return last.map((e: unknown) => (e as { label: string }).label);
  }

  it('shows the AIS activity for an AIS-only military contact', () => {
    const labels = mountTimeline(militaryOpsVessel({ operatorCountry: 'ZZ' }));
    expect(labels).toContain('SEA FALCON (Military Ops)');
  });

  it('keeps the raw class for a vessel whose class is known', () => {
    const labels = mountTimeline(militaryOpsVessel({
      operatorCountry: 'ZZ', vesselType: 'destroyer', name: 'USS ZUMWALT',
    }));
    expect(labels).toContain('USS ZUMWALT (destroyer)');
  });
});
