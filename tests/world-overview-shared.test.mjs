import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addDays, annotateWrongMarks, applyMarkAction, countryFill, DEFAULT_FIELDS, isDrawableEndpoint,
  kstDate, kstHour, pairKey, relationMatchKey, selectVisibleLines, WORLD_FIELDS, WORLD_OVERVIEW_KEYS,
} from '../shared/world-overview.js';

const codes = Object.keys(JSON.parse(readFileSync(new URL('../shared/iso2-to-iso3.json', import.meta.url), 'utf8')));
let offset = 0;
function line(field, n) {
  const kind = { military: 'support', diplomacy: 'alliance', geopolitics: 'tension', finance: 'sanction' }[field];
  return Array.from({ length: n }, (_, i) => {
    const a = codes[(offset + i * 2) % codes.length], b = codes[(offset + i * 2 + 1) % codes.length];
    return { id: `fixed:${kind}:${a}-${b}`, origin: 'fixed', kind, field, from: a, to: b, directed: false, score: 1 - i / 100, value: n - i, label: '관계', sources: [], trend: null };
  }).map((item) => item);
}
function snap(relations, extra = {}) { return { schemaVersion: 1, date: '2026-11-22', generatedAt: 0, countries: {}, relations, blocs: [], anchors: { EU: [4.35, 50.85] }, ai: { status: 'missing', date: null, model: null }, inputs: {}, availableDates: [], ...extra }; }
function count(lines) { return Object.fromEntries(['military', 'diplomacy', 'geopolitics', 'finance'].map((f) => [f, lines.filter((x) => x.field === f).length]).filter(([, n]) => n)); }
function aiTension(a, b, confidence, urls = ['https://a']) { return { id: `ai:tension:${[a, b].sort().join('-')}`, origin: 'ai', kind: 'tension', field: 'geopolitics', from: [a, b].sort()[0], to: [a, b].sort()[1], directed: false, score: 1 + confidence, value: confidence, confidence, label: 'AI 긴장 관계', sources: urls.map((url) => ({ url, title: '기사', publisher: '출처' })), trend: null }; }
function fixedTension(a, b, score) { return { ...aiTension(a, b, 0), id: `fixed:tension:${[a, b].sort().join('-')}`, origin: 'fixed', score, sources: [] }; }
function sanction(issuer, target) { return { ...fixedTension(issuer, target, 1), id: `fixed:sanction:${issuer}>${target}`, kind: 'sanction', field: 'finance', from: issuer, to: target, directed: true }; }
const l1 = aiTension('CN', 'US', 0.8), l2 = aiTension('JP', 'KR', 0.7);
function withIssue(iso2, date) { return snap([], { date, countries: { [iso2]: { level: null, deaths: null, cii: null, demonstrations: null, unrest: false, blocs: [], inNews: false, issue: { summaryKo: '이슈', fields: ['military'], sources: [] } } } }); }

