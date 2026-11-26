import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  COUNTRY_REFERENCE_SOURCE_VERSION,
  recoverFailedDatasets,
  buildAquastatWbMap,
  fetchEnergyDependencyDataset,
  parseEurostatEnergyDataset,
  shouldSkipSeedYear,
  validateEurostatEnergyEuMemberFloor,
} from '../scripts/seed-country-reference.mjs';

describe('country reference sources and annual refresh', () => {
  it('parses Eurostat energy dependency and keeps the latest TOTAL series value', () => {
    const dataset = {
      id: ['freq', 'siec', 'unit', 'geo', 'time'],
      size: [1, 2, 1, 2, 2],
      dimension: {
        freq: { category: { index: { A: 0 } } },
        siec: { category: { index: { TOTAL: 0, C0110: 1 } } },
        unit: { category: { index: { PC: 0 } } },
        geo: { category: { index: { NO: 0, US: 1 } } },
        time: { category: { index: { 2023: 0, 2024: 1 } } },
      },
      value: {
        0: -15.2,
        1: -13.3,
        2: 7.9,
        3: 8.5,
        5: 999.0,
      },
    };

    const parsed = parseEurostatEnergyDataset(dataset);
    assert.deepEqual(parsed.get('NO'), {
      source: 'eurostat-nrg_ind_id',
      energyImportDependency: {
        value: -13.3,
        year: 2024,
        source: 'eurostat',
      },
    });
    assert.equal(parsed.get('US').energyImportDependency.value, 8.5);
  });

  it('fails the Eurostat EU-member floor before World Bank fallback can mask a parse collapse', () => {
    const parsed = new Map([
      ['NO', { energyImportDependency: { value: -13.3, year: 2024, source: 'eurostat' } }],
      ['US', { energyImportDependency: { value: 8.5, year: 2024, source: 'eurostat' } }],
      ['DE', { energyImportDependency: { value: 45.1, year: 2024, source: 'eurostat' } }],
    ]);

    assert.throws(
      () => validateEurostatEnergyEuMemberFloor(parsed),
      /parsed 1 EU member rows \(expected at least 24\)/,
    );
  });

  it('fails energy dependency when Eurostat is unreachable instead of publishing World Bank-only data', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes('ec.europa.eu/eurostat/')) {
        throw Object.assign(new Error('Eurostat unavailable'), { nonRetryable: true });
      }
      if (href.includes('api.worldbank.org/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { pages: 1 },
            [
              {
                country: { id: 'DE', value: 'Germany' },
                countryiso3code: 'DEU',
                date: '2024',
                value: 63.2,
              },
            ],
          ],
        };
      }
      throw new Error(`Unexpected test URL: ${href}`);
    };

    try {
      await assert.rejects(
        () => fetchEnergyDependencyDataset(),
        /Energy dependency: Eurostat fetch failed: Eurostat unavailable/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails energy dependency when Eurostat parses below the EU floor even if World Bank has data', async () => {
    const collapsedEurostatPayload = {
      id: ['freq', 'siec', 'unit', 'geo', 'time'],
      size: [1, 1, 1, 1, 1],
      dimension: {
        freq: { category: { index: { A: 0 } } },
        siec: { category: { index: { TOTAL: 0 } } },
        unit: { category: { index: { PC: 0 } } },
        geo: { category: { index: { DE: 0 } } },
        time: { category: { index: { 2024: 0 } } },
      },
      value: { 0: 63.2 },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const href = String(url);
      if (href.includes('ec.europa.eu/eurostat/')) {
        return {
          ok: true,
          status: 200,
          json: async () => collapsedEurostatPayload,
        };
      }
      if (href.includes('api.worldbank.org/')) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { pages: 1 },
            [
              {
                country: { id: 'FR', value: 'France' },
                countryiso3code: 'FRA',
                date: '2024',
                value: 44.1,
              },
            ],
          ],
        };
      }
      throw new Error(`Unexpected test URL: ${href}`);
    };

    try {
      await assert.rejects(
        () => fetchEnergyDependencyDataset(),
        /Energy dependency: Eurostat parse\/floor check failed: Eurostat energy dependency parsed 1 EU member rows \(expected at least 24\)/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('skips reruns only after a successful snapshot for the same seed year and source version', () => {
    const v = COUNTRY_REFERENCE_SOURCE_VERSION;
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2026, recordCount: 150, sourceVersion: v }, 2026), true);
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2026, recordCount: 150, sourceVersion: v, failedDatasets: [] }, 2026), true);
    assert.equal(shouldSkipSeedYear({ status: 'error', seedYear: 2026, recordCount: 150, sourceVersion: v }, 2026), false);
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2025, recordCount: 150, sourceVersion: v }, 2026), false);
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2026, recordCount: 150, sourceVersion: 'resilience-static-v1' }, 2026), false);
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2026, recordCount: 150 }, 2026), false);
  });

  it('shouldSkipSeedYear returns false when failedDatasets is non-empty (partial success must retry)', () => {
    const v = COUNTRY_REFERENCE_SOURCE_VERSION;
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2026, recordCount: 150, sourceVersion: v, failedDatasets: ['iea'] }, 2026), false);
    assert.equal(shouldSkipSeedYear({ status: 'ok', seedYear: 2026, recordCount: 150, sourceVersion: v, failedDatasets: ['aquastat', 'iea'] }, 2026), false);
  });

  it('recovers aquastat with WB shape { value, indicator, year } that the scorecard reads', async () => {
    const existingAquastat = { value: 49.22, indicator: 'ER.H2O.FWST.ZS', year: 2022 };
    const maps = { aquastat: new Map() };
    await recoverFailedDatasets(maps, ['aquastat'], {
      readIndex: async () => ({ countries: ['DE'] }),
      readPipeline: async () => [
        { result: JSON.stringify({ seedYear: 2026, seededAt: '2026-10-02T00:00:00.000Z', aquastat: existingAquastat }) },
      ],
    });
    const de = maps.aquastat.get('DE');
    assert.deepEqual(de, {
      ...existingAquastat,
      _recovered: {
        dataset: 'aquastat',
        seedYear: 2026,
        seededAt: '2026-10-02T00:00:00.000Z',
        sourceYears: [2022],
      },
    }, 'DE aquastat should be recovered with provenance');
    assert.ok(typeof de.value === 'number', 'recovered aquastat must have numeric value for the scorecard');
    assert.ok(typeof de.indicator === 'string', 'recovered aquastat must have indicator string for the scorecard');
  });
});
