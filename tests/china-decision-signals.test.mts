import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CHINA_DECISION_SIGNAL_GROUP_IDS,
  CHINA_DECISION_SIGNAL_MAX_SERIALIZED_BYTES,
  composeChinaDecisionSignals,
  isChinaDecisionSignalSnapshot,
} from '../shared/china-decision-signals';
import {
  DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS,
  validateDecisionSignalProvenance,
} from '../shared/decision-signal-provenance';

type Fixture = {
  id: string;
  familyId: string;
  provenance: Record<string, unknown>;
};

const positive = JSON.parse(readFileSync(
  new URL('./fixtures/decision-signal-provenance/positive.json', import.meta.url),
  'utf8',
)) as Fixture[];
const macro = JSON.parse(readFileSync(
  new URL('./fixtures/decision-signal-provenance/china-macro-official.json', import.meta.url),
  'utf8',
)) as Fixture;

function provenance(id: string): Record<string, unknown> {
  const fixture = id === macro.id
    ? macro
    : positive.find((candidate) => candidate.id === id);
  assert.ok(fixture, `missing fixture ${id}`);
  return structuredClone(fixture.provenance);
}

function retarget(
  value: Record<string, unknown>,
  signalId: string,
): Record<string, unknown> {
  value.signalId = signalId;
  const originalReference = (
    value.claims as Record<string, { status: string; value?: Record<string, unknown> }>
  ).original_reference;
  if (originalReference.status === 'known' && originalReference.value) {
    originalReference.value.id = signalId;
  }
  return value;
}