test('kstDate switches at 15:00 UTC', () => { assert.equal(kstDate(Date.parse('2026-11-22T14:59:59Z')), '2026-11-22'); assert.equal(kstDate(Date.parse('2026-11-22T15:00:00Z')), '2026-11-23'); assert.equal(kstHour(Date.parse('2026-11-22T21:00:00Z')), 6); });
test('addDays crosses months and years', () => { assert.equal(addDays('2026-11-22', 13), '2026-12-05'); assert.equal(addDays('2026-12-31', 1), '2027-01-01'); assert.equal(addDays('2026-11-22', -89), '2026-08-25'); });
test('pairKey is order-independent', () => assert.equal(pairKey('UA', 'RU'), 'RU:UA'));
test('the default fields give all 30 slots to 지정학 when 군사 has no lines', () => { offset = 0; assert.equal(selectVisibleLines(snap(line('geopolitics', 50)), DEFAULT_FIELDS).length, 30); });
test('a field with few lines gives its unused share to the other enabled field', () => { offset = 0; const got = selectVisibleLines(snap([...line('military', 5), ...line('geopolitics', 50)]), DEFAULT_FIELDS); assert.deepEqual(count(got), { military: 5, geopolitics: 25 }); });
test('four line fields split 30 as 8, 8, 7, 7 in field order; 정치 adds nothing', () => { offset = 0; const all = [...line('military', 40), ...line('diplomacy', 40), ...line('geopolitics', 40), ...line('finance', 40)]; assert.deepEqual(count(selectVisibleLines(snap(all), WORLD_FIELDS)), { military: 8, diplomacy: 8, geopolitics: 7, finance: 7 }); });
test('hidden lines take no slot, reappeared lines do, UN is never drawn and EU uses its anchor', () => { const rel = [{ ...l1, mark: { state: 'hidden' } }, { ...l2, mark: { state: 'reappeared' } }, sanction('UN', 'KP'), sanction('EU', 'RU')]; const ids = selectVisibleLines(snap(rel), ['geopolitics', 'finance']).map((x) => x.id); assert.ok(!ids.includes(l1.id) && ids.includes(l2.id) && ids.includes('fixed:sanction:EU>RU') && !ids.includes('fixed:sanction:UN>KP')); assert.equal(isDrawableEndpoint('UN', { EU: [4.35, 50.85] }), false); });
test('an AI line wins over the fixed line of the same kind and pair', () => { const got = selectVisibleLines(snap([aiTension('US', 'CN', 0.8), fixedTension('CN', 'US', 1)]), ['geopolitics']); assert.deepEqual(got.map((x) => x.id), ['ai:tension:CN-US']); });
test('country fill: level first, then 이슈 있음 from a visible AI issue or from the news', () => { assert.equal(countryFill({ level: 'war', issue: null, inNews: false }), 'war'); assert.equal(countryFill({ level: null, issue: { mark: undefined }, inNews: false }), 'issue'); assert.equal(countryFill({ level: null, issue: { mark: { state: 'hidden' } }, inNews: true }), null); assert.equal(countryFill({ level: null, issue: null, inNews: true }), 'issue'); assert.equal(countryFill({ level: null, issue: null, inNews: false }), null); });
test('a relation mark hides the same pair and kind for 14 days and lets it reappear with 2 new sources', () => { const mark = { id: 'rel:2026-11-22:tension:CN-US', type: 'relation', date: '2026-11-22', matchKey: 'tension:CN-US', sourceUrls: ['https://a'], summaryKo: '…', markedAt: 1 }; const doc = { marks: [mark], updatedAt: 1 }; const state = (date, urls) => annotateWrongMarks(snap([aiTension('US', 'CN', 0.8, urls)], { date }), doc).relations[0].mark?.state; assert.equal(state('2026-11-21', ['https://a']), undefined); assert.equal(state('2026-11-22', ['https://a']), 'hidden'); assert.equal(state('2026-12-05', ['https://a', 'https://b']), 'hidden'); assert.equal(state('2026-11-25', ['https://a', 'https://b', 'https://c']), 'reappeared'); assert.equal(state('2026-12-06', ['https://a']), undefined); assert.equal(annotateWrongMarks(snap([aiTension('US', 'CN', 0.8, ['https://a'])], { date: '2026-11-22' }), { marks: [{ ...mark, undoneAt: 2 }] }).relations[0].mark, undefined); });
test('an issue mark hides that date only; fixed lines are never annotated; annotation is idempotent', () => { const doc = { marks: [{ id: 'issue:2026-11-22:UA', type: 'issue', date: '2026-11-22', iso2: 'UA', sourceUrls: [], summaryKo: '…', markedAt: 1 }] }; assert.equal(annotateWrongMarks(withIssue('UA', '2026-11-22'), doc).countries.UA.issue.mark.state, 'hidden'); assert.equal(annotateWrongMarks(withIssue('UA', '2026-11-23'), doc).countries.UA.issue.mark, undefined); const once = annotateWrongMarks(withIssue('UA', '2026-11-22'), doc); assert.deepEqual(annotateWrongMarks(once, doc), once); assert.deepEqual(annotateWrongMarks(once, { marks: [] }).countries.UA.issue.mark, undefined); });
test('mark, unmark and re-mark keep one record per date and target', () => { const s = snap([aiTension('US', 'CN', 0.8), fixedTension('CN', 'US', 1)], { date: '2026-11-22' }); const m = applyMarkAction(null, { action: 'mark', date: '2026-11-22', target: { type: 'relation', relationId: 'ai:tension:CN-US' } }, s, 100); assert.equal(m.mark.id, 'rel:2026-11-22:tension:CN-US'); assert.deepEqual(m.mark.sourceUrls, ['https://a']); assert.deepEqual(applyMarkAction(m.doc, { action: 'mark', date: '2026-11-22', target: { type: 'relation', relationId: 'fixed:tension:CN-US' } }, s, 101), { ok: false, error: 'NOT_MARKABLE' }); assert.deepEqual(applyMarkAction(m.doc, { action: 'mark', date: '2026-11-22', target: { type: 'relation', relationId: 'ai:x' } }, s, 101), { ok: false, error: 'TARGET_NOT_FOUND' }); const u = applyMarkAction(m.doc, { action: 'unmark', markId: m.mark.id }, s, 200); assert.equal(u.doc.marks.length, 1); assert.equal(u.doc.marks[0].undoneAt, 200); const again = applyMarkAction(u.doc, { action: 'mark', date: '2026-11-22', target: { type: 'relation', relationId: 'ai:tension:CN-US' } }, s, 300); assert.equal(again.doc.marks.length, 1); assert.equal(again.doc.marks[0].undoneAt, undefined); assert.equal(again.doc.marks[0].markedAt, 300); assert.deepEqual(applyMarkAction(u.doc, { action: 'unmark', markId: 'nope' }, s, 1), { ok: false, error: 'MARK_NOT_FOUND' }); });
test('records older than 400 days are pruned on write', () => { const old = { id: 'issue:2025-01-01:UA', type: 'issue', date: '2025-01-01', iso2: 'UA', sourceUrls: [], summaryKo: '…', markedAt: 0 }; const r = applyMarkAction({ marks: [old], updatedAt: 0 }, { action: 'mark', date: '2026-11-22', target: { type: 'issue', iso2: 'UA' } }, withIssue('UA', '2026-11-22'), 401 * 86_400_000); assert.deepEqual(r.doc.marks.map((x) => x.id), ['issue:2026-11-22:UA']); });


test('KST date changes at 15:00 UTC (AI collector contract)', () => {
  assert.equal(kstDate(Date.parse('2026-11-22T14:59:59Z')), '2026-11-22');
  assert.equal(kstDate(Date.parse('2026-11-22T15:00:00Z')), '2026-11-23');
  assert.equal(kstHour(Date.parse('2026-11-22T21:00:00Z')), 6);
});
test('date and pair helpers follow the AI collector contract', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(WORLD_OVERVIEW_KEYS.ai, 'world-overview:ai:v1');
  assert.equal(relationMatchKey({ kind: 'support', from: 'US', to: 'UA' }), 'support:US>UA');
  assert.equal(relationMatchKey({ kind: 'tension', from: 'US', to: 'CN' }), 'tension:CN-US');
});
