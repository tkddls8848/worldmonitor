import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ServerContext } from '../src/generated/server/worldmonitor/world_overview/v1/service_server';
import { WORLD_OVERVIEW_KEYS } from '../shared/world-overview.js';
import { getWorldOverviewSnapshot } from '../server/worldmonitor/world-overview/v1/get-world-overview-snapshot';
import { setWorldOverviewMark } from '../server/worldmonitor/world-overview/v1/set-world-overview-mark';

const NOW = Date.UTC(2026, 10, 22, 15);
const SEED = { sourceVersion: 'world-overview-v1' };
const snapshot = (date: string) => ({
  schemaVersion: 1 as const, date, generatedAt: NOW, countries: { UA: { level: null, deaths: null, cii: null, demonstrations: null, unrest: false, blocs: [], inNews: false,
    issue: { summaryKo: 'issue', fields: ['geopolitics'], sources: [{ url: 'https://example.test/ua', title: 'UA', publisher: 'Fixture' }] } } },
  relations: [{ id: 'ai:tension:CN-US', origin: 'ai', kind: 'tension', basis: undefined, field: 'geopolitics', from: 'CN', to: 'US', directed: false,
    score: 1, value: 1, label: 'fixture relation', confidence: 1,
    sources: [{ url: 'https://example.test/relation', title: 'Relation', publisher: 'Fixture' }] }],
  blocs: [], anchors: { EU: [4.35, 50.85] as [number, number] }, ai: { status: 'missing', date: null, model: null },
  inputs: { relations: { status: 'ok', asOf: null }, trends: { status: 'missing', asOf: null }, ai: { status: 'missing', asOf: null }, ucdp: { status: 'missing', asOf: null }, hapi: { status: 'missing', asOf: null }, cii: { status: 'missing', asOf: null }, news: { status: 'missing', asOf: null } }, availableDates: [],
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
    assert.deepEqual(result.snapshot?.anchors.EU, { longitude: 4.35, latitude: 50.85 });
    assert.equal(result.snapshot?.countries.UA.level, '');
    assert.equal(result.snapshot?.countries.UA.hasDemonstrations, false);
    assert.equal(result.snapshot?.relations[0].hasConfidence, true);
    assert.equal(result.snapshot?.relations[0].confidence, 1);
    assert.equal(result.snapshot?.relations[0].basis, '');
    assert.equal(result.snapshot?.inputs.relations.asOf, undefined);
    assert.deepEqual(result.archivedDates, ['2026-11-21', '2026-11-22']);
    await assert.rejects(getWorldOverviewSnapshot(ctx, { date: '2026-02-30' }, { now: () => NOW, readJson: async () => null }), /INVALID_DATE/);
  });

  it('falls back to yesterday archive at the KST midnight edge until today is published', async () => {
    const yesterday = snapshot('2026-11-22');
    const reads: string[] = [];
    const result = await getWorldOverviewSnapshot(ctx, { date: '' }, { now: () => NOW,
      readJson: async (key) => { reads.push(key); return key === `${WORLD_OVERVIEW_KEYS.archivePrefix}2026-11-22` ? yesterday : null; } });
    assert.equal(result.snapshot?.date, '2026-11-22');
    assert.ok(reads.includes(`${WORLD_OVERVIEW_KEYS.archivePrefix}2026-11-22`));
  });

  it('marks an AI relation, preserves the today envelope, and rewrites only the today key', async () => {
    const today = snapshot('2026-11-23');
    const writes: Array<[string, unknown, number]> = [];
    const result = await setWorldOverviewMark(ctx, { itemKind: 'relation', itemKey: 'ai:tension:CN-US', action: 'mark', markId: '' }, {
      now: () => NOW,
      readMarks: async () => ({ status: 'miss' }),
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
    const deps = { now: () => NOW, readMarks: async () => ({ status: 'miss' } as const), readJson: async () => null, readEnvelope: async () => fixed,
      writeJson: async () => true };
    await assert.rejects(setWorldOverviewMark(ctx, { itemKind: 'relation', itemKey: 'ai:tension:CN-US', action: 'mark', markId: '' }, deps), /NOT_MARKABLE/);
    let saved: unknown;
    const unmarkDeps = { ...deps, readMarks: async () => ({ status: 'hit', value: { marks: [{ id: 'rel:2026-11-22:tension:CN-US', type: 'relation', date: '2026-11-22', matchKey: 'tension:CN-US', sourceUrls: [], summaryKo: '', markedAt: NOW }] } } as const),
      writeJson: async (key: string, value: unknown) => { if (key === WORLD_OVERVIEW_KEYS.marks) saved = value; return true; } };
    const result = await setWorldOverviewMark(ctx, { itemKind: '', itemKey: '', action: 'unmark', markId: 'rel:2026-11-22:tension:CN-US' }, unmarkDeps);
    assert.equal(result.mark?.undoneAt, NOW);
    assert.equal((saved as { marks: Array<{ undoneAt?: number }> }).marks[0].undoneAt, NOW);
  });

  it('does not overwrite existing marks when the marks read fails', async () => {
    const today = snapshot('2026-11-23');
    let writes = 0;
    await assert.rejects(setWorldOverviewMark(ctx, { itemKind: 'relation', itemKey: 'ai:tension:CN-US', action: 'mark', markId: '' }, {
      now: () => NOW,
      readMarks: async () => ({ status: 'error', error: new Error('store timeout') }),
      readJson: async () => null,
      readEnvelope: async () => today,
      writeJson: async () => { writes++; return true; },
    }), /STORE_READ_FAILED/);
    assert.equal(writes, 0);
  });

  it('re-marking a reappeared relation resets the source baseline and hides it', async () => {
    const today = snapshot('2026-11-23');
    today.relations[0].sources.push({ url: 'https://example.test/new-1', title: 'New 1', publisher: 'Fixture' }, { url: 'https://example.test/new-2', title: 'New 2', publisher: 'Fixture' });
    let marksDoc: any = { marks: [{ id: 'rel:2026-11-21:tension:CN-US', type: 'relation', date: '2026-11-21', matchKey: 'tension:CN-US', sourceUrls: ['https://example.test/relation'], summaryKo: 'old', markedAt: NOW - 2 * 86400000 }], updatedAt: NOW };
    let storedSnapshot: any;
    const deps = { now: () => NOW, readMarks: async () => ({ status: 'hit', value: marksDoc } as const), readJson: async () => marksDoc, readEnvelope: async () => today,
      writeJson: async (key: string, value: any) => { if (key === WORLD_OVERVIEW_KEYS.marks) marksDoc = value; else storedSnapshot = value; return true; } };
    const visible = (await getWorldOverviewSnapshot(ctx, { date: '' }, { now: () => NOW, readJson: async (key) => key === WORLD_OVERVIEW_KEYS.snapshot ? today : marksDoc })).snapshot!;
    assert.equal(visible.relations[0].mark?.state, 'reappeared');
    await setWorldOverviewMark(ctx, { itemKind: 'relation', itemKey: 'ai:tension:CN-US', action: 'mark', markId: '' }, deps);
    assert.equal(storedSnapshot.relations[0].mark?.state, 'hidden');
    assert.equal(storedSnapshot.relations[0].mark?.markId, 'rel:2026-11-23:tension:CN-US');
  });

  it('does not rewrite a snapshot that the builder published after the handler read', async () => {
    const initial = snapshot('2026-11-23');
    const published = { ...snapshot('2026-11-23'), generatedAt: NOW + 1 };
    let marksDoc: any = null;
    let snapshotWrites = 0;
    let reads = 0;
    const deps = { now: () => NOW, readMarks: async () => ({ status: 'miss' } as const),
      readJson: async () => null, readEnvelope: async () => reads++ === 0 ? initial : published,
      writeJson: async (key: string, value: any) => { if (key === WORLD_OVERVIEW_KEYS.marks) marksDoc = value; else snapshotWrites++; return true; } };
    await setWorldOverviewMark(ctx, { itemKind: 'relation', itemKey: 'ai:tension:CN-US', action: 'mark', markId: '' }, deps);
    assert.ok(marksDoc);
    assert.equal(snapshotWrites, 0);
    assert.equal(initial.generatedAt, NOW);
  });
});
