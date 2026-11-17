import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderChokepointLiveSection,
  replaceChokepointLiveSection,
} from '../scripts/crawlable-chokepoint-live.mjs';
import { isPublicSharedRpcRequest } from '../src/shared/public-rpc-cache.ts';

const HORMUZ = {
  id: 'hormuz_strait',
  displayName: 'Strait of Hormuz',
};

const PUBLISHED_PULSE = {
  disruptionScore: '85',
  status: 'Red',
  congestion: 'High',
  navigationalWarnings: '0 warnings',
  navigationalWarningsAvailable: true,
  aisDisruptions: '1 AIS disruption',
  aisSnapshotAvailable: true,
  description: null,
  officialLatestDate: '2026-10-08',
  officialLatestTotal: 76,
  officialAvg7d: 70.4,
  baselineAvgDaily: 87.4,
  baselineFrom: '2024-10-12',
  baselineTo: '2025-10-11',
  weekMovement: '-13.6% vs prior week',
  partial: false,
  asOf: '2026-10-12T05:02:00.000Z',
};

function builtPage(): string {
  return `<!doctype html><html><body><main>
      <h1>Strait of Hormuz</h1>
${renderChokepointLiveSection({ chokepoint: HORMUZ, pulse: PUBLISHED_PULSE })}
      <a class="cta" href="/dashboard?chokepoint=hormuz_strait">Open</a>
</main></body></html>`;
}

describe('replaceChokepointLiveSection', () => {
  it('refuses pages without exactly one marked section', () => {
    const section = renderChokepointLiveSection({ chokepoint: HORMUZ, pulse: PUBLISHED_PULSE, live: true });
    assert.equal(replaceChokepointLiveSection('<main></main>', section), null);
    assert.equal(replaceChokepointLiveSection(builtPage() + builtPage(), section), null);
  });
});

describe('chokepoint status public shape', () => {
  it('accepts only the bare public marker', () => {
    const base = 'https://www.worldmonitor.app/api/supply-chain/v1/get-chokepoint-status';
    assert.equal(isPublicSharedRpcRequest(`${base}?public=1`), true);
    assert.equal(isPublicSharedRpcRequest(`${base}?public=1&x=1`), false);
    assert.equal(isPublicSharedRpcRequest(base), false);
    assert.equal(isPublicSharedRpcRequest(`${base}?public=1`, 'POST'), false);
  });
});