describe('China decision-signal final composition (#5580)', () => {
  it('publishes all six launched domains through one ordered, provenance-valid contract', () => {
    const generatedAt = '2026-07-26T10:45:00Z';
    const macroProvenance = retarget(provenance('china-macro-official-numeric'), 'macro:gdp:2026-q2');
    const policyProvenance = retarget(provenance('typed-document-translated'), 'policy:samr:2026-07');
    const crossStraitProvenance = retarget(provenance('operational-explicit-unknowns'), 'cross-strait:taiwan-mnd:2026-07-25');
    const corporateProvenance = retarget(provenance('exchange-disclosure-superseded'), 'disclosure:sse:600000:2026-07');
    (
      corporateProvenance.claims as Record<string, { status: string; value?: Record<string, unknown> }>
    ).supersession = { status: 'known', value: { state: 'current' } };
    const corridorProvenance = retarget(provenance('corridor-stale-content'), 'corridor:shanghai-port:2026-07-26');

    const snapshot = composeChinaDecisionSignals({
      generatedAt,
      macro: {
        unavailable: false,
        indicators: [{
          label: 'Industrial production',
          value: 5.4,
          unit: '%',
          category: 'activity',
          direction: 'strengthening',
          vintageId: '2026-06:v1',
          provenanceJson: JSON.stringify(macroProvenance),
        }],
      },
      policy: {
        agencies: { SAMR: { status: 'ok' } },
        events: [{
          lineageId: 'samr-guidance-2026',
          titleTranslated: 'Market enforcement guidance',
          agency: 'SAMR',
          actionType: 'announcement_guidance',
          status: 'announced',
          supersession: { state: 'current' },
          sectors: [],
          entities: [],
          provenance: policyProvenance,
        }],
      },
      crossStrait: {
        status: 'healthy',
        coverage: { usableMndReportingDays: 91 },
        baselines: {
          semantics: 'prior-usable-reporting-days-excluding-current',
          categories: {
            plaAircraftSorties: {
              windows: {
                30: {
                  state: 'sufficient',
                  ratio: 1.8,
                  difference: 8,
                },
                90: {
                  state: 'insufficient_data',
                  ratio: null,
                  difference: null,
                },
              },
            },
          },
        },
        observations: [{
          sourceId: 'taiwan-mnd',
          observationKind: 'official_daily_claim',
          reportingDay: '2026-07-25',
          summary: 'Taiwan MND daily activity claim',
          categories: { plaAircraftSorties: 18, planShips: 7 },
          provenance: crossStraitProvenance,
        }],
      },
      corporate: {
        status: 'healthy',
        events: [{
          announcementId: 'sse-600000-2026-07',
          exchange: 'SSE',
          issuer: { symbol: '600000', name: 'Example issuer' },
          disclosureType: 'investigation',
          status: 'current',
          titleOriginal: '关于立案调查的公告',
          provenance: corporateProvenance,
        }],
      },
      corridors: {
        corridors: [{
          id: 'shanghai-export',
          name: 'Shanghai export corridor',
          availability: 'available',
          conditions: [{
            family: 'port',
            availability: 'stale',
            summary: 'Port calls below recent baseline',
            provenance: corridorProvenance,
          }],
        }],
      },
      nowcast: {
        methodVersion: 'china-activity-nowcast/v1',
        evaluatedAt: generatedAt,
        comparisonWindow: { endsAt: generatedAt },
        state: 'agreement',
        official: { provenance: macroProvenance },
        contributions: [{
          included: true,
          observationId: 'corridor:shanghai-port:2026-07-26',
          provenance: corridorProvenance,
        }],
        confidence: { level: 'high' },
        missingInputs: [],
        sensitivity: [],
        limitations: ['Directional comparison only.'],
        audit: { deterministic: true, llmNumericComputation: false },
      },
    });

    assert.equal(isChinaDecisionSignalSnapshot(snapshot), true);
    assert.equal(isChinaDecisionSignalSnapshot({
      ...snapshot,
      access: { ...snapshot.access, operator: 'bounded_public_summary' },
    }), false);
    const tampered = structuredClone(snapshot);
    tampered.groups[0].items[0].sourceName = 'Relabeled source';
    assert.equal(isChinaDecisionSignalSnapshot(tampered), false);
    assert.deepEqual(snapshot.groups.map((candidate) => candidate.id), CHINA_DECISION_SIGNAL_GROUP_IDS);
    assert.deepEqual(
      snapshot.groups.map((candidate) => candidate.state),
      // cross-strait-activity is 'stale', not 'available': its item's content
      // freshness is 'timestamp_unknown', which must not be treated as fresh.
      ['available', 'available', 'stale', 'available', 'stale', 'available'],
    );
    assert.equal(
      snapshot.groups.find((candidate) => candidate.id === 'cross-strait-activity')
        ?.items[0]?.stale,
      true,
      'an unknown content timestamp is reported as stale, not fabricated as fresh',
    );
    assert.deepEqual(snapshot.access, {
      anonymous: 'bounded_public_summary',
      pro: 'same_provenance_via_mcp',
      operator: 'source_health_only',
    });
    assert.equal(snapshot.groups.every((candidate) => candidate.items.length === 1), true);
    assert.deepEqual(
      snapshot.groups.find((candidate) => candidate.id === 'cross-strait-activity')
        ?.metadata.baselineBands,
      [
        {
          category: 'plaAircraftSorties',
          windowDays: 30,
          state: 'sufficient',
          band: 'elevated',
          difference: 8,
          ratio: 1.8,
        },
        {
          category: 'plaAircraftSorties',
          windowDays: 90,
          state: 'insufficient_data',
          band: 'insufficient_data',
          difference: null,
          ratio: null,
        },
      ],
    );
    for (const item of snapshot.groups.flatMap((candidate) => candidate.items)) {
      assert.equal(validateDecisionSignalProvenance(item.provenance).ok, true);
      assert.ok(item.sourceName);
      assert.ok(item.publisherType);
      assert.equal(Object.hasOwn(item.metadata, 'revision'), true);
      assert.equal(Object.hasOwn(item.metadata, 'supersession'), true);
      assert.equal(Object.hasOwn(item.metadata, 'corroboration'), true);
    }
    const nowcast = snapshot.groups.at(-1)?.items[0];
    assert.equal(nowcast?.provenance.familyId, 'derived_comparison');
    assert.deepEqual(
      (
        nowcast?.provenance.claims.derivation as {
          status: 'known';
          value: { inputSignalIds: string[] };
        }
      ).value.inputSignalIds,
      ['macro:gdp:2026-q2', 'corridor:shanghai-port:2026-07-26'],
    );
  });

  it('fails closed per domain without hiding unrelated healthy groups', () => {
    const policyProvenance = retarget(provenance('typed-document-translated'), 'policy:samr:valid');
    const snapshot = composeChinaDecisionSignals({
      generatedAt: '2026-07-26T10:45:00Z',
      policy: {
        agencies: { SAMR: { status: 'ok' } },
        events: [
          {
            lineageId: 'valid',
            titleOriginal: 'Valid reviewed event',
            agency: 'SAMR',
            actionType: 'final_rule',
            status: 'in_force',
            supersession: { state: 'current' },
            sectors: [],
            entities: [],
            provenance: policyProvenance,
          },
          {
            lineageId: 'invalid',
            titleOriginal: 'Invalid event',
            supersession: { state: 'current' },
            sectors: [],
            entities: [],
            provenance: { signalId: 'missing-contract' },
          },
        ],
      },
    });

    const policy = snapshot.groups.find((candidate) => candidate.id === 'policy-enforcement');
    assert.equal(policy?.state, 'partial');
    assert.equal(policy?.items.length, 1);
    assert.equal(policy?.metadata.rejectedItemCount, 1);
    assert.match(policy?.reason ?? '', /failed the launch\/provenance boundary/);
    assert.equal(
      snapshot.groups.filter((candidate) => candidate.id !== 'policy-enforcement')
        .every((candidate) => candidate.state === 'unavailable'),
      true,
      'an outage in one domain does not manufacture data in another',
    );
  });

  it('distinguishes quiet disclosures, rejected provenance, upstream loss, and insufficient nowcast inputs', () => {
    const generatedAt = '2026-07-30T15:30:00Z';
    const corporateGroup = (corporate: unknown) => composeChinaDecisionSignals({
      generatedAt,
      corporate,
    }).groups.find((candidate) => candidate.id === 'corporate-disclosures');

    const quiet = corporateGroup({
      status: 'healthy',
      coverageThrough: '2026-07-30',
      sources: [
        { id: 'sse', launchStatus: 'launched', transportStatus: 'fresh', contentStatus: 'current' },
        { id: 'szse', launchStatus: 'launched', transportStatus: 'fresh', contentStatus: 'current' },
      ],
      events: [],
    });
    assert.equal(quiet?.state, 'unavailable');
    assert.equal(quiet?.metadata.unavailableCause, 'healthy_quiet_window');
    assert.match(quiet?.reason ?? '', /^healthy_quiet_window:/);

    const rejected = corporateGroup({
      status: 'healthy',
      events: [{
        announcementId: 'sse-invalid-provenance',
        exchange: 'SSE',
        status: 'current',
        titleOriginal: 'Invalid provenance fixture',
        provenance: { signalId: 'missing-contract' },
      }],
    });
    assert.equal(rejected?.state, 'unavailable');
    assert.equal(rejected?.metadata.unavailableCause, 'provenance_rejected');
    assert.equal(rejected?.metadata.rejectedItemCount, 1);
    assert.match(rejected?.reason ?? '', /^provenance_rejected:/);

    const upstream = corporateGroup(null);
    assert.equal(upstream?.state, 'unavailable');
    assert.equal(upstream?.metadata.unavailableCause, 'upstream_unavailable');
    assert.equal(Object.hasOwn(upstream?.metadata ?? {}, 'rejectedItemCount'), false);
    assert.match(upstream?.reason ?? '', /^upstream_unavailable:/);

    const nonCorporateUpstream = composeChinaDecisionSignals({
      generatedAt,
      macro: { unavailable: true, indicators: [] },
    }).groups.find((candidate) => candidate.id === 'macro');
    assert.equal(nonCorporateUpstream?.state, 'unavailable');
    assert.equal(nonCorporateUpstream?.metadata.unavailableCause, 'upstream_unavailable');
    assert.equal(Object.hasOwn(nonCorporateUpstream?.metadata ?? {}, 'rejectedItemCount'), false);
    assert.match(nonCorporateUpstream?.reason ?? '', /^upstream_unavailable:/);

    const explicitNull = composeChinaDecisionSignals({
      generatedAt,
      macro: null,
      policy: null,
      crossStrait: null,
    });
    for (const id of ['macro', 'policy-enforcement', 'cross-strait-activity']) {
      const group = explicitNull.groups.find((candidate) => candidate.id === id);
      assert.equal(group?.metadata.unavailableCause, 'upstream_unavailable');
      assert.match(group?.reason ?? '', /^upstream_unavailable:/);
    }

    for (const malformed of [undefined, 'not-a-snapshot']) {
      const indeterminate = composeChinaDecisionSignals({
        generatedAt,
        macro: malformed,
        policy: malformed,
        crossStrait: malformed,
      });
      for (const id of ['macro', 'policy-enforcement', 'cross-strait-activity']) {
        const group = indeterminate.groups.find((candidate) => candidate.id === id);
        assert.equal(group?.metadata.unavailableCause, 'unknown');
      }
    }

    const nowcast = composeChinaDecisionSignals({
      generatedAt,
      nowcast: {
        methodVersion: 'china-activity-nowcast/v1',
        evaluatedAt: generatedAt,
        comparisonWindow: { endsAt: generatedAt },
        state: 'insufficient_data',
        confidence: {
          level: 'insufficient',
          reason: 'Two eligible proxy families are required.',
        },
        missingInputs: [
          {
            family: 'maritime',
            seriesId: 'portwatch_tanker_calls_trend',
            reason: 'freshness_budget_exceeded',
          },
          {
            family: 'energy',
            seriesId: 'china_energy_demand_change',
            reason: 'marked_stale',
          },
        ],
        contributions: [],
        sensitivity: [],
        limitations: [],
        audit: { deterministic: true, llmNumericComputation: false },
      },
    }).groups.find((candidate) => candidate.id === 'activity-nowcast');

    assert.equal(nowcast?.state, 'unavailable');
    assert.equal(nowcast?.metadata.unavailableCause, 'insufficient_data');
    assert.equal(Object.hasOwn(nowcast?.metadata ?? {}, 'rejectedItemCount'), false);
    assert.deepEqual(nowcast?.metadata.missingInputFamilies, ['maritime', 'energy']);
    assert.deepEqual(nowcast?.metadata.missingInputs, [
      {
        family: 'maritime',
        seriesId: 'portwatch_tanker_calls_trend',
        reason: 'freshness_budget_exceeded',
      },
      {
        family: 'energy',
        seriesId: 'china_energy_demand_change',
        reason: 'marked_stale',
      },
    ]);
    assert.match(nowcast?.reason ?? '', /^insufficient_data:/);
    assert.match(nowcast?.reason ?? '', /maritime.*freshness_budget_exceeded/);
    assert.match(nowcast?.reason ?? '', /energy.*marked_stale/);
  });

  it('bounds nowcast missing inputs and preserves unavailable diagnostics through metadata compaction', () => {
    const generatedAt = '2026-07-30T15:30:00Z';
    const validMissingInputs = Array.from({ length: 18 }, (_, index) => ({
      family: `family-${index}-${'f'.repeat(100)}`,
      seriesId: `series-${index}-${'s'.repeat(140)}`,
      reason: `reason-${index}-${'r'.repeat(140)}`,
    }));
    const bounded = composeChinaDecisionSignals({
      generatedAt,
      nowcast: {
        state: 'insufficient_data',
        confidence: { level: 'insufficient' },
        missingInputs: [null, {}, { family: '' }, ...validMissingInputs],
      },
    }).groups.find((candidate) => candidate.id === 'activity-nowcast');
    const boundedMissingInputs = bounded?.metadata.missingInputs as Array<Record<string, unknown>>;
    assert.equal(boundedMissingInputs.length, 16);
    assert.deepEqual(boundedMissingInputs[0], {
      family: validMissingInputs[0].family.slice(0, 80),
      seriesId: validMissingInputs[0].seriesId.slice(0, 120),
      reason: validMissingInputs[0].reason.slice(0, 120),
    });
    assert.equal(boundedMissingInputs.at(-1)?.family, validMissingInputs[15].family.slice(0, 80));

    const snapshot = composeChinaDecisionSignals({
      generatedAt,
      nowcast: {
        methodVersion: 'china-activity-nowcast/v1',
        evaluatedAt: generatedAt,
        comparisonWindow: { endsAt: generatedAt },
        state: 'insufficient_data',
        confidence: {
          level: 'insufficient',
          coverage: 'coverage'.repeat(10_000),
        },
        missingInputs: [null, {}, { family: '' }, ...validMissingInputs],
        contributions: [],
        sensitivity: [],
        limitations: [],
        audit: { deterministic: true, llmNumericComputation: false },
      },
    });
    const nowcast = snapshot.groups.find((candidate) => candidate.id === 'activity-nowcast');

    assert.equal(nowcast?.state, 'unavailable');
    assert.equal(nowcast?.metadata.metadataOmittedForSerialization, true);
    assert.equal(nowcast?.metadata.unavailableCause, 'insufficient_data');
    assert.deepEqual(
      nowcast?.metadata.missingInputFamilies,
      validMissingInputs.slice(0, 16).map((candidate) => candidate.family.slice(0, 80)),
    );
    assert.deepEqual(
      nowcast?.metadata.missingInputs,
      validMissingInputs.slice(0, 16).map((candidate) => ({
        family: candidate.family.slice(0, 80),
        seriesId: candidate.seriesId.slice(0, 120),
        reason: candidate.reason.slice(0, 120),
      })),
    );
    assert.equal(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <= CHINA_DECISION_SIGNAL_MAX_SERIALIZED_BYTES, true);

    const fallback = composeChinaDecisionSignals({
      generatedAt,
      nowcast: {
        state: 'insufficient_data',
        confidence: { level: 'insufficient' },
        missingInputs: [null, {}, { family: '' }],
      },
    }).groups.find((candidate) => candidate.id === 'activity-nowcast');
    assert.match(fallback?.reason ?? '', /^insufficient_data: Deterministic input requirements/);
  });

  it('launches the existing deterministic comparison family only at the final composition boundary', () => {
    assert.equal(
      DECISION_SIGNAL_PROVENANCE_FAMILY_REGISTRATIONS.derived_comparison.launchStatus,
      'launched',
    );
  });

});
