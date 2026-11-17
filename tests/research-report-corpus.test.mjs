// /research/ report family (issue #5668): fail-closed handling of missing
// data and the snapshot helpers. The rendered-page contract ran against the
// crawl corpus build, which left the personal build.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  assertNoUnresolvedTokens,
  computeReportMetrics,
  mean,
  resolveMetricTokens,
  renderResearchReportPage,
} from '../scripts/build-research-reports.mjs';
import {
  enumerateMissingDates,
  fetchAllPages as snapshotFetchAllPages,
  serializeSnapshot,
} from '../scripts/build-chokepoint-transit-snapshot.mjs';
import { fetchAllPages as seederFetchAllPages } from '../scripts/seed-portwatch.mjs';
import { RESEARCH_REPORTS } from '../shared/research-reports/index.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const report = RESEARCH_REPORTS[0];
const snapshot = JSON.parse(readFileSync(join(repoRoot, report.snapshotPath), 'utf8'));

describe('research report corpus (#5668)', () => {
  it('rejects a declared comparison without a canonical tracker route', () => {
    assert.throws(() => renderResearchReportPage({
      report, snapshot, tpl: {},
      chokepointSlugById: new Map([['hormuz_strait', 'strait-of-hormuz']]),
    }), /contextChokepointId bab_el_mandeb.*chokepoint registry/);
  });

  it('fails closed on unresolved tokens and missing snapshot series', () => {
    const escapeHtml = (value) => String(value);
    assert.throws(
      () => resolveMetricTokens('before {{m:doesNotExist}} after', new Map(), escapeHtml),
      /Unresolved metric token: doesNotExist/,
    );
    // Tokens the resolver regex does not recognize must still fail the build
    // via the document-level backstop, never ship literally.
    assert.throws(() => assertNoUnresolvedTokens('x {{m:snake_case}} y'), /Unresolved metric token/);
    assert.throws(() => assertNoUnresolvedTokens('x {{m: spaced}} y'), /Unresolved metric token/);
    // Averaging an empty window is a build failure, not a fabricated zero.
    assert.throws(() => mean([], 'total'), /refusing to fabricate/);
    // A wrong-edition report or snapshot trips the metric-window guard instead
    // of silently republishing the pilot's analysis under a new title.
    assert.throws(
      () => computeReportMetrics({ ...snapshot, edition: '2026-08' }, report),
      /edition/,
    );
    assert.throws(
      () => computeReportMetrics({ chokepoints: {} }, report),
      /edition/,
    );
    assert.throws(
      () => computeReportMetrics({ ...snapshot, chokepoints: {} }, report),
      /no focus chokepoint/,
    );
    const truncated = {
      ...snapshot,
      chokepoints: {
        ...snapshot.chokepoints,
        [report.focusChokepointId]: {
          ...snapshot.chokepoints[report.focusChokepointId],
          history: snapshot.chokepoints[report.focusChokepointId].history.filter(
            (row) => row.date < '2026-02-01',
          ),
        },
      },
    };
    assert.throws(
      () => computeReportMetrics(truncated, report),
      /incomplete daily coverage/,
      'a snapshot missing the observation window must fail the build, not render empties',
    );
  });

  it('fails closed when any published series has an interior calendar gap', () => {
    const missingDate = '2026-06-15';
    const publishedSeriesIds = [
      report.focusChokepointId,
      report.contextChokepointIds[0],
    ];

    for (const id of publishedSeriesIds) {
      const incomplete = structuredClone(snapshot);
      const series = incomplete.chokepoints[id];
      series.history = series.history.filter((row) => row.date !== missingDate);
      series.rowCount = series.history.length;

      assert.throws(
        () => computeReportMetrics(incomplete, report),
        new RegExp(`${id}.*incomplete daily coverage.*${missingDate}`, 'i'),
        `${id}: a missing interior day must fail the report build even when metadata omits the gap`,
      );
    }
  });

  it('fails closed when a published series contains an impossible calendar date', () => {
    const invalidDate = '2026-02-30';
    const invalid = structuredClone(snapshot);
    const series = invalid.chokepoints[report.focusChokepointId];
    const insertionIndex = series.history.findIndex((row) => row.date === '2026-03-01');
    series.history.splice(insertionIndex, 0, {
      ...series.history[insertionIndex - 1],
      date: invalidDate,
    });
    series.rowCount = series.history.length;

    assert.throws(
      () => computeReportMetrics(invalid, report),
      new RegExp(`${report.focusChokepointId}.*invalid observation date.*${invalidDate}`, 'i'),
    );
  });

  // Regression: the ArcGIS layer's server-side maxRecordCount (1000) is below
  // the requested page size, so advancing offset by PAGE_SIZE instead of the
  // rows actually returned silently skipped rows 1000-1999 (a contiguous
  // 1000-day hole) on any multi-page query. Both fetch loops must advance by
  // the returned row count.
  it('ArcGIS pagination advances by returned rows, not by requested page size', async () => {
    const makeFeature = (index) => ({ attributes: { date: 1714521600000 + index * 86_400_000 } });
    for (const fetchAllPages of [snapshotFetchAllPages, seederFetchAllPages]) {
      const offsets = [];
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        const offset = Number(new URL(url).searchParams.get('resultOffset'));
        offsets.push(offset);
        const page = offset === 0
          ? { exceededTransferLimit: true, features: Array.from({ length: 1000 }, (_, i) => makeFeature(i)) }
          : { exceededTransferLimit: false, features: Array.from({ length: 757 }, (_, i) => makeFeature(offset + i)) };
        return { ok: true, json: async () => page };
      };
      try {
        const features = await fetchAllPages('Strait of Hormuz', fetchAllPages === seederFetchAllPages ? 0 : '2019-01-01');
        assert.deepEqual(offsets, [0, 1000], 'second request must start where the server actually stopped');
        assert.equal(features.length, 1757, 'no rows may be skipped across the page boundary');
      } finally {
        global.fetch = originalFetch;
      }
    }
  });

  it('snapshot producer helpers enumerate gaps and round-trip valid JSON', () => {
    const gaps = enumerateMissingDates([
      { date: '2026-01-01' },
      { date: '2026-01-02' },
      { date: '2026-01-05' },
    ]);
    assert.deepEqual(gaps, ['2026-01-03', '2026-01-04']);
    const roundTrip = JSON.parse(serializeSnapshot(snapshot));
    assert.deepEqual(roundTrip, snapshot);
  });
});
