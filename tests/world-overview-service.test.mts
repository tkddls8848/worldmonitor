import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ServerContext, WorldOverviewSnapshot } from '../src/generated/server/worldmonitor/world_overview/v1/service_server';
import { WORLD_OVERVIEW_KEYS } from '../shared/world-overview.js';
import { getWorldOverviewSnapshot } from '../server/worldmonitor/world-overview/v1/get-world-overview-snapshot';
import { setWorldOverviewMark } from '../server/worldmonitor/world-overview/v1/set-world-overview-mark';

const NOW = Date.UTC(2026, 10, 22, 15);
const SEED = { sourceVersion: 'world-overview-v1' };
const snapshot = (date: string): WorldOverviewSnapshot => ({
  schemaVersion: 1, date, generatedAt: NOW, countries: { UA: { level: '', demonstrations: 0, hasDemonstrations: false, unrest: false, blocs: [], inNews: false,
    issue: { summaryKo: 'issue', fields: ['geopolitics'], sources: [{ url: 'https://example.test/ua', title: 'UA', publisher: 'Fixture' }] } } },
  relations: [{ id: 'ai:tension:CN-US', origin: 'ai', kind: 'tension', basis: '', field: 'geopolitics', from: 'CN', to: 'US', directed: false,
    score: 1, value: 1, label: 'fixture relation', confidence: 1, hasConfidence: true,
    sources: [{ url: 'https://example.test/relation', title: 'Relation', publisher: 'Fixture' }] }],
  blocs: [], anchors: {}, inputs: {}, availableDates: [],
});
const ctx = {} as ServerContext;

describe('WorldOverviewService handlers', () => {
  it('validates dates and reads the archive snapshot with current mark annotations', async () => {
    const reads: string[] = [];
    const past = snapshot('2026-11-22');
    const result = await getWorldOverviewSnapshot(ctx, { date: '2026-11-22' }, {
      now: () => NOW,
      readJson: async (key) => {
        reads.push(key);
        if (key === `${WORLD_OVERVIEW_KEYS.archivePrefix}2026-11-22`) return past;
        if (key === WORLD_OVERVIEW_KEYS.marks) return { marks: [{ id: 'issue:2026-11-22:UA', type: 'issue', date: '2026-11-22', iso2: 'UA', sourceUrls: [], summaryKo: 'wrong', markedAt: NOW }] };
        if (key === WORLD_OVERVIEW_KEYS.dates) return ['2026-11-21', '2026-11-22', '2026-11-23'];
        return null;
      },
    });
    assert.deepEqual(reads, [`${WORLD_OVERVIEW_KEYS.archivePrefix}2026-11-22`, WORLD_OVERVIEW_KEYS.marks, WORLD_OVERVIEW_KEYS.dates]);
    assert.equal(result.snapshot?.countries.UA.issue?.mark?.state, 'hidden');
    assert.deepEqual(result.archivedDates, ['2026-11-21', '2026-11-22']);
    await assert.rejects(getWorldOverviewSnapshot(ctx, { date: '2026-02-30' }, { now: () => NOW, readJson: async () => null }), /INVALID_DATE/);
  });

  it('marks an AI relation, preserves the today envelope, and rewrites only the today key', async () => {
    const today = snapshot('2026-11-23');
    const writes: Array<[string, unknown, number]> = [];
    const result = await setWorldOverviewMark(ctx, { itemKind: 'relation', itemKey: 'ai:tension:CN-US', action: 'mark', markId: '' }, {
      now: () => NOW,
      readJson: async () => null,
      readEnvelope: async () => ({ _seed: SEED, data: today }),
      writeJson: async (key, value, ttl) => { writes.push([key, value, ttl]); return true; },
    });
    assert.equal(result.ok, true);
    assert.equal(result.mark?.id, 'rel:2026-11-23:tension:CN-US');
    assert.deepEqual(writes.map(([key, , ttl]) => [key, ttl]), [
      [WORLD_OVERVIEW_KEYS.marks, 34_560_000], [WORLD_OVERVIEW_KEYS.snapshot, 172_800],
    ]);
    const stored = writes[1][1] as { _seed: unknown; data: WorldOverviewSnapshot };
    assert.deepEqual(stored._seed, SEED);
    assert.equal(stored.data.relations[0].mark?.state, 'hidden');
  });

  it('rejects fixed relation marks and unmarks using the persisted mark id', async () => {
    const today = snapshot('2026-11-23');
    const fixed = { ...today, relations: today.relations.map((line) => ({ ...line, origin: 'fixed' })) };
    const deps = { now: () => NOW, readJson: async () => null, readEnvelope: async () => fixed,
      writeJson: async () => true };
    await assert.rejects(setWorldOverviewMark(ctx, { itemKind: 'relation', itemKey: 'ai:tension:CN-US', action: 'mark', markId: '' }, deps), /NOT_MARKABLE/);
    let saved: unknown;
    const unmarkDeps = { ...deps, readJson: async () => ({ marks: [{ id: 'rel:2026-11-22:tension:CN-US', type: 'relation', date: '2026-11-22', matchKey: 'tension:CN-US', sourceUrls: [], summaryKo: '', markedAt: NOW }] }),
      writeJson: async (key: string, value: unknown) => { if (key === WORLD_OVERVIEW_KEYS.marks) saved = value; return true; } };
    const result = await setWorldOverviewMark(ctx, { itemKind: '', itemKey: '', action: 'unmark', markId: 'rel:2026-11-22:tension:CN-US' }, unmarkDeps);
    assert.equal(result.mark?.undoneAt, NOW);
    assert.equal((saved as { marks: Array<{ undoneAt?: number }> }).marks[0].undoneAt, NOW);
  });
});
