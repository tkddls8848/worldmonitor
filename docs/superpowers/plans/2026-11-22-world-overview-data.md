# World Overview Data (관계도 데이터) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce, store and serve the data behind the new first screen: fixed relations (동맹, 제재, 경제 의존), GDELT tension trends for ~30 major countries plus AI pairs, a daily Korean AI relations/issue snapshot with sources and 틀림 marks, and one combined first-screen snapshot per day.

**Architecture:** Four collectors run inside `npm run collect:personal` and write the embedded store with `seed-meta`: `seed-world-relations` (daily, 5.2), the existing `seed-gdelt-bulk-materializer` extended with a second pair tracker (5.3), `seed-world-relations-ai` (daily, KST morning, 5.4) and `seed-world-overview` (every pass) which combines everything into one snapshot. Today's snapshot is the on-demand bootstrap key `worldOverview`; past dates and 틀림 marks go through a new sebuf RPC service `WorldOverviewService` (owner decision 2026-11-22, see Task 7). Shared pure logic (line budget, mark matching, fill rule) lives in `shared/world-overview.js` so the builder, the route and the future UI run the same code.

**Out of scope:** the first-screen UI of spec 5.1 (map colouring, field buttons, ticker, breaking-news line, country detail window, 전체 보기, perf metric). It gets a separate plan after the owner picks an Antigravity mockup. Task 5 fixes the payload type and helpers that plan consumes without backend changes.

**Tech Stack:** Node 24 ESM collectors on `runSeed` (`scripts/_seed-utils.mjs`), embedded Upstash-compatible store, `papaparse` (CSV stream) and `sax` (XML stream), existing LLM chain `callLLM` from `scripts/seed-insights.mjs`, TypeScript personal edge route bundled by `scripts/build-sidecar-handlers.mjs`, `node:test` with `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-21-world-overview-design.md` (approved 2026-11-22). Read it with this plan.

## Global Constraints

- Node 24. Every shell first runs `export PATH="/c/Users/tkddl/AppData/Local/Programs/node-v24.22.3-win-x64:$PATH"` (the default `node` on this PC is 23).
- Tests run per file: `node --import tsx --test tests/<file>`. `npm run test:related` cannot spawn on Windows; do not use it.
- Known Windows-only failures exist (CRLF, `C:\C:\` paths). Before calling a failure yours, rerun the same file with your own paths stashed (`git stash push -- <your paths>`, run, `git stash pop`). Report it as baseline only if it also fails on HEAD.
- `git config core.autocrlf` is `true` here. Tests build CSV/XML fixtures as inline strings, never as checked-in `.csv`/`.xml` files, and parsers accept `\r\n`.
- Preserve unrelated work: `docs/methodology/country-resilience-index/validation/backtest-results.json` is modified and is not yours. Stage explicit paths only; never `git add -A`, never stash that file.
- Commit to local `main` after each task. Do not push; the controller pushes. Every commit message ends with this trailer paragraph:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AjhE6vfRCcusEi77VTyzp2
  ```
- `9`: the integer GitHub issue number the owner supplies (question Q1). The controller replaces every `9` in this file with that number before dispatching Task 2. `scripts/check-health-probe-cutovers.mts` rejects a new `SEED_META` probe without it.
- Credentials only through `loadEnvFile(import.meta.url)`, called only when the script is the direct run. No new env parser, no new API key, no new LLM provider (spec 3).
- Every outbound fetch sends `User-Agent: WorldMonitor-Personal-Collect/1.0 (<collector name>)`.
- Memory is tight (spec 3). Stream the 83 MB OpenSanctions CSV and the 50 MB UK CSV (`Readable.fromWeb(response.body)`); never call `.text()`, `.arrayBuffer()` or `.json()` on them.
- Degrade, never blank: a failed source keeps the last good value; a collector that has nothing new exits non-zero so `collect:personal` retries it next pass, and runSeed keeps the previous key.
- Do not edit proto inputs: `scripts/_gdelt-bulk-materializer.mjs`, `scripts/_conflict-gdelt.mjs`, `scripts/_gdelt-country-codes.mjs`, anything under `proto/` or `src/generated/` (the owner's PC has no `buf`/`make`).
- New `seed-*.mjs` call `runSeed` with the full descriptor: `validateFn`, exported `declareRecords`, `ttlSeconds`, `sourceVersion`, `schemaVersion: 1`, `maxStaleMin`.
- Comments inside `ON_DEMAND_KEY_NAMES` (`shared/bootstrap-tier-keys.js`) contain no apostrophes (`scripts/docs-stats.mjs` scans them with a bare quote matcher).
- Owner-facing words follow the spec: 분야 군사/외교/지정학/정치/금융; 관계 지원/제재/동맹/긴장/경제 의존; 추세 악화 중/완화 중/변화 없음/급등/추세 집계 중; 단계 전면전/고강도/중강도/긴장·휴전/이슈 있음; 틀림. AI text is Korean; source titles stay in the original language.
- Calendar dates are Asia/Seoul (`kstDate`), not UTC.

## Decisions (spec section 7 and gaps)

| Topic | Decision |
|---|---|
| Store keys | `world-overview:relations:v1` (5.2), `gdelt:bulk:world-pair-trends:v1` (5.3), `world-overview:ai:v1` (5.4), `world-overview:snapshot:v1` (today, bootstrap `worldOverview`), `world-overview:snapshot:v1:<YYYY-MM-DD>` (archive), `world-overview:snapshot-dates:v1` (archive index), `world-overview:wrong-marks:v1` (틀림 log). Seed-meta `seed-meta:<key without :v1>`, activation `seed-activated:<key without :v1>`. |
| TTL / health / cadence | relations TTL 345600 s, `maxStaleMin` 4320, collect interval 1440 min. pair trends TTL 864000 s, `maxStaleMin` 240 (runs with the materializer, once per pass). AI TTL 259200 s, `maxStaleMin` 2160, self-gated once per KST day from 06:00. snapshot TTL 172800 s, `maxStaleMin` 360, every pass, last collector. Observed pass length on this PC: 87 min (collect-state 2026-11-21), so a pass cycle is about 105 min. |
| Health tier | All four keys are standalone on-demand probes with activation markers (precedent `crossBorderArrivals`, `forecastArchive`). `worldOverview` is also an on-demand bootstrap key: it never rides the fast/slow tier payloads; the first screen fetches it alone. |
| Conflict level (국가 색칠) | Monthly conflict deaths for the last complete month = max(UCDP state-based deaths from `activeWarsReading`, HAPI `conflictFatalities`). 전면전 ≥ 1000, 고강도 ≥ 100, 중강도 ≥ 25, 긴장·휴전 when deaths ≥ 10 or CII `combinedScore` ≥ 50. On the owner's HAPI data for 2026-10 this colours UA YE SD NG (전면전), 14 countries 고강도, 7 중강도, IL LB CU MX 긴장·휴전: 29 countries. |
| 이슈 있음 | A country with no level shows 이슈 있음 when its AI issue for the date is present and not hidden, or, when it has no AI issue, when it is named in at least 2 of the first 50 story-pool stories. |
| 정치 outline | CII `components.ciiContribution` (the unrest component) ≥ 40, or HAPI monthly `conflictDemonstrations` ≥ 300. |
| Sanctions | Pairs `issuer>target` with ≥ 5 listed targets, top 300 kept in the relations key, top 200 drawn as lines. EU lines start at the Brussels anchor `[4.35, 50.85]`; UN pairs are listed in the country detail but never drawn. |
| 경제 의존 | Top 40 strategic-goods trade pairs (Comtrade HS4 imports, exporter → importer) and top 20 bank-claim pairs (BIS consolidated claims, lender country → borrower) stored; the 30-line budget decides what is drawn. |
| Tracking scope (5.3 option 나) | 30 major countries in `shared/world-overview-config.json` (US CN RU UA GB FR DE PL JP KR KP TW IN PK AF IR IL PS LB SY IQ SA AE QA YE TR EG SD VE AU) → 435 pairs, plus every pair the AI named in the last 14 days. |
| Trend window | Recent 24 complete hours against the 144 hours before them, as per-cohort rates (gaps do not bias). 추세 집계 중 until a pair has 168 h of tracking and both windows have ≥ 50% of their 15-minute cohorts. 급등: ratio ≥ 3 (or zero baseline) with ≥ 20 conflict events/day; 악화 중: ratio ≥ 1.3 with ≥ 5 events/day; 완화 중: ratio ≤ 0.7 with baseline ≥ 5 events/day; otherwise 변화 없음. Ratio is on intensity (mentions × max(0, −Goldstein)), the existing dyad measure. |
| 긴장 lines (GDELT) | Tracked pairs with ≥ 10 conflict events/day in the recent window, top 100 by recent intensity. |
| Line budget | 30. Split equally across enabled fields that have drawable lines; the remainder goes to fields in order 군사, 외교, 지정학, 금융; share a field cannot use is redistributed in the same order. Within a field AI lines rank first (score 1 + confidence, ties by source count), then fixed lines by value normalised per kind (score in (0, 1]). One line per kind and country pair. Hidden lines and lines without a drawable endpoint never take a slot. |
| AI run | One KST day = one snapshot, first pass at or after 06:00 KST, after `insights`. 60 top story-pool stories; one relations call (≤ 20 relations) and issue calls of 5 countries (≤ 20 countries with ≥ 2 mentions). The model cites numbered stories, never URLs; links come from the pool. Both countries of a relation must appear in a cited story. Confidence = min(model confidence, 0.5/0.75/1.0 for 1/2/3+ distinct publishers). A partial day (some calls failed) is final for that day. |
| 틀림 marks | Relation: same kind, same pair, same direction, hidden on the marked date and the 13 following dates; shown as 다시 나타남 when it carries ≥ 2 source URLs absent at marking. Issue: hidden on its date only. Undo sets `undoneAt`; records kept 400 days. Only AI relations and AI issues can be marked. |
| Retention | Archive 90 days (TTL 91 days). About 60–100 KB per day, at most 262144 bytes (validated): about 5–9 MB in the embedded store and its NDJSON file (now 180 MB). |
| Country names | The payload carries ISO2 codes only; the UI shows the Korean name next to the original (English) name from the existing localized country names. Source titles are stored in their original language. |
| Alliances | Bilateral treaty alliances drawn as lines: US–JP (1960), US–KR (1953), US–AU (ANZUS 1951), US–PH (1951), US–TH (Manila Pact 1954), CN–KP (1961), RU–KP (2024), RU–BY (Union State 1999), SA–PK (2025), TR–AZ (Shusha Declaration 2021). Blocs drawn as outlines only: NATO (32), CSTO (6), SCO (10). |

## Spec conflicts

1. **War data (5.1).** `scripts/active-wars.mjs` is a pure reader of `conflict:ucdp-events:v1`. Only `bundle-relay-backup` writes that key, the bundle has never completed in `.personal/collect-state.json`, and the key is absent from the store (checked 2026-11-22). Resolution: UCDP is used when present; HAPI `conflict:humanitarian:v1:<CC>` (44 countries, present) supplies monthly deaths otherwise. Fixing the relay bundle is not in this plan.
2. **분쟁 지역 (5.1).** The only conflict-zone list is the hand-written `CONFLICT_ZONES` in `shared/geo-data.ts`: polygons with free-text parties, some stale (Iran War Theater stays `high` though the code records the war ended 2026-07). Resolution: not used; levels come from deaths and CII.
3. **정치 outline (5.1).** CII has an unrest component (`ciiContribution`) but covers 31 countries, and in the owner's store it is 0 for all of them (unrest inputs absent). Resolution: CII unrest OR HAPI demonstrations (decision table).
4. **CII is not seeded.** `risk:scores:sebuf:stale:v14` exists only for an hour after the `get-risk-scores` RPC runs. Resolution: the builder reads it and, when absent, calls the RPC through the personal server (`wmApiFetch`), the way `seed-news-digest` warms the digest.
5. **Tracking inside the 8-pair store (5.3).** `gdelt:bulk:dyad-tension:v1` maps each actor pair to at most one configured pair, scores only after 90 complete days, and its config drives the PizzINT tension popup. Adding 435 pairs there would flood the popup and leave them unscored for 90 days. Resolution: a separate light store filled by the same materializer run from the same export files. The 7 single-country legacy pairs are seeded from the dyad store's hourly buckets so their trend starts at once; Iran–GCC becomes individual pairs.
6. **"15분 주기" (5.3).** In personal mode the materializer runs once per pass (about every 105 min) and catches up at most 8 cohorts. Trends refresh per pass, not every 15 minutes; the per-cohort rate keeps gaps from biasing them.
7. **`_llm-json.mjs` (spec 7).** `cleanJsonText` deletes `//…`, which corrupts URLs inside JSON strings. Resolution: the model cites story numbers only; parse with `JSON.parse` first and `extractFirstJsonObject` as fallback, which is then safe.
8. **One large LLM call (5.4).** The reused chain has fixed per-provider timeouts (Ollama 25 s, OpenRouter 20 s); one Korean JSON answer for 20 countries plus 20 relations would not fit. Resolution: several small calls with compact keys.
9. **"Comtrade 국가 간 교역", "BIS 자본 흐름" (5.2).** The stored Comtrade data is strategic HS4 headings with top-5 exporters per importer, not total bilateral trade; the BIS data is consolidated bank claims (a stock), not flows. Resolution: use them as they are and label the lines 전략 품목 수입 and 은행 대외 채권.
10. **OpenSanctions `dataset` column (5.2).** It holds list titles (for example `US OFAC Specially Designated Nationals (SDN) List`), not issuing countries. Resolution: ordered title-prefix rules in `shared/world-sanctions-issuers.json`; unmatched titles are counted in diagnostics.
11. **UN and UK backups (5.2).** UN nationalities use UN names (`Democratic People's Republic of Korea`, `Iran (Islamic Republic of)`) that `resolveIso2` does not resolve; the UK CSV starts with a `Report Date:` line before its header and repeats a target once per alias. Resolution: a UN alias table, a first-line skipper, de-duplication by `Unique ID`.
12. **"화면은 bootstrap 또는 RPC로 읽는다" (3).** A sebuf RPC needs `make generate` (Go, buf v1.64.0, sebuf v0.11.1 plugins); the owner's PC has none (CONTRIBUTING: proto changes wait), and CI generates only for pull requests. Resolution: today's snapshot through bootstrap; past dates and marks through `api/world-overview.ts`, a personal edge entry like `api/travel-risk-assessment.ts`, listed in `api/api-route-exceptions.json` as `internal-helper` (the category of `api/bootstrap.js`, "aggregate, unversioned"). Owner question Q2.

## Review Focus

1. A quoted OpenSanctions field (aliases with `""`, commas, newlines) split across stream chunks: counts must be identical for any chunking and for `\r\n` input. Test: Task 1.
2. OpenSanctions unreachable or truncated on a given day: sanction lines must not vanish; last good OpenSanctions pairs (≤ 7 days) for every issuer except UN and GB, fresh UN/UK pairs for those two, and never an empty sanctions section. Test: Task 2 (combination in Task 1).
3. The KST date boundary at 15:00 UTC: the AI gate, the archive key and the 14-day mark window all use the Asia/Seoul date. Tests: Tasks 2, 4, 5.
4. GDELT gaps and replays (a pass longer than 2 h, a rerun on the same cohort): no double counting, per-cohort rates, 추세 집계 중 until coverage and 7 days are met. Test: Task 3.
5. Missing or stale inputs on this store (no UCDP, no CII, AI from yesterday, no relations key): the builder still publishes a valid snapshot and says which inputs were missing. Test: Task 6.

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `scripts/_world-sanctions.mjs` | Streaming counters for OpenSanctions/UN/UK, issuer rules, source combination | 1 |
| `shared/world-sanctions-issuers.json` | Ordered dataset-title → issuer rules | 1 |
| `shared/world-overview.js`, `shared/world-overview.d.ts` | Keys, dates, pair keys (Task 2); fields and kinds (Task 4); line budget, fill rule, marks, snapshot type (Task 5) | 2, 4, 5 |
| `shared/world-alliances.json` | Treaty alliances and blocs with sources | 2 |
| `scripts/_world-economic-pairs.mjs` | Comtrade/BIS pair ranking | 2 |
| `scripts/_world-overview-io.mjs` | `markActivated(key)` | 2 |
| `scripts/seed-world-relations.mjs` | 5.2 collector | 2 |
| `shared/world-overview-config.json` | Major countries and AI pair retention (Task 3); fixed-source citations and anchors (Task 6) | 3, 6 |
| `scripts/_gdelt-world-pairs.mjs` | Pair parse, merge, legacy import, trend scoring | 3 |
| `scripts/seed-gdelt-bulk-materializer.mjs` | Wires the pair tracker into the existing run | 3 |
| `scripts/_world-relations-ai.mjs` | Story selection, prompts, validation, merge, run | 4 |
| `scripts/seed-world-relations-ai.mjs` | 5.4 collector and daily gate | 4 |
| `scripts/_world-overview-build.mjs` | Levels, lines, countries, snapshot assembly | 6 |
| `scripts/seed-world-overview.mjs` | Snapshot collector, archive, date index | 6 |
| `server/_shared/world-overview-route.ts`, `api/world-overview.ts` | Past-date read, mark/unmark | 7 |
| Registrations | `scripts/personal-collect.mjs`, `api/health.js`, `shared/bootstrap-tier-keys.js` (+ generated `api/_bootstrap-tier-keys.js`), `scripts/build-sidecar-handlers.mjs`, `api/api-route-exceptions.json`, `.gitignore`, `scripts/source-attribution.mjs` (+ generated manifest/docs), `docs/data-sources.mdx` | 2–7 |

---

### Task 1: Sanctions pair counters (5.2)

**Files:**
- Create: `scripts/_world-sanctions.mjs`
- Create: `shared/world-sanctions-issuers.json`
- Test: `tests/world-sanctions.test.mjs`

**Interfaces:**
- Consumes: `resolveIso2({ name })` from `scripts/_country-resolver.mjs`; `papaparse` (`Papa.parse(Papa.NODE_STREAM_INPUT, { header: true, skipEmptyLines: true })`); `sax`.
- Produces:
  ```ts
  type IssuerRule = { pattern: string; issuer: string };            // first match wins, RegExp(pattern)
  type SourceCount = {
    source: 'opensanctions' | 'un' | 'uk';
    rows: number;                                                   // distinct listed targets read
    issuerTotals: Record<string, number>;                           // rows per issuer (self-listings included)
    pairs: Record<string, number>;                                  // 'US>RU' -> targets; issuer === target skipped
    unmappedDatasets: Record<string, number>;                       // OpenSanctions only, title -> rows
  };
  type SanctionPair = { issuer: string; target: string; count: number };
  type SanctionsSection = {
    source: 'opensanctions' | 'last-good' | 'backup+last-good' | 'backup';
    asOf: number;
    openSanctionsAsOf: number | null;
    openSanctionsPairs: SanctionPair[];                             // last good OpenSanctions list, kept for fallback
    pairs: SanctionPair[];                                          // effective list, count >= 5, top 300
    crossCheck: Partial<Record<'UN' | 'GB', { opensanctions: number; official: number; relDiff: number; checkedAt: number }>>;
    unmappedDatasets: Record<string, number>;                       // top 30 by rows
  };
  export const SANCTION_SOURCE_URLS: { opensanctions: string; un: string; uk: string };
  export const SANCTION_PAIR_MIN_COUNT: 5;
  export const SANCTION_PAIR_LIMIT: 300;
  export function resolveSanctionIssuers(datasetField: string, rules: IssuerRule[]): string[];
  export function normalizeTargetCountries(countriesField: string): string[];
  export function skipFirstLine(input: AsyncIterable<string | Uint8Array>): AsyncGenerator<string>;
  export async function countOpenSanctionsPairs(input: NodeJS.ReadableStream, rules: IssuerRule[]): Promise<SourceCount>;
  export async function countUkSanctionsPairs(input: NodeJS.ReadableStream): Promise<SourceCount>;
  export async function countUnSanctionsPairs(input: NodeJS.ReadableStream): Promise<SourceCount>;
  export function ukCheckDue(previous: SanctionsSection | null, nowMs: number, openSanctionsOk: boolean): boolean;
  export function combineSanctionSources(args: {
    openSanctions: SourceCount | null; un: SourceCount | null; uk: SourceCount | null;
    previous: SanctionsSection | null; nowMs: number;
  }): SanctionsSection;                                             // throws { nonRetryable: true } when nothing is usable
  ```

- [ ] **Step 1: Write the failing tests** in `tests/world-sanctions.test.mjs`. Build inputs with `Readable.from(chunks)` from inline strings; helper `chunked(text, size)` splits a string into `size`-character chunks.

  ```js
  // OpenSanctions sample: real header; row A has "" escapes, a comma and a CRLF inside quotes.
  const OS_HEADER = '"id","schema","name","aliases","birth_date","countries","addresses","identifiers","sanctions","phones","emails","program_ids","dataset","first_seen","last_seen","last_change"';
  // rows: A countries "ru", dataset "US OFAC Specially Designated Nationals (SDN) List;US Trade Consolidated Screening List (CSL)"
  //       B countries "ru;by", dataset "EU Council Official Journal Sanctioned Entities;EU Sanctions Map;Switzerland SECO Sanctions/Embargoes"
  //       C countries "ua", dataset "Ukraine NSDC State Register of Sanctions"
  //       D countries "kp", dataset "Some Unknown Watchlist"
  //       E countries "suhh;ir", dataset "UK FCDO Sanctions List;UN Security Council Consolidated List"
  test('resolves issuers from list titles in rule order', () => {
    assert.deepEqual(resolveSanctionIssuers('US OFAC Specially Designated Nationals (SDN) List;US Trade Consolidated Screening List (CSL)', RULES), ['US']);
    assert.deepEqual(resolveSanctionIssuers('EU Council Official Journal Sanctioned Entities;EU Sanctions Map;Switzerland SECO Sanctions/Embargoes', RULES), ['EU', 'CH']);
    assert.deepEqual(resolveSanctionIssuers('Interpol Red Notices', RULES), []);
  });
  test('normalizes target countries to ISO2 and drops non-ISO codes', () => {
    assert.deepEqual(normalizeTargetCountries('ru;ua;suhh;'), ['RU', 'UA']);
  });
  test('counts OpenSanctions pairs identically for any chunking and line ending', async () => {
    const expected = { rows: 5, pairs: { 'US>RU': 1, 'EU>RU': 1, 'EU>BY': 1, 'CH>RU': 1, 'CH>BY': 1, 'GB>IR': 1, 'UN>IR': 1 },
      issuerTotals: { US: 1, EU: 1, CH: 1, UA: 1, GB: 1, UN: 1 }, unmappedDatasets: { 'Some Unknown Watchlist': 1 } };
    for (const text of [OS_CSV, OS_CSV.replaceAll('\n', '\r\n')]) for (const size of [1, 7, text.length]) {
      const got = await countOpenSanctionsPairs(Readable.from(chunked(text, size)), RULES);
      assert.deepEqual({ rows: got.rows, pairs: got.pairs, issuerTotals: got.issuerTotals, unmappedDatasets: got.unmappedDatasets }, expected);
    }
  });
  test('skips the UK preamble line across chunk boundaries and de-duplicates aliases by Unique ID', async () => {
    // 'Report Date: 20-Nov-2026' then header 'Unique ID,Name 6,Regime Name,Address Country,Nationality(/ies)'
    // RUS0001 twice ("The Russia (Sanctions) (EU Exit) Regulations 2019"), GHR0001 ("The Global Human Rights Sanctions Regulations 2020", nationality "Saudi Arabia"),
    // AFG0001 ("The Afghanistan (Sanctions) (EU Exit) Regulations 2020")
    for (const size of [1, 7, UK_CSV.length]) {
      const got = await countUkSanctionsPairs(Readable.from(chunked(UK_CSV, size)));
      assert.equal(got.rows, 3);
      assert.deepEqual(got.pairs, { 'GB>RU': 1, 'GB>SA': 1, 'GB>AF': 1 });
    }
  });
  test('counts UN individuals by nationality and entities by address, with UN name aliases', async () => {
    // INDIVIDUAL NATIONALITY "Democratic People's Republic of Korea"; INDIVIDUAL NATIONALITY "Iraq"; ENTITY ENTITY_ADDRESS/COUNTRY "Libya"
    const got = await countUnSanctionsPairs(Readable.from(chunked(UN_XML, 11)));
    assert.deepEqual(got.pairs, { 'UN>KP': 1, 'UN>IQ': 1, 'UN>LY': 1 });
    assert.equal(got.issuerTotals.UN, 3);
  });
  ```
  `combineSanctionSources` tests use literal `SourceCount` objects; `NOW = Date.parse('2026-11-22T00:00:00Z')`, `DAY = 86_400_000`:
  ```js
  const os = { source: 'opensanctions', rows: 9000, unmappedDatasets: {}, issuerTotals: { UN: 1100, GB: 2000 },
    pairs: { 'US>RU': 812, 'EU>RU': 640, 'GB>RU': 400, 'UN>KP': 151, 'US>CU': 4 } };
  const un = { source: 'un', rows: 1000, unmappedDatasets: {}, issuerTotals: { UN: 1000 }, pairs: { 'UN>KP': 150 } };
  const uk = { source: 'uk', rows: 2100, unmappedDatasets: {}, issuerTotals: { GB: 2100 }, pairs: { 'GB>RU': 410, 'GB>IR': 12 } };
  test('uses OpenSanctions when it arrived, drops pairs under 5 and records the UN cross-check', () => {
    const s = combineSanctionSources({ openSanctions: os, un, uk: null, previous: null, nowMs: NOW });
    assert.equal(s.source, 'opensanctions');
    assert.deepEqual(s.pairs.map((p) => `${p.issuer}>${p.target}:${p.count}`), ['US>RU:812', 'EU>RU:640', 'GB>RU:400', 'UN>KP:151']);
    assert.deepEqual(s.crossCheck.UN, { opensanctions: 1100, official: 1000, relDiff: 0.091, checkedAt: NOW });
    assert.equal(s.crossCheck.GB, undefined);
  });
  test('replaces only UN and GB with backups when OpenSanctions failed and last good is at most 7 days old', () => {
    const previous = combineSanctionSources({ openSanctions: os, un: null, uk: null, previous: null, nowMs: NOW - 3 * DAY });
    const s = combineSanctionSources({ openSanctions: null, un, uk, previous, nowMs: NOW });
    assert.equal(s.source, 'backup+last-good');
    assert.equal(s.openSanctionsAsOf, NOW - 3 * DAY);
    assert.deepEqual(s.pairs.map((p) => `${p.issuer}>${p.target}:${p.count}`), ['US>RU:812', 'EU>RU:640', 'GB>RU:410', 'UN>KP:150', 'GB>IR:12']);
  });
  test('keeps last good untouched when every source failed', () => {
    const previous = combineSanctionSources({ openSanctions: os, un: null, uk: null, previous: null, nowMs: NOW - DAY });
    assert.equal(combineSanctionSources({ openSanctions: null, un: null, uk: null, previous, nowMs: NOW }).source, 'last-good');
  });
  test('falls back to backups alone when last good is older than 7 days, and throws when nothing is usable', () => {
    const previous = combineSanctionSources({ openSanctions: os, un: null, uk: null, previous: null, nowMs: NOW - 8 * DAY });
    const s = combineSanctionSources({ openSanctions: null, un, uk, previous, nowMs: NOW });
    assert.equal(s.source, 'backup');
    assert.deepEqual(s.pairs.map((p) => p.issuer).sort(), ['GB', 'GB', 'UN']);
    assert.throws(() => combineSanctionSources({ openSanctions: null, un: null, uk: null, previous: null, nowMs: NOW }),
      (e) => /no sanctions source/.test(e.message) && e.nonRetryable === true);
  });
  test('fetches the UK list weekly for the cross-check, and always when OpenSanctions failed', () => {
    assert.equal(ukCheckDue(null, NOW, true), true);
    const checked = { crossCheck: { GB: { checkedAt: NOW - 6 * DAY } } };
    assert.equal(ukCheckDue(checked, NOW, true), false);
    assert.equal(ukCheckDue(checked, NOW, false), true);
    assert.equal(ukCheckDue({ crossCheck: { GB: { checkedAt: NOW - 7 * DAY } } }, NOW, true), true);
  });
  ```

- [ ] **Step 2: Run the tests and see them fail**

  Run: `node --import tsx --test tests/world-sanctions.test.mjs`
  Expected: FAIL, `Cannot find module '../scripts/_world-sanctions.mjs'`.

- [ ] **Step 3: Create `shared/world-sanctions-issuers.json`** as `{ "rules": IssuerRule[] }`, prefix patterns anchored with `^`, ordered: `^US ` US, `^EU ` EU, `^(UK|United Kingdom) ` GB, `^UN ` UN, `^(Switzerland|Swiss) ` CH, `^Japan` JP, `^China` CN, `^Canad` CA, `^Australia` AU, `^New Zealand` NZ, `^Ukrain` UA, `^Russia` RU, then one rule per remaining jurisdiction prefix (`^(France|French)` FR, `^German` DE, `^(Belgium|Belgian)` BE, `^(Netherlands|Dutch)` NL, `^(Poland|Polish)` PL, Lithuania LT, Latvia LV, Estonia EE, Czech CZ, Monaco MC, Singapore SG, Taiwan TW, `^(South )?Korea` KR, Israel IL, `^(Turkey|Türkiye)` TR, Kazakhstan KZ, Kyrgyz KG, Azerbaijan AZ, Moldova MD, Montenegro ME, Albania AL, Bosnia BA, Serbia RS, Iceland IS, Norway NO, Malta MT, Italy IT, Spain ES, India IN, Pakistan PK, Malaysia MY, Philippines PH, Indonesia ID, Argentina AR, Brazil BR, Mexico MX, Colombia CO, Qatar QA, `^(UAE|United Arab Emirates)` AE, Saudi SA, Kuwait KW, Bahrain BH, Jordan JO, Egypt EG, Nigeria NG, `^South Africa` ZA, Kenya KE).

- [ ] **Step 4: Implement `scripts/_world-sanctions.mjs`.** `SANCTION_SOURCE_URLS` are the three spec URLs (`https://data.opensanctions.org/datasets/latest/sanctions/targets.simple.csv`, `https://scsanctions.un.org/resources/xml/en/consolidated.xml`, `https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv`). OpenSanctions: pipe the input into the papaparse Node stream and read rows with `for await`; per row resolve issuers from `dataset` (de-duplicated, so one target counts once per issuer), targets from `countries`. UK: `Readable.from(skipFirstLine(input))` into papaparse (papaparse's `beforeFirstChunk` only sees the first chunk and fails on small chunks); target = country in `Regime Name` (`/^The (.+?) \(Sanctions\)/` resolved by `resolveIso2`), else first `Nationality(/ies)` name, else `Address Country`; de-duplicate by `Unique ID`. UN: `sax.createStream(true)`; per `INDIVIDUAL` use `NATIONALITY/VALUE`, per `ENTITY` use `ENTITY_ADDRESS/COUNTRY`, then `UN_LIST_TYPE` (`DPRK`→KP, `Iran`→IR, `Iraq`→IQ, `Libya`→LY, `Somalia`→SO, `South Sudan`→SS, `Sudan`→SD, `DRC`→CD, `CAR`→CF, `Yemen`→YE, `Mali`→ML, `Haiti`→HT, `Taliban`→AF); names go through `UN_NAME_ALIASES` (`Democratic People's Republic of Korea`→KP, `Iran (Islamic Republic of)`→IR, `Syrian Arab Republic`→SY, `Russian Federation`→RU, `Lao People's Democratic Republic`→LA) before `resolveIso2`. `combineSanctionSources` rules:
  - OpenSanctions present: `pairs` and `openSanctionsPairs` from it, `source 'opensanctions'`, `asOf = openSanctionsAsOf = nowMs`.
  - Absent, previous `openSanctionsAsOf` within 7 days: previous `openSanctionsPairs` minus issuers UN and GB, plus fresh UN/UK pairs; a backup that failed keeps that issuer's previous pairs; `source 'backup+last-good'`, or `'last-good'` when both backups failed.
  - Absent and no fresh last good: UN + UK pairs only, `source 'backup'`.
  - `crossCheck[UN|GB]` only when both sides arrived this run: `relDiff = round3(|os − official| / max(os, official, 1))`; otherwise carry the previous entry.
  - Pairs: filter `count >= 5`, sort count desc then issuer, target asc, cap 300. Empty result: throw `Object.assign(new Error('no sanctions source'), { nonRetryable: true })`.

- [ ] **Step 5: Run the tests and see them pass**

  Run: `node --import tsx --test tests/world-sanctions.test.mjs`
  Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts/_world-sanctions.mjs shared/world-sanctions-issuers.json tests/world-sanctions.test.mjs
  git commit -m "feat(data): count sanction pairs from OpenSanctions with UN and UK backups" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AjhE6vfRCcusEi77VTyzp2"
  ```

---

### Task 2: Fixed relations collector (5.2)

**Files:**
- Create: `shared/world-overview.js`, `shared/world-overview.d.ts`
- Create: `shared/world-alliances.json`
- Create: `scripts/_world-economic-pairs.mjs`, `scripts/_world-overview-io.mjs`, `scripts/seed-world-relations.mjs`
- Modify: `scripts/personal-collect.mjs` (`STANDALONE_INTERVAL_MIN`)
- Modify: `api/health.js` (`STANDALONE_KEYS`, `SEED_META`, `ON_DEMAND_KEYS`, `ACTIVATION_MARKERS`)
- Modify: `scripts/source-attribution.mjs` (`PROVIDER_OVERRIDES`), regenerated `shared/source-attribution-manifest.json` and `docs/source-attribution.mdx`
- Modify: `docs/data-sources.mdx` (new `### World Overview Relations` under `## Geopolitics & Conflict`)
- Test: `tests/world-relations.test.mjs`, `tests/world-overview-shared.test.mjs`, `tests/world-overview-health-registration.test.mjs`, `tests/personal-collect-schedule.test.mjs`

**Interfaces:**
- Consumes: Task 1 exports; `runSeed`, `readCanonicalValue`, `loadEnvFile` from `scripts/_seed-utils.mjs`; `getOptionalUpstashCreds`, `upstashCommand` from `scripts/_upstash-rest.mjs`; Comtrade keys `comtrade:bilateral-hs4:<ISO2>:v1` for the ISO2 keys of `scripts/shared/country-port-clusters.json`; BIS key `economic:bis-lbs:v1` (`data.countries[cp].parents[parent]` in USD millions).
- Produces (`shared/world-overview.js` + matching `.d.ts`):
  ```ts
  export const WORLD_OVERVIEW_TIMEZONE: 'Asia/Seoul';
  export const WORLD_OVERVIEW_KEYS: {
    relations: 'world-overview:relations:v1'; pairTrends: 'gdelt:bulk:world-pair-trends:v1'; ai: 'world-overview:ai:v1';
    snapshot: 'world-overview:snapshot:v1'; archivePrefix: 'world-overview:snapshot:v1:'; dates: 'world-overview:snapshot-dates:v1';
    marks: 'world-overview:wrong-marks:v1';
  };
  export function kstDate(nowMs: number): string;          // 'YYYY-MM-DD' in Asia/Seoul
  export function kstHour(nowMs: number): number;          // 0-23 in Asia/Seoul
  export function addDays(date: string, days: number): string;
  export function pairKey(a: string, b: string): string;   // sorted ISO2 joined by ':', e.g. 'RU:UA'
  ```
  `scripts/_world-economic-pairs.mjs`:
  ```ts
  type EconomicPair = { from: string; to: string; valueUsd: number };
  export function tradeDependencePairs(reports: Array<{ iso2: string; products: Array<{ year?: number; topExporters: Array<{ partnerCode: number; partnerIso2: string; value: number }> }> }>, topN?: number /* 40 */): { pairs: EconomicPair[]; asOfYear: number | null };
  export function bankClaimPairs(countries: Record<string, { parents: Record<string, number> }>, topN?: number /* 20 */): EconomicPair[];
  ```
  `scripts/_world-overview-io.mjs`: `export async function markActivated(key: string): Promise<void>` (best effort `SET key '1'`, no TTL, warns on failure).
  `scripts/seed-world-relations.mjs`:
  ```ts
  type Alliance = { id: string; a: string; b: string; nameKo: string; nameEn: string; since: number; source: { title: string; url: string } };
  type Bloc = { id: 'nato' | 'csto' | 'sco'; nameKo: string; nameEn: string; members: string[]; source: { title: string; url: string } };
  type SourceDiag = { ok: boolean; skipped?: boolean; rows: number; ms: number; error?: string };
  type WorldRelationsPayload = {
    generatedAt: number;
    alliances: { bilateral: Alliance[]; blocs: Bloc[] };
    sanctions: SanctionsSection;
    economic: { trade: EconomicPair[]; bankClaims: EconomicPair[]; tradeAsOfYear: number | null };
    diagnostics: { opensanctions: SourceDiag; un: SourceDiag; uk: SourceDiag };
  };
  export async function fetchWorldRelations(deps: {
    fetchImpl: typeof fetch; readValue: (key: string) => Promise<unknown | null>; nowMs: number; deadlineAtMs: number;
  }): Promise<WorldRelationsPayload>;
  export function declareRecords(data: WorldRelationsPayload): number; // bilateral + sanctions pairs + economic pairs
  ```
  Health names: `worldRelations` → `world-overview:relations:v1`.

- [ ] **Step 1: Write the failing tests.**

  `tests/world-overview-shared.test.mjs`:
  ```js
  test('kstDate switches at 15:00 UTC', () => {
    assert.equal(kstDate(Date.parse('2026-11-22T14:59:59Z')), '2026-11-22');
    assert.equal(kstDate(Date.parse('2026-11-22T15:00:00Z')), '2026-11-23');
    assert.equal(kstHour(Date.parse('2026-11-22T21:00:00Z')), 6);
  });
  test('addDays crosses months and years', () => {
    assert.equal(addDays('2026-11-22', 13), '2026-12-05');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-11-22', -89), '2026-08-25');
  });
  test('pairKey is order-independent', () => assert.equal(pairKey('UA', 'RU'), 'RU:UA'));
  ```
  `tests/world-relations.test.mjs`:
  ```js
  test('alliance list holds treaty alliances with official sources', () => {
    const { bilateral, blocs } = JSON.parse(readFileSync('shared/world-alliances.json', 'utf8'));
    assert.deepEqual(bilateral.map((x) => x.id).sort(), ['cn-kp', 'ru-by', 'ru-kp', 'sa-pk', 'tr-az', 'us-au', 'us-jp', 'us-kr', 'us-ph', 'us-th']);
    for (const x of bilateral) { assert.notEqual(x.a, x.b); assert.ok(ISO3[x.a] && ISO3[x.b]); assert.match(x.source.url, /^https:\/\//); assert.match(x.nameKo, /[가-힣]/); }
    assert.deepEqual(Object.fromEntries(blocs.map((b) => [b.id, b.members.length])), { nato: 32, csto: 6, sco: 10 });
  });
  test('ranks strategic-goods imports by exporter and reads Comtrade code 490 as Taiwan', () => {
    const { pairs, asOfYear } = tradeDependencePairs([{ iso2: 'KR', products: [
      { year: 2025, topExporters: [{ partnerCode: 682, partnerIso2: 'SA', value: 25740855840 }, { partnerCode: 842, partnerIso2: 'US', value: 12864504527 }] },
      { year: 2025, topExporters: [{ partnerCode: 490, partnerIso2: '', value: 24307492141 }, { partnerCode: 410, partnerIso2: 'KR', value: 5 }] },
      { year: 2024, topExporters: [{ partnerCode: 842, partnerIso2: 'US', value: 6281384484 }] },
    ] }], 40);
    assert.deepEqual(pairs, [{ from: 'SA', to: 'KR', valueUsd: 25740855840 }, { from: 'TW', to: 'KR', valueUsd: 24307492141 }, { from: 'US', to: 'KR', valueUsd: 19145889011 }]);
    assert.equal(asOfYear, 2025);
  });
  test('ranks bank claims in USD and skips domestic claims', () => {
    assert.deepEqual(bankClaimPairs({ AU: { parents: { JP: 155381.2, US: 143955, AU: 9 } }, AT: { parents: { IT: 86896.072 } } }, 20),
      [{ from: 'JP', to: 'AU', valueUsd: 155381200000 }, { from: 'US', to: 'AU', valueUsd: 143955000000 }, { from: 'IT', to: 'AT', valueUsd: 86896072000 }]);
  });
  test('publishes sanctions from a streamed OpenSanctions file plus alliances and economic pairs', async () => {
    // fetchImpl: OpenSanctions URL -> new Response(Readable.toWeb(Readable.from([csvWith6RowsUSonRU]))); UN URL -> 1-entity XML; UK URL -> 503
    const payload = await fetchWorldRelations({ fetchImpl, readValue, nowMs: NOW, deadlineAtMs: NOW + 300_000 });
    assert.deepEqual(payload.sanctions.pairs, [{ issuer: 'US', target: 'RU', count: 6 }]);
    assert.equal(payload.sanctions.source, 'opensanctions');
    assert.equal(payload.diagnostics.uk.ok, false);
    assert.equal(payload.alliances.bilateral.length, 10);
    assert.ok(seenHeaders.every((h) => h['user-agent'] === 'WorldMonitor-Personal-Collect/1.0 (world-relations)'));
  });
  test('keeps last good sanctions when the OpenSanctions download breaks mid-stream', async () => {
    // OpenSanctions body stream errors after the header; readValue(world-overview:relations:v1) returns a payload whose
    // sanctions.openSanctionsAsOf is NOW - 2 days with openSanctionsPairs [{ US>RU 812 }, { GB>RU 400 }]; UN and UK succeed
    const payload = await fetchWorldRelations({ fetchImpl: brokenOs, readValue, nowMs: NOW, deadlineAtMs: NOW + 300_000 });
    assert.equal(payload.sanctions.source, 'backup+last-good');
    assert.ok(payload.sanctions.pairs.some((p) => p.issuer === 'US' && p.target === 'RU' && p.count === 812));
    assert.equal(payload.diagnostics.opensanctions.ok, false);
  });
  ```
  `tests/world-overview-health-registration.test.mjs` (template: `tests/forecast-health-registration.test.mjs`); rows grow in Tasks 3, 4 and 6:
  ```js
  const ROWS = [['worldRelations', 'world-overview:relations:v1', 'seed-meta:world-overview:relations', 4320]];
  test('registers world overview probes as on-demand standalone keys with activation markers', () => {
    for (const [name, key, meta, minutes] of ROWS) {
      const activationKey = `seed-activated:${key.replace(/:v1$/, '')}`;
      assert.equal(__testing__.STANDALONE_KEYS[name], key);
      assert.deepEqual(__testing__.SEED_META[name], { key: meta, maxStaleMin: minutes, activationKey,
        cutover: { mode: 'activation-marker', fromKey: null, issue: 9, activationKey } });
      assert.equal(__testing__.ACTIVATION_MARKERS[name], activationKey);
    }
  });
  test('stays pending before the first publish and goes stale after maxStaleMin', () => {
    // classify(name, present, active, ageMinutes) exactly as in tests/forecast-health-registration.test.mjs
    for (const [name, , , minutes] of ROWS) {
      assert.equal(classify(name, false, false).status, 'EMPTY_ON_DEMAND');
      assert.equal(classify(name, false, true).status, 'EMPTY');
      assert.equal(classify(name, true, true).status, 'OK');
      assert.equal(classify(name, true, true, minutes + 1).status, 'STALE_SEED');
    }
  });
  ```
  Add to `tests/personal-collect-schedule.test.mjs`:
  ```js
  test('the fixed relations collector runs daily', () => assert.equal(STANDALONE_INTERVAL_MIN['world-relations'], 1440));
  ```

- [ ] **Step 2: Run the tests and see them fail**

  Run: `node --import tsx --test tests/world-overview-shared.test.mjs tests/world-relations.test.mjs tests/world-overview-health-registration.test.mjs tests/personal-collect-schedule.test.mjs`
  Expected: FAIL on missing modules, `undefined` health entries and interval.

- [ ] **Step 3: Write `shared/world-overview.js` and its `.d.ts`** with the exports above. `kstDate` and `kstHour` use `Intl.DateTimeFormat` with `timeZone: 'Asia/Seoul'` (`en-CA` gives `YYYY-MM-DD`); `addDays` works on `Date.UTC`.

- [ ] **Step 4: Write `shared/world-alliances.json`** with the 10 bilateral entries and 3 blocs from the decision table. Each source is the treaty text or the depositary/organisation page: `https://www.nato.int/cps/en/natohq/topics_52044.htm` (NATO members), `https://en.odkb-csto.org/`, `https://eng.sectsco.org/`, `https://www.mofa.go.jp/region/n-america/us/q&a/ref/1.html` (US–JP), `https://avalon.law.yale.edu/20th_century/kor001.asp` (US–KR), `https://avalon.law.yale.edu/20th_century/phil001.asp` (US–PH); find official pages for the other six. Check every URL once by hand with `curl -sIL -A "WorldMonitor-Personal-Collect/1.0 (world-relations)" <url>` (final status 200) and record `"verifiedAt": "2026-11-…"` on each entry. Members: NATO = AL BE BG CA HR CZ DK EE FI FR DE GR HU IS IT LV LT LU ME NL MK NO PL PT RO SK SI ES SE TR GB US; CSTO = AM BY KZ KG RU TJ; SCO = BY CN IN IR KZ KG PK RU TJ UZ.

- [ ] **Step 5: Implement `scripts/_world-economic-pairs.mjs`, `scripts/_world-overview-io.mjs` and `scripts/seed-world-relations.mjs`.** `fetchWorldRelations` downloads OpenSanctions and UN in parallel with `AbortSignal.timeout` of 240 000 ms and 60 000 ms, and UK (180 000 ms) only when `ukCheckDue(previous.sanctions, nowMs, openSanctionsOk)`; each download is isolated so one failure (HTTP error, stream error, timeout) only marks its `SourceDiag`. It reads the previous payload with `readValue(WORLD_OVERVIEW_KEYS.relations)`; if `combineSanctionSources` throws and a previous payload exists, it keeps the previous `sanctions` section; with no previous payload the error propagates (non-retryable). Comtrade reports are read one key at a time (do not hold all 197 at once). Entry point when run directly: `loadEnvFile(import.meta.url)`, then `runSeed('world-overview', 'relations', 'world-overview:relations:v1', ({ fetchDeadlineAtMs }) => fetchWorldRelations({ fetchImpl: (...a) => globalThis.fetch(...a), readValue: readCanonicalValue, nowMs: Date.now(), deadlineAtMs: fetchDeadlineAtMs }), { validateFn: (d) => Array.isArray(d?.sanctions?.pairs) && d.alliances?.bilateral?.length > 0, declareRecords, ttlSeconds: 345600, sourceVersion: 'world-relations-v1', schemaVersion: 1, maxStaleMin: 4320, lockTtlMs: 300_000, fetchPhaseTimeoutMs: 280_000, afterPublish: () => markActivated('seed-activated:world-overview:relations') })`.

- [ ] **Step 6: Register.** `scripts/personal-collect.mjs`: `'world-relations': 1440` in `STANDALONE_INTERVAL_MIN`. `api/health.js`: `STANDALONE_KEYS.worldRelations = 'world-overview:relations:v1'`; `SEED_META.worldRelations = { key: 'seed-meta:world-overview:relations', maxStaleMin: 4320, activationKey: 'seed-activated:world-overview:relations', cutover: { mode: 'activation-marker', fromKey: null, issue: 9, activationKey: 'seed-activated:world-overview:relations' } }`; `'worldRelations'` in `ON_DEMAND_KEYS` with a one-line comment; `ACTIVATION_MARKERS.worldRelations = SEED_META.worldRelations.activationKey`. `scripts/source-attribution.mjs`: `PROVIDER_OVERRIDES` for `data.opensanctions.org` (OpenSanctions, `CC BY-NC 4.0; non-commercial personal use only`), `scsanctions.un.org` (UN Security Council, public consolidated list), `sanctionslist.fcdo.gov.uk` (UK FCDO, Open Government Licence v3.0), bump `PROVIDER_IDENTITY_REVIEW` as the script instructs, then `npm run sources:generate`. `docs/data-sources.mdx`: a `### World Overview Relations` subsection naming the three sanctions sources and licence, the backup and fallback rule, the alliance list, and the two economic measures.

- [ ] **Step 7: Run the tests and checks**

  Run: `node --import tsx --test tests/world-overview-shared.test.mjs tests/world-relations.test.mjs tests/world-overview-health-registration.test.mjs tests/personal-collect-schedule.test.mjs tests/seed-contract.test.mjs tests/personal-seeders-no-upstream-hosts.test.mjs tests/health-probe-cutovers.test.mjs`
  Expected: PASS.
  Run: `node --import tsx scripts/check-health-probe-cutovers.mts origin/main && npm run sources:check && npm run generate && npm run docs:check`
  Expected: each exits 0.

- [ ] **Step 8: Commit**

  ```bash
  git add shared/world-overview.js shared/world-overview.d.ts shared/world-alliances.json scripts/_world-economic-pairs.mjs scripts/_world-overview-io.mjs scripts/seed-world-relations.mjs scripts/personal-collect.mjs api/health.js scripts/source-attribution.mjs shared/source-attribution-manifest.json docs/source-attribution.mdx docs/data-sources.mdx tests/world-overview-shared.test.mjs tests/world-relations.test.mjs tests/world-overview-health-registration.test.mjs tests/personal-collect-schedule.test.mjs
  git commit -m "feat(data): collect fixed world relations daily (alliances, sanctions, economic ties)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AjhE6vfRCcusEi77VTyzp2"
  ```
  Add any other file `sources:generate` or `docs:check` rewrote.

---

### Task 3: Tension trends for major and AI pairs (5.3)

**Files:**
- Create: `shared/world-overview-config.json`
- Create: `scripts/_gdelt-world-pairs.mjs`
- Modify: `scripts/seed-gdelt-bulk-materializer.mjs` (`fetchGdeltBulkFiles`, `fetchMaterializedGdelt`, `afterPublish`)
- Modify: `api/health.js` (`worldPairTrends`), `docs/data-sources.mdx` (tracking scope and trend rule)
- Test: `tests/gdelt-world-pairs.test.mjs`, `tests/seed-gdelt-bulk-materializer.test.mjs`, `tests/world-overview-health-registration.test.mjs`

**Interfaces:**
- Consumes: `pairKey`, `kstDate`, `addDays`, `WORLD_OVERVIEW_KEYS` (Task 2); `shared/iso3-to-iso2.json` (CAMEO actor codes are ISO3); `shared/gdelt-tension-pairs.json` and `gdelt:bulk:dyad-tension:v1` hourly buckets (`days[date].hours[HH] = { cohorts, pairs: { pairId: [conflict, intensity] } }`); AI key `world-overview:ai:v1` field `trackedPairs: Record<pairKey, 'YYYY-MM-DD'>` (written by Task 4; absent until then).
- Produces:
  ```ts
  type PairTrend = {
    state: 'collecting' | 'steady' | 'rising' | 'easing' | 'surging';
    recentEventsPerDay: number; baselineEventsPerDay: number | null;
    recentIntensityPerDay: number; baselineIntensityPerDay: number | null;
    ratio: number | null; trackedSince: number;
  };
  type WorldPairStore = {
    cursor: string;                                                         // newest merged export timestamp 'YYYYMMDDHHMMSS'
    hours: Record<string, { cohorts: number; pairs: Record<string, [number, number]> }>; // 'YYYYMMDDHH' -> pairKey -> [conflict, intensity]
    trackedSince: Record<string, number>;
    trends: Record<string, PairTrend>;                                      // every tracked pair
    updatedAt: number;
    scope: { majorPairs: number; aiPairs: number };
  };
  export const WORLD_PAIR_TREND: { recentHours: 24; baselineHours: 144; retainHours: 192; minCoverage: 0.5; risingRatio: 1.3; easingRatio: 0.7; surgeRatio: 3; minRecentEventsPerDay: 5; minBaselineEventsPerDay: 5; surgeMinEventsPerDay: 20 };
  export function parseWorldPairExport(csv: string): Record<string, [number, number]>;   // Quad 3/4 only, non-zero pairs
  export function buildTrackedPairs(majorCountries: string[], aiTrackedPairs: Record<string, string> | null | undefined, today: string, retentionDays: number): Set<string>;
  export function seedFromDyadStore(dyad: unknown, nowMs: number): WorldPairStore | null;
  export function mergeWorldPairHours(previous: WorldPairStore | null, batches: Array<{ timestamp: string; worldPairs: Record<string, [number, number]> }>, tracked: Set<string>, nowMs: number): WorldPairStore;
  export function scoreWorldPairTrends(store: WorldPairStore, nowMs: number): Record<string, PairTrend>;
  ```
  `shared/world-overview-config.json`: `{ "majorCountries": [30 ISO2 from the decision table], "aiPairRetentionDays": 14 }`. Health name `worldPairTrends` → `gdelt:bulk:world-pair-trends:v1`, `maxStaleMin` 240.

- [ ] **Step 1: Write the failing tests** in `tests/gdelt-world-pairs.test.mjs`. Reuse the `row(a, b, quad, mentions, goldstein)` helper from `tests/gdelt-dyad-tension.test.mjs`. `NOW = Date.parse('2026-11-22T12:20:00Z')`. Helper `hourlyStore({ value, trackedSinceMs = NOW - 8 * 86_400_000, recentHoursPresent = 24, baselineCohorts = 4 })` builds a `WorldPairStore` for pair `RU:US` with cursor `20261122114500` (so the last complete hour is 11:00Z): the 24 recent hours (index 0 = newest) of which only the newest `recentHoursPresent` exist, each with 4 cohorts, and the 144 baseline hours with `baselineCohorts` cohorts; `value(i)` gives the hour's `[conflict, intensity]`.

  ```js
  test('tracks every pair of the 30 major countries plus recent AI pairs', () => {
    const { majorCountries, aiPairRetentionDays } = CONFIG;
    assert.equal(new Set(majorCountries).size, 30);
    for (const c of majorCountries) assert.ok(ISO3[c], c);
    assert.equal(buildTrackedPairs(majorCountries, null, '2026-11-22', 14).size, 435);
    const tracked = buildTrackedPairs(majorCountries, { 'BR:RU': '2026-11-20', 'AR:GB': '2026-11-01' }, '2026-11-22', aiPairRetentionDays);
    assert.equal(tracked.size, 436);
    assert.ok(tracked.has('BR:RU') && !tracked.has('AR:GB'));
  });
  test('counts conflict events and mentions-weighted intensity per ISO2 pair', () => {
    const got = parseWorldPairExport([row('USA', 'RUS', 4, 3, -5), row('RUS', 'USA', 1), row('USA', 'USA', 4), row('USA', 'XYZ', 4), row('CHN', 'TWN', 3, 2, -2)].join('\n'));
    assert.deepEqual(got, { 'RU:US': [1, 15], 'CN:TW': [1, 4] });
  });
  const BATCH = { timestamp: '20261122120000', worldPairs: { 'RU:US': [1, 15], 'AR:BR': [2, 2] } };
  test('a replayed cohort is not counted twice and untracked pairs are dropped', () => {
    const first = mergeWorldPairHours(null, [BATCH], new Set(['RU:US']), NOW);
    assert.deepEqual(first.hours['2026112212'], { cohorts: 1, pairs: { 'RU:US': [1, 15] } });
    assert.equal(first.trackedSince['RU:US'], Date.parse('2026-11-22T12:00:00Z'));
    assert.deepEqual(mergeWorldPairHours(first, [BATCH], new Set(['RU:US']), NOW).hours, first.hours);
  });
  test('hours older than 192 h are pruned and a pair leaving the tracked set loses its history', () => {
    const first = mergeWorldPairHours(null, [BATCH], new Set(['RU:US']), NOW);
    const later = mergeWorldPairHours(first, [], new Set(['CN:TW']), NOW + 193 * 3_600_000);
    assert.deepEqual(later.hours, {});
    assert.equal(later.trackedSince['RU:US'], undefined);
  });
  test('imports the single-country legacy pairs from the dyad store and skips the Iran-GCC group', () => {
    const store = seedFromDyadStore({ cursor: '20261122114500', days: { '2026-11-22': { hours: { '11': { cohorts: 4, pairs: { usa_russia: [3, 40], iran_gcc: [9, 90] } } } } } }, NOW);
    assert.deepEqual(store.hours['2026112211'], { cohorts: 4, pairs: { 'RU:US': [3, 40] } });
    assert.equal(store.cursor, '20261122114500');
  });
  test('classifies rising, easing, surging and steady on per-day rates', () => {
    // 168 complete hours ending 2026-11-22T11:00Z, trackedSince 8 days earlier; baseline hours [1, 10]
    const cases = [[[1, 13], 'rising', 1.3], [[1, 7], 'easing', 0.7], [[3, 30], 'surging', 3], [[1, 10], 'steady', 1]];
    for (const [recent, state, ratio] of cases) {
      const t = scoreWorldPairTrends(hourlyStore({ value: (i) => (i < 24 ? recent : [1, 10]) }), NOW)['RU:US'];
      assert.equal(t.state, state);
      assert.equal(t.ratio, ratio);
    }
    const steady = scoreWorldPairTrends(hourlyStore({ value: () => [1, 10] }), NOW)['RU:US'];
    assert.equal(steady.recentEventsPerDay, 24);
    assert.equal(steady.baselineIntensityPerDay, 240);
  });
  test('stays collecting until 168 h of tracking and half of each window are covered', () => {
    assert.equal(scoreWorldPairTrends(hourlyStore({ trackedSinceMs: NOW - 5 * 86_400_000, value: () => [1, 10] }), NOW)['RU:US'].state, 'collecting');
    assert.equal(scoreWorldPairTrends(hourlyStore({ recentHoursPresent: 11, value: () => [1, 10] }), NOW)['RU:US'].state, 'collecting');
  });
  test('missing cohorts do not bias the rate', () => {
    // baseline hours carry 2 cohorts each (exactly 50% coverage) with half the values [0.5, 5]; recent hours full [1, 10]
    assert.equal(scoreWorldPairTrends(hourlyStore({ baselineCohorts: 2, value: (i) => (i < 24 ? [1, 10] : [0.5, 5]) }), NOW)['RU:US'].state, 'steady');
  });
  ```
  Add to `tests/seed-gdelt-bulk-materializer.test.mjs`, following its `replays an export without double-counting an independently published dyad snapshot` test:
  ```js
  it('publishes world pair trends from the same export cohorts without double counting a replay', async () => {
    // export csv with row('USA','RUS',4,3,-5); _readSnapshot returns null for world pair, AI and dyad keys
    const first = await fetchMaterializedGdelt(deps);
    assert.deepEqual(first._worldPairs.hours[hourOfCohort].pairs['RU:US'], [1, 15]);
    const replay = await fetchMaterializedGdelt({ ...deps, _readSnapshot: withPrevious(first._worldPairs) });
    assert.deepEqual(replay._worldPairs.hours, first._worldPairs.hours);
  });
  it('writes the world pair store with its own seed-meta and activation marker', async () => {
    // data._worldPairs.trends holds the 435 major pairs
    await afterPublish(data, null, { _writeExtraKey: ok, _writeExtraKeyWithMeta: record, _writeWorldPairActivationMarker: mark, /* existing marker stubs */ });
    assert.deepEqual(record.calls.find((c) => c[0] === 'gdelt:bulk:world-pair-trends:v1').slice(2, 5), [864000, 435, 'seed-meta:gdelt:bulk:world-pair-trends']);
    assert.equal(mark.calls.length, 1);
  });
  ```
  Add the row `['worldPairTrends', 'gdelt:bulk:world-pair-trends:v1', 'seed-meta:gdelt:bulk:world-pair-trends', 240]` to `tests/world-overview-health-registration.test.mjs`.

- [ ] **Step 2: Run the tests and see them fail**

  Run: `node --import tsx --test tests/gdelt-world-pairs.test.mjs tests/seed-gdelt-bulk-materializer.test.mjs tests/world-overview-health-registration.test.mjs`
  Expected: FAIL on the missing module, missing `_worldPairs` and missing health entry.

- [ ] **Step 3: Implement `scripts/_gdelt-world-pairs.mjs` and the config.** `buildTrackedPairs` keeps an AI pair while its date ≥ `addDays(today, -(retentionDays - 1))` (14 days counting today). Actor fields are `fields[7]` and `fields[17]` mapped through `shared/iso3-to-iso2.json`; same country or unmapped code skips; conflict and intensity follow `parseDyadExport` (Quad 3/4, `mentions × max(0, −goldstein)`). `mergeWorldPairHours` skips batches with `timestamp <= cursor`, rejects timestamps later than `nowMs + GDELT_PUBLICATION_LEAD_MS` (import from `scripts/_conflict-gdelt-bulk.mjs`, as the dyad module does), sets `trackedSince` for a newly tracked pair to the first merged cohort time (or `nowMs` when no cohort arrives), drops untracked pairs from every hour, prunes hours older than 192 h. `seedFromDyadStore` maps each configured pair with exactly two `countries` to `pairKey`. `scoreWorldPairTrends` (an algorithm the signature does not fix):
  ```text
  endHour   = cursor hour if cursor minute is '45', else the hour before (same rule as hourlySeries in _gdelt-dyad-tension.mjs)
  recent    = the 24 hours ending at endHour; baseline = the 144 hours before them
  cohorts(W)= sum of hours[h].cohorts over W;  rate(W, k) = sum of pairs[p][k] over W / cohorts(W) * 96   (per day)
  collecting if trackedSince > start of baseline, cohorts(recent) < 48 or cohorts(baseline) < 288
  ratio     = baselineIntensity > 0 ? round2(recentIntensity / baselineIntensity) : null
  surging   if recentEvents >= 20 and (ratio === null ? recentIntensity > 0 : ratio >= 3)
  rising    if ratio >= 1.3 and recentEvents >= 5
  easing    if ratio <= 0.7 and baselineEvents >= 5
  steady    otherwise
  ```

- [ ] **Step 4: Wire the materializer** (`scripts/seed-gdelt-bulk-materializer.mjs` only). In `fetchGdeltBulkFiles` export branch add `worldPairs: parseWorldPairExport(csv)`. In `fetchMaterializedGdelt` read the previous store strictly with `_readSnapshot('gdelt:bulk:world-pair-trends:v1')` (fall back to `seedFromDyadStore(previousDyads, nowMs)` when it is null) and the AI key through a new non-strict dep `_readOptionalSnapshot = (key) => readSeedSnapshot(key)` so an AI read failure only drops AI pairs; build the tracked set with `kstDate(nowMs)`; merge the export batches (`worldPairs ?? parseWorldPairExport(csv)`); return `_worldPairs: { ...merged, trends: scoreWorldPairTrends(merged, nowMs), updatedAt: nowMs, scope }`. In `afterPublish` add an operation `_writeExtraKeyWithMeta('gdelt:bulk:world-pair-trends:v1', data._worldPairs, 864000, Object.keys(data._worldPairs.trends).length, 'seed-meta:gdelt:bulk:world-pair-trends')` and, when it succeeds, `_writeWorldPairActivationMarker()` (default `writeActivation('seed-activated:gdelt:bulk:world-pair-trends')`). `publishTransform` already keeps `_*` fields out of the canonical key.

- [ ] **Step 5: Register and document.** `api/health.js`: `STANDALONE_KEYS.worldPairTrends`, `SEED_META.worldPairTrends` (`maxStaleMin: 240`, activation-marker cutover with `issue: 9`), `ON_DEMAND_KEYS`, `ACTIVATION_MARKERS`. `docs/data-sources.mdx`: tracking scope, the config file, the trend rule and 추세 집계 중.

- [ ] **Step 6: Run the tests and checks**

  Run: `node --import tsx --test tests/gdelt-world-pairs.test.mjs tests/seed-gdelt-bulk-materializer.test.mjs tests/gdelt-dyad-tension.test.mjs tests/world-overview-health-registration.test.mjs tests/health-probe-cutovers.test.mjs`
  Expected: PASS (existing dyad tests unchanged).
  Run: `node --import tsx scripts/check-health-probe-cutovers.mts origin/main && git diff --name-only -- scripts/_gdelt-bulk-materializer.mjs scripts/_conflict-gdelt.mjs scripts/_gdelt-country-codes.mjs`
  Expected: exit 0 and an empty file list.

- [ ] **Step 7: Commit**

  ```bash
  git add shared/world-overview-config.json scripts/_gdelt-world-pairs.mjs scripts/seed-gdelt-bulk-materializer.mjs api/health.js docs/data-sources.mdx tests/gdelt-world-pairs.test.mjs tests/seed-gdelt-bulk-materializer.test.mjs tests/world-overview-health-registration.test.mjs
  git commit -m "feat(data): track GDELT tension trends for all major-country pairs and AI pairs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AjhE6vfRCcusEi77VTyzp2"
  ```

---

### Task 4: Daily AI relations and issues (5.4)

**Files:**
- Modify: `shared/world-overview.js`, `shared/world-overview.d.ts` (fields, kinds)
- Create: `scripts/_world-relations-ai.mjs`, `scripts/seed-world-relations-ai.mjs`
- Modify: `scripts/personal-collect.mjs` (`DEFAULT_COLLECTORS`), `api/health.js` (`worldRelationsAi`), `docs/data-sources.mdx`
- Test: `tests/world-relations-ai.test.mjs`, `tests/world-overview-shared.test.mjs`, `tests/world-overview-health-registration.test.mjs`, `tests/personal-collect-schedule.test.mjs`

**Interfaces:**
- Consumes: Task 2 shared helpers; `callLLM(headline, { systemPrompt, userPrompt, maxTokens, callBudgetMs, accept })` and `__setInsightsLlmTransportForTests` from `scripts/seed-insights.mjs` (returns `{ text, model, provider } | null`; walks Ollama → paid OpenRouter → free OpenRouter models, resampling a provider once after an `accept` rejection); `extractFirstJsonObject` from `scripts/_llm-json.mjs`; `extractStoryCountries` from `scripts/shared/geo-extract.mjs`; story pool `news:insights:v1:pool` (`{ generatedAt, stories: [{ primaryTitle, primarySource, primaryLink, pubDate, countryCodes, memberTitles }] }`), `news:insights:v1` (`worldBrief`).
- Produces (shared, added to `.js` and `.d.ts`):
  ```ts
  export type WorldField = 'military' | 'diplomacy' | 'geopolitics' | 'politics' | 'finance';
  export type LineField = Exclude<WorldField, 'politics'>;
  export type AiRelationKind = 'support' | 'sanction' | 'alliance' | 'tension';
  export type RelationKind = AiRelationKind | 'economic';
  export const WORLD_FIELDS: readonly WorldField[];          // in this order
  export const AI_RELATION_KINDS: readonly AiRelationKind[];
  export const DIRECTED_KINDS: ReadonlySet<RelationKind>;     // support, sanction, economic
  export const KIND_DEFAULT_FIELD: Record<AiRelationKind, LineField>; // support military, sanction finance, alliance diplomacy, tension geopolitics
  export function relationMatchKey(r: { kind: RelationKind; from: string; to: string }): string; // 'support:US>UA' | 'tension:CN-US'
  ```
  `scripts/_world-relations-ai.mjs`:
  ```ts
  type SourceLink = { url: string; title: string; publisher: string; publishedAt?: number };
  type InputStory = { id: number; title: string; publisher: string; url: string; publishedAt?: number; countries: string[] };
  type AiRelation = { id: string /* 'ai:' + matchKey */; from: string; to: string; kind: AiRelationKind; directed: boolean; field: LineField; summaryKo: string; confidence: number; sources: SourceLink[] };
  type AiIssue = { iso2: string; summaryKo: string; fields: WorldField[]; sources: SourceLink[] };
  type AiRelationsPayload = {
    date: string; generatedAt: number; status: 'ok' | 'partial'; provider: string | null; model: string | null;
    storyCount: number; relations: AiRelation[]; issues: AiIssue[];
    trackedPairs: Record<string, string>;          // pairKey -> last date named, pruned after 14 days (read by Task 3)
    diagnostics: { calls: Array<{ part: 'relations' | 'issues'; ok: boolean; provider: string | null; kept: number; dropped: number }> };
  };
  type CallLlm = (prompt: { systemPrompt: string; userPrompt: string }, opts: { maxTokens: number; callBudgetMs: number; accept: (text: string) => boolean }) => Promise<{ text: string; model: string; provider: string } | null>;
  export const callLlmViaInsights: CallLlm;   // (p, o) => callLLM(null, { systemPrompt: p.systemPrompt, userPrompt: p.userPrompt, ...o })
  export const AI_LIMITS: { stories: 60; relations: 20; issueCountries: 20; issueBatch: 5; minMentions: 2; relationMaxChars: 80; issueMinChars: 20; issueMaxChars: 300; callBudgetMs: 55_000; minCallMs: 20_000 };
  export function shouldRunAiToday(args: { existing: AiRelationsPayload | null; nowMs: number; force: boolean }): { run: boolean; reason: 'force' | 'due' | 'already-done' | 'too-early' };
  export function selectAiInputStories(pool: unknown): InputStory[];
  export function selectIssueCountries(stories: InputStory[]): string[];
  export function buildRelationsPrompt(stories: InputStory[], date: string, worldBrief: string | null): { systemPrompt: string; userPrompt: string };
  export function buildIssuesPrompt(stories: InputStory[], countries: string[], date: string): { systemPrompt: string; userPrompt: string };
  export function parseAiJson(text: string): unknown | null;
  export function validateAiRelations(parsed: unknown, stories: InputStory[]): { relations: AiRelation[]; dropped: number };
  export function validateAiIssues(parsed: unknown, stories: InputStory[], requested: string[]): { issues: AiIssue[]; dropped: number };
  export function updateTrackedPairs(previous: Record<string, string> | null | undefined, relations: AiRelation[], date: string): Record<string, string>;
  export async function generateAiSnapshot(args: { pool: unknown; insights: unknown; date: string; nowMs: () => number; deadlineAtMs: number; callLlm: CallLlm; previous: AiRelationsPayload | null }): Promise<AiRelationsPayload>;
  export function declareRecords(data: AiRelationsPayload): number;      // relations + issues
  ```
  Health name `worldRelationsAi` → `world-overview:ai:v1`, `maxStaleMin` 2160.

- [ ] **Step 1: Write the failing tests.**

  `tests/world-overview-shared.test.mjs`:
  ```js
  test('match keys keep direction for support and sanction only', () => {
    assert.equal(relationMatchKey({ kind: 'support', from: 'US', to: 'UA' }), 'support:US>UA');
    assert.equal(relationMatchKey({ kind: 'tension', from: 'US', to: 'CN' }), 'tension:CN-US');
  });
  ```
  `tests/world-relations-ai.test.mjs` (helper `S(n, title, countries, publisher)` builds an `InputStory` with url `https://news.example/<n>`; `KO = '러시아가 우크라이나 동부에 대규모 공습을 이어갔다'`; `pool` is a story pool of 20 linked stories naming 10 countries twice each; `RELATIONS_OK` and `ISSUES_OK` are model answers that validate against those stories; `stories` and `prompt` are the 3-story fixture of the relations test and its `buildRelationsPrompt` output):
  ```js
  test('runs once per KST day from 06:00', () => {
    const at = (iso) => Date.parse(iso);
    assert.deepEqual(shouldRunAiToday({ existing: null, nowMs: at('2026-11-22T20:30:00Z'), force: false }), { run: false, reason: 'too-early' });
    assert.deepEqual(shouldRunAiToday({ existing: null, nowMs: at('2026-11-22T21:00:00Z'), force: false }), { run: true, reason: 'due' });
    assert.deepEqual(shouldRunAiToday({ existing: { date: '2026-11-23' }, nowMs: at('2026-11-22T23:00:00Z'), force: false }), { run: false, reason: 'already-done' });
    assert.deepEqual(shouldRunAiToday({ existing: { date: '2026-11-23' }, nowMs: at('2026-11-22T23:00:00Z'), force: true }), { run: true, reason: 'force' });
  });
  test('selects the first 60 linked stories and reads countries from member titles too', () => {
    const stories = selectAiInputStories({ stories: [{ primaryTitle: 'no link' }, ...seventyLinkedStories] });
    assert.equal(stories.length, 60);
    assert.deepEqual(stories.map((s) => s.id).slice(0, 3), [1, 2, 3]);
    const s = selectAiInputStories({ stories: [{ primaryTitle: 'Overnight strikes', primaryLink: 'https://x/1', countryCodes: [], memberTitles: ['Ukraine says Russian drones hit Kyiv overnight'] }] })[0];
    assert.deepEqual(s.countries.sort(), ['RU', 'UA']);
  });
  test('picks issue countries with at least 2 mentions, most mentioned first, ties by code', () => {
    assert.deepEqual(selectIssueCountries([S(1, 'a', ['UA', 'RU']), S(2, 'b', ['UA']), S(3, 'c', ['RU', 'IR']), S(4, 'd', ['IR'])]), ['IR', 'RU', 'UA']);
  });
  test('keeps only grounded, Korean, sourced relations and merges duplicates', () => {
    const stories = [S(1, 'Russia strikes Ukraine', ['RU', 'UA'], 'Reuters'), S(2, 'Kyiv hit again', ['RU', 'UA'], 'AP'), S(3, 'US aid to Ukraine', ['US', 'UA'], 'AP')];
    const { relations, dropped } = validateAiRelations({ relations: [
      { f: 'UA', t: 'RU', k: 'tension', d: 'military', s: KO, src: [1], c: 0.9 },
      { f: 'RU', t: 'UA', k: 'tension', d: 'military', s: KO, src: [2], c: 0.8 },
      { f: 'US', t: 'UA', k: 'support', d: 'politics', s: '미국이 우크라이나에 방공 무기를 추가 지원했다', src: ['S3'], c: 1 },
      { f: 'FR', t: 'RU', k: 'tension', d: 'diplomacy', s: KO, src: [1], c: 0.9 },
      { f: 'US', t: 'UA', k: 'trade', d: 'finance', s: KO, src: [3] },
      { f: 'RU', t: 'UA', k: 'tension', d: 'military', s: 'Russia keeps striking', src: [1] },
      { f: 'RU', t: 'UA', k: 'sanction', d: 'finance', s: '출처 https://x 참고', src: [1] },
      { f: 'RU', t: 'UA', k: 'sanction', d: 'finance', s: KO, src: [99] },
    ] }, stories);
    assert.equal(dropped, 5);
    assert.deepEqual(relations.map((r) => [r.id, r.field, r.sources.length, r.confidence]), [
      ['ai:tension:RU-UA', 'military', 2, 0.75],
      ['ai:support:US>UA', 'military', 1, 0.5],
    ]);
  });
  test('keeps issues only for requested countries with a grounded source; fields fall back to geopolitics', () => {
    const { issues, dropped } = validateAiIssues({ issues: [
      { cc: 'UA', s: '우크라이나 동부 전선에서 러시아의 공세가 이어지고 방공 부족이 문제로 떠올랐다', d: ['military', 'bogus'], src: [1] },
      { cc: 'RU', s: '러시아 관련 이슈 문단이다 충분히 길게 쓴다', d: [], src: [2] },
      { cc: 'IR', s: '이란 이슈 문단이지만 요청하지 않은 나라다', d: ['politics'], src: [1] },
      { cc: 'UA', s: '짧다', d: ['military'], src: [1] },
    ] }, stories, ['UA', 'RU']);
    assert.deepEqual(issues.map((i) => [i.iso2, i.fields]), [['UA', ['military']], ['RU', ['geopolitics']]]);
    assert.equal(dropped, 2);
  });
  test('parses fenced or prose-wrapped JSON and rejects garbage', () => {
    assert.deepEqual(parseAiJson('```json\n{"relations":[]}\n```'), { relations: [] });
    assert.deepEqual(parseAiJson('Here you go: {"issues":[]} thanks'), { issues: [] });
    assert.equal(parseAiJson('no json here'), null);
  });
  test('prompts cite story numbers and never ask for URLs', () => {
    const { systemPrompt, userPrompt } = buildRelationsPrompt(stories, '2026-11-23', 'Brief [2][8] text');
    assert.match(systemPrompt, /JSON/); assert.match(systemPrompt, /한국어/); assert.doesNotMatch(userPrompt, /https?:\/\//);
    assert.match(userPrompt, /^1\. \[RU,UA\] Russia strikes Ukraine — Reuters$/m);
    assert.doesNotMatch(userPrompt, /\[2\]\[8\]/);
  });
  test('stops issue calls when the deadline is near and publishes a partial day', async () => {
    let t = 0; const nowMs = () => t;
    const callLlm = async (_p, { accept }) => { t += 40_000; const text = JSON.stringify(t === 40_000 ? RELATIONS_OK : ISSUES_OK); return accept(text) ? { text, model: 'm', provider: 'openrouter' } : null; };
    const out = await generateAiSnapshot({ pool, insights: null, date: '2026-11-23', nowMs, deadlineAtMs: 75_000, callLlm, previous: null });
    assert.equal(out.status, 'partial');
    assert.equal(out.diagnostics.calls.length, 2);
  });
  test('throws a non-retryable error when every call returned nothing usable', async () => {
    await assert.rejects(generateAiSnapshot({ pool, insights: null, date: '2026-11-23', nowMs: () => 0, deadlineAtMs: 1e9, callLlm: async () => null, previous: null }),
      (e) => e.nonRetryable === true);
  });
  test('reuses the insights provider chain: a rejected paid answer falls through to the free model', async () => {
    // OPENROUTER_API_KEY='test', OLLAMA_API_URL unset; __setInsightsLlmTransportForTests({ fetch }) where calls 1-2 answer
    // '{"relations":[]}' and call 3 answers a valid relations JSON
    const out = await callLlmViaInsights(prompt, { maxTokens: 1500, callBudgetMs: 55_000, accept: (text) => validateAiRelations(parseAiJson(text), stories).relations.length > 0 });
    assert.equal(out.provider, 'openrouter-free');
    assert.equal(fetchCalls, 3);
  });
  test('tracked pairs keep 14 days of AI pairs', () => {
    assert.deepEqual(updateTrackedPairs({ 'BR:RU': '2026-11-08', 'AR:GB': '2026-11-09' }, [{ from: 'UA', to: 'RU' }], '2026-11-22'),
      { 'AR:GB': '2026-11-09', 'RU:UA': '2026-11-22' });
  });
  ```
  Add to `tests/personal-collect-schedule.test.mjs`:
  ```js
  test('the AI relations collector runs right after insights', () => {
    assert.equal(DEFAULT_COLLECTORS.indexOf('world-relations-ai'), DEFAULT_COLLECTORS.indexOf('insights') + 1);
  });
  ```
  Add the row `['worldRelationsAi', 'world-overview:ai:v1', 'seed-meta:world-overview:ai', 2160]` to the health registration test.

- [ ] **Step 2: Run the tests and see them fail**

  Run: `node --import tsx --test tests/world-overview-shared.test.mjs tests/world-relations-ai.test.mjs tests/world-overview-health-registration.test.mjs tests/personal-collect-schedule.test.mjs`
  Expected: FAIL on missing exports, module, health entry and collector.

- [ ] **Step 3: Extend `shared/world-overview.js` and `.d.ts`** with the field/kind exports above.

- [ ] **Step 4: Implement `scripts/_world-relations-ai.mjs`.** Rules the tests pin:
  - Gate order in `shouldRunAiToday`: `force` → `already-done` (existing `date` equals `kstDate(nowMs)`) → `too-early` (`kstHour(nowMs) < 6`) → `due`.
  - `updateTrackedPairs` keeps a pair while its date ≥ `addDays(date, -13)`, the same 14-day rule as Task 3.
  - Input: stories in pool order with an `http(s)` `primaryLink` and a title, ids 1..60; `countries` = `countryCodes` ∪ `extractStoryCountries` of every member title.
  - System prompt (Korean, both calls) must say: answer one JSON object only, no prose or code fences; use only the numbered stories and cite them by number in `src`; never write URLs; write `s` in 한국어 (relations ≤ 60 characters, issues ≤ 180); keep proper nouns in the original when unsure; include only relations the cited stories state or clearly imply. Relations schema `{"relations":[{"f":"US","t":"UA","k":"support","d":"military","s":"…","src":[3,7],"c":0.8}]}` with `k` ∈ support (지원) / sanction (제재) / alliance (동맹) / tension (긴장) and `d` ∈ military / diplomacy / geopolitics / finance; at most 20. Issues schema `{"issues":[{"cc":"UA","s":"…","d":["military"],"src":[3]}]}`, one per requested country, `d` ⊆ the five fields.
  - User prompt: `날짜: <date>`, optional `오늘의 요약(참고용): <worldBrief without [n] markers>`, then one line per story `n. [CC,CC] title — publisher`; the issues prompt adds `대상 국가: UA, RU, …` and lists only stories naming those countries.
  - Relation validity: `f`, `t` are distinct keys of `shared/iso2-to-iso3.json`; `k` valid; `d` invalid or `politics` → `KIND_DEFAULT_FIELD[k]`; `s` is 4–80 characters, contains Hangul, contains no `http`; `src` numbers or `'S<n>'` that exist; both countries appear in the union of cited stories' `countries`; undirected kinds sorted (`from` < `to`); `confidence = min(c in [0,1] else 0.5, [0, 0.5, 0.75, 1][min(3, distinct publishers)])`.
  - Duplicates (same `relationMatchKey`) merge: first summary and field, union of sources by URL (max 5), confidence recomputed with the max model `c`. Issues merge by `iso2` the same way. Caps: 25 relations, 20 issues.
  - `generateAiSnapshot`: relations call (`maxTokens` 1500) then issue batches of 5 (`maxTokens` 1400); each call gets `callBudgetMs = min(55_000, deadlineAtMs − nowMs() − 10_000)` and is skipped when that is under 20 000; `accept(text)` is true only when validation keeps ≥ 1 item. Any skipped or failed call → `status 'partial'`; zero items overall → throw `{ nonRetryable: true }`. `provider`/`model` from the first successful call; `trackedPairs = updateTrackedPairs(previous?.trackedPairs, relations, date)`.

- [ ] **Step 5: Implement `scripts/seed-world-relations-ai.mjs`.** Direct run: `loadEnvFile(import.meta.url)`; read `world-overview:ai:v1` with `readCanonicalValue`; `shouldRunAiToday({ existing, nowMs: Date.now(), force: process.argv.includes('--force') })`; when `run` is false log the reason and exit 0 without touching the key. Otherwise `runSeed('world-overview', 'ai', 'world-overview:ai:v1', ({ fetchDeadlineAtMs }) => generateAiSnapshot({ pool, insights, date: kstDate(Date.now()), nowMs: Date.now, deadlineAtMs: fetchDeadlineAtMs, callLlm, previous: existing }), { validateFn: (d) => /^\d{4}-\d{2}-\d{2}$/.test(d?.date) && d.relations.length + d.issues.length > 0, declareRecords, ttlSeconds: 259200, sourceVersion: 'world-relations-ai-v1', schemaVersion: 1, maxStaleMin: 2160, lockTtlMs: 330_000, fetchPhaseTimeoutMs: 300_000, afterPublish: () => markActivated('seed-activated:world-overview:ai') })` with `callLlm: callLlmViaInsights`. Pool and insights are read inside the fetch with `readCanonicalValue`; a missing pool throws `{ nonRetryable: true }` ("story pool missing").

- [ ] **Step 6: Register and document.** `scripts/personal-collect.mjs`: insert `'world-relations-ai'` directly after `'insights'` in `DEFAULT_COLLECTORS` (no interval: it gates itself). `api/health.js`: `worldRelationsAi` in `STANDALONE_KEYS`, `SEED_META` (`maxStaleMin: 2160`, activation-marker cutover `issue: 9`), `ON_DEMAND_KEYS`, `ACTIVATION_MARKERS`. `docs/data-sources.mdx`: AI input, cadence, grounding and confidence rules.

- [ ] **Step 7: Run the tests and checks**

  Run: `node --import tsx --test tests/world-overview-shared.test.mjs tests/world-relations-ai.test.mjs tests/world-overview-health-registration.test.mjs tests/personal-collect-schedule.test.mjs tests/personal-collect-news-digest.test.mjs tests/seed-contract.test.mjs tests/personal-seeders-no-upstream-hosts.test.mjs`
  Expected: PASS.
  Run: `node --import tsx scripts/check-health-probe-cutovers.mts origin/main`
  Expected: exit 0.

- [ ] **Step 8: Commit**

  ```bash
  git add shared/world-overview.js shared/world-overview.d.ts scripts/_world-relations-ai.mjs scripts/seed-world-relations-ai.mjs scripts/personal-collect.mjs api/health.js docs/data-sources.mdx tests/world-overview-shared.test.mjs tests/world-relations-ai.test.mjs tests/world-overview-health-registration.test.mjs tests/personal-collect-schedule.test.mjs
  git commit -m "feat(data): write a daily Korean AI relations and issue snapshot with sources" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AjhE6vfRCcusEi77VTyzp2"
  ```

---

### Task 5: Snapshot contract, line budget and 틀림 marks (shared)

**Files:**
- Modify: `shared/world-overview.js`, `shared/world-overview.d.ts`
- Test: `tests/world-overview-shared.test.mjs`

**Interfaces:**
- Consumes: Task 2 and Task 4 exports of the same module.
- Produces (`shared/world-overview.d.ts`, the type the UI plan consumes; `.js` implements the functions):
  ```ts
  export type ConflictLevel = 'war' | 'high' | 'medium' | 'tension';
  export type CountryFill = ConflictLevel | 'issue' | null;
  export type TrendState = 'collecting' | 'steady' | 'rising' | 'easing' | 'surging';
  export interface SourceLink { url: string; title: string; publisher: string; publishedAt?: number }
  export interface PairTrend { state: TrendState; recentEventsPerDay: number; baselineEventsPerDay: number | null; recentIntensityPerDay: number; baselineIntensityPerDay: number | null; ratio: number | null; trackedSince: number }
  export interface MarkAnnotation { state: 'hidden' | 'reappeared'; markId: string; markedAt: number }
  export interface RelationLine {
    id: string;                     // 'ai:support:US>UA', 'fixed:alliance:JP-US', 'fixed:sanction:US>RU', 'fixed:economic.trade:SA>KR', 'fixed:economic.bank:JP>AU', 'fixed:tension:CN-US'
    origin: 'fixed' | 'ai';
    kind: RelationKind;
    basis?: 'trade' | 'bank';       // economic only
    field: LineField;
    from: string;                   // ISO2, or 'EU' / 'UN' for sanctions issuers
    to: string;
    directed: boolean;
    score: number;                  // fixed: (0, 1] per kind; AI: 1 + confidence
    value: number;                  // fixed: count, USD, recent intensity/day; AI: confidence
    label: string;                  // Korean
    confidence?: number;            // AI only
    sources: SourceLink[];          // AI: >= 1 always
    trend: PairTrend | null;        // null when the pair is not tracked
    mark?: MarkAnnotation;          // AI only
  }
  export interface CountryIssue { summaryKo: string; fields: WorldField[]; sources: SourceLink[]; mark?: MarkAnnotation }
  export interface CountryState {
    level: ConflictLevel | null;
    deaths: { count: number; source: 'ucdp' | 'hapi'; month: string } | null;
    cii: { score: number; unrest: number } | null;
    demonstrations: number | null;
    unrest: boolean;                // 정치 outline
    blocs: string[];                // 'nato' | 'csto' | 'sco'
    inNews: boolean;
    issue: CountryIssue | null;
  }
  export interface Bloc { id: string; nameKo: string; nameEn: string; members: string[]; source: SourceLink }
  export interface InputStatus { status: 'ok' | 'stale' | 'missing'; asOf: number | null }
  export interface WorldOverviewSnapshot {
    schemaVersion: 1;
    date: string;                   // Asia/Seoul
    generatedAt: number;
    countries: Record<string, CountryState>;
    relations: RelationLine[];      // every candidate line; the UI draws selectVisibleLines(...)
    blocs: Bloc[];
    anchors: Record<string, [number, number]>;   // [lon, lat] for non-country endpoints, e.g. EU
    ai: { status: 'ok' | 'stale' | 'missing'; date: string | null; model: string | null };
    inputs: Record<'relations' | 'trends' | 'ai' | 'ucdp' | 'hapi' | 'cii' | 'news', InputStatus>;
    availableDates: string[];       // ascending, includes date
  }
  export interface WrongMark { id: string; type: 'relation' | 'issue'; date: string; matchKey?: string; iso2?: string; sourceUrls: string[]; summaryKo: string; markedAt: number; undoneAt?: number }
  export interface WrongMarksDoc { marks: WrongMark[]; updatedAt: number }
  export type MarkAction =
    | { action: 'mark'; date: string; target: { type: 'relation'; relationId: string } | { type: 'issue'; iso2: string } }
    | { action: 'unmark'; markId: string };
  export const LINE_BUDGET: 30;
  export const DEFAULT_FIELDS: readonly WorldField[];           // ['military', 'geopolitics']
  export const MARK_HIDE_DAYS: 14; export const MARK_REAPPEAR_MIN_NEW_SOURCES: 2; export const MARK_RETENTION_DAYS: 400;
  export const AI_DISCLAIMER_KO: 'AI가 뉴스로 만든 요약이며 틀릴 수 있다';
  export const FIELD_LABEL_KO: Record<WorldField, string>;      // 군사 외교 지정학 정치 금융
  export const KIND_LABEL_KO: Record<RelationKind, string>;     // 지원 제재 동맹 긴장 경제 의존
  export const LEVEL_LABEL_KO: Record<ConflictLevel | 'issue', string>; // 전면전 고강도 중강도 긴장·휴전 이슈 있음
  export const TREND_LABEL_KO: Record<TrendState, string>;      // 추세 집계 중 변화 없음 악화 중 완화 중 급등
  export function isDrawableEndpoint(code: string, anchors: Record<string, [number, number]>): boolean;
  export function selectVisibleLines(snapshot: WorldOverviewSnapshot, enabledFields: readonly WorldField[], budget?: number): RelationLine[];
  export function countryFill(country: CountryState): CountryFill;
  export function annotateWrongMarks(snapshot: WorldOverviewSnapshot, doc: WrongMarksDoc | null): WorldOverviewSnapshot;
  export function applyMarkAction(doc: WrongMarksDoc | null, action: MarkAction, snapshot: WorldOverviewSnapshot | null, nowMs: number):
    | { ok: true; doc: WrongMarksDoc; mark: WrongMark }
    | { ok: false; error: 'TARGET_NOT_FOUND' | 'NOT_MARKABLE' | 'MARK_NOT_FOUND' };
  ```

- [ ] **Step 1: Write the failing tests** in `tests/world-overview-shared.test.mjs`. Helpers: `line(field, n)` makes `n` fixed lines of that field (kind support/alliance/tension/sanction for military/diplomacy/geopolitics/finance) between distinct real ISO2 codes taken in order from `shared/iso2-to-iso3.json` (a fresh offset per call), scores descending; `snap(relations, extra)` wraps lines in a minimal valid snapshot (date `2026-11-22`, `anchors: { EU: [4.35, 50.85] }`); `count(lines)` returns `{ [field]: n }`; `aiTension(a, b, confidence, urls = ['https://a'])` is an AI tension line with those source URLs; `fixedTension(a, b, score)` the fixed one; `sanction(issuer, target)` a fixed finance sanction line; `l1`, `l2` two geopolitics lines; `withIssue(iso2, date)` a snapshot whose country `iso2` has an AI issue.

  ```js
  test('the default fields give all 30 slots to 지정학 when 군사 has no lines', () => {
    assert.equal(selectVisibleLines(snap(line('geopolitics', 50)), DEFAULT_FIELDS).length, 30);
  });
  test('a field with few lines gives its unused share to the other enabled field', () => {
    const got = selectVisibleLines(snap([...line('military', 5), ...line('geopolitics', 50)]), DEFAULT_FIELDS);
    assert.deepEqual(count(got), { military: 5, geopolitics: 25 });
  });
  test('four line fields split 30 as 8, 8, 7, 7 in field order; 정치 adds nothing', () => {
    const all = [...line('military', 40), ...line('diplomacy', 40), ...line('geopolitics', 40), ...line('finance', 40)];
    assert.deepEqual(count(selectVisibleLines(snap(all), WORLD_FIELDS)), { military: 8, diplomacy: 8, geopolitics: 7, finance: 7 });
  });
  test('hidden lines take no slot, reappeared lines do, UN is never drawn and EU uses its anchor', () => {
    const rel = [{ ...l1, mark: { state: 'hidden' } }, { ...l2, mark: { state: 'reappeared' } },
      { ...sanction('UN', 'KP') }, { ...sanction('EU', 'RU') }];
    const ids = selectVisibleLines(snap(rel), ['geopolitics', 'finance']).map((x) => x.id);
    assert.ok(!ids.includes(l1.id) && ids.includes(l2.id) && ids.includes('fixed:sanction:EU>RU') && !ids.includes('fixed:sanction:UN>KP'));
    assert.equal(isDrawableEndpoint('UN', { EU: [4.35, 50.85] }), false);
  });
  test('an AI line wins over the fixed line of the same kind and pair', () => {
    const got = selectVisibleLines(snap([aiTension('US', 'CN', 0.8), fixedTension('CN', 'US', 1)]), ['geopolitics']);
    assert.deepEqual(got.map((x) => x.id), ['ai:tension:CN-US']);
  });
  test('country fill: level first, then 이슈 있음 from a visible AI issue or from the news', () => {
    assert.equal(countryFill({ level: 'war', issue: null, inNews: false }), 'war');
    assert.equal(countryFill({ level: null, issue: { mark: undefined }, inNews: false }), 'issue');
    assert.equal(countryFill({ level: null, issue: { mark: { state: 'hidden' } }, inNews: true }), null);
    assert.equal(countryFill({ level: null, issue: null, inNews: true }), 'issue');
    assert.equal(countryFill({ level: null, issue: null, inNews: false }), null);
  });
  test('a relation mark hides the same pair and kind for 14 days and lets it reappear with 2 new sources', () => {
    const mark = { id: 'rel:2026-11-22:tension:CN-US', type: 'relation', date: '2026-11-22', matchKey: 'tension:CN-US', sourceUrls: ['https://a'], summaryKo: '…', markedAt: 1 };
    const doc = { marks: [mark], updatedAt: 1 };
    const state = (date, urls) => annotateWrongMarks(snap([aiTension('US', 'CN', 0.8, urls)], { date }), doc).relations[0].mark?.state;
    assert.equal(state('2026-11-21', ['https://a']), undefined);
    assert.equal(state('2026-11-22', ['https://a']), 'hidden');
    assert.equal(state('2026-12-05', ['https://a', 'https://b']), 'hidden');
    assert.equal(state('2026-11-25', ['https://a', 'https://b', 'https://c']), 'reappeared');
    assert.equal(state('2026-12-06', ['https://a']), undefined);
    assert.equal(annotateWrongMarks(snap([aiTension('US', 'CN', 0.8, ['https://a'])], { date: '2026-11-22' }), { marks: [{ ...mark, undoneAt: 2 }] }).relations[0].mark, undefined);
  });
  test('an issue mark hides that date only; fixed lines are never annotated; annotation is idempotent', () => {
    const doc = { marks: [{ id: 'issue:2026-11-22:UA', type: 'issue', date: '2026-11-22', iso2: 'UA', sourceUrls: [], summaryKo: '…', markedAt: 1 }] };
    assert.equal(annotateWrongMarks(withIssue('UA', '2026-11-22'), doc).countries.UA.issue.mark.state, 'hidden');
    assert.equal(annotateWrongMarks(withIssue('UA', '2026-11-23'), doc).countries.UA.issue.mark, undefined);
    const once = annotateWrongMarks(withIssue('UA', '2026-11-22'), doc);
    assert.deepEqual(annotateWrongMarks(once, doc), once);
    assert.deepEqual(annotateWrongMarks(once, { marks: [] }).countries.UA.issue.mark, undefined);
  });
  test('mark, unmark and re-mark keep one record per date and target', () => {
    const s = snap([aiTension('US', 'CN', 0.8, ['https://a']), fixedTension('CN', 'US', 1)], { date: '2026-11-22' });
    const m = applyMarkAction(null, { action: 'mark', date: '2026-11-22', target: { type: 'relation', relationId: 'ai:tension:CN-US' } }, s, 100);
    assert.equal(m.mark.id, 'rel:2026-11-22:tension:CN-US');
    assert.deepEqual(m.mark.sourceUrls, ['https://a']);
    assert.deepEqual(applyMarkAction(m.doc, { action: 'mark', date: '2026-11-22', target: { type: 'relation', relationId: 'fixed:tension:CN-US' } }, s, 101), { ok: false, error: 'NOT_MARKABLE' });
    assert.deepEqual(applyMarkAction(m.doc, { action: 'mark', date: '2026-11-22', target: { type: 'relation', relationId: 'ai:x' } }, s, 101), { ok: false, error: 'TARGET_NOT_FOUND' });
    const u = applyMarkAction(m.doc, { action: 'unmark', markId: m.mark.id }, s, 200);
    assert.equal(u.doc.marks.length, 1); assert.equal(u.doc.marks[0].undoneAt, 200);
    const again = applyMarkAction(u.doc, { action: 'mark', date: '2026-11-22', target: { type: 'relation', relationId: 'ai:tension:CN-US' } }, s, 300);
    assert.equal(again.doc.marks.length, 1); assert.equal(again.doc.marks[0].undoneAt, undefined); assert.equal(again.doc.marks[0].markedAt, 300);
    assert.deepEqual(applyMarkAction(u.doc, { action: 'unmark', markId: 'nope' }, s, 1), { ok: false, error: 'MARK_NOT_FOUND' });
  });
  test('records older than 400 days are pruned on write', () => {
    const old = { id: 'issue:2025-01-01:UA', type: 'issue', date: '2025-01-01', iso2: 'UA', sourceUrls: [], summaryKo: '…', markedAt: 0 };
    const r = applyMarkAction({ marks: [old], updatedAt: 0 }, { action: 'mark', date: '2026-11-22', target: { type: 'issue', iso2: 'UA' } }, withIssue('UA', '2026-11-22'), 401 * 86_400_000);
    assert.deepEqual(r.doc.marks.map((x) => x.id), ['issue:2026-11-22:UA']);
  });
  ```

- [ ] **Step 2: Run the tests and see them fail**

  Run: `node --import tsx --test tests/world-overview-shared.test.mjs`
  Expected: FAIL, the new exports are missing.

- [ ] **Step 3: Implement the exports in `shared/world-overview.js`** and declare them in the `.d.ts`. `isDrawableEndpoint`: true when `anchors` has the code, false for `UN` and `EU` without an anchor, else true for `/^[A-Z]{2}$/`. `selectVisibleLines` (the budget algorithm):
  ```text
  eligible = relations with field in enabledFields, mark?.state !== 'hidden', both endpoints drawable
  per field: sort by score desc, sources.length desc, value desc, id asc (spec 5.2: AI by confidence, then source count);
             drop a line whose (kind, unordered pair) is already taken in that field
  F = line fields (WORLD_FIELDS order) with >= 1 eligible line; if none return []
  share = floor(budget / |F|); the first (budget mod |F|) fields of F get share + 1
  take min(share_f, available_f) from each; then hand leftover slots one at a time round-robin over F, in order, to fields with lines left
  return the taken lines grouped by field in WORLD_FIELDS order, rank order inside a field
  ```
  `annotateWrongMarks` strips every existing `mark` first, then applies active marks (`!undoneAt`) to AI relations whose `relationMatchKey` equals `matchKey` when `mark.date <= snapshot.date <= addDays(mark.date, 13)`, `reappeared` when the line has ≥ 2 URLs not in `sourceUrls`; issue marks apply when `mark.date === snapshot.date`. It never mutates its input. `applyMarkAction` builds ids `rel:<date>:<matchKey>` and `issue:<date>:<iso2>`, refuses `origin: 'fixed'` lines, stores `sourceUrls` and `summaryKo` from the target, prunes records with `markedAt` older than 400 days, sets `updatedAt = nowMs`.

- [ ] **Step 4: Run the tests and the type check**

  Run: `node --import tsx --test tests/world-overview-shared.test.mjs`
  Expected: PASS.
  Run: `npm run typecheck && npm run typecheck:api`
  Expected: exit 0.

- [ ] **Step 5: Commit**

  ```bash
  git add shared/world-overview.js shared/world-overview.d.ts tests/world-overview-shared.test.mjs
  git commit -m "feat(data): define the world overview snapshot contract, 30-line budget and wrong-mark rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AjhE6vfRCcusEi77VTyzp2"
  ```

---

### Task 6: First-screen snapshot builder

**Files:**
- Modify: `shared/world-overview-config.json` (add `citations`, `anchors`)
- Create: `scripts/_world-overview-build.mjs`, `scripts/seed-world-overview.mjs`
- Modify: `shared/bootstrap-tier-keys.js` (+ regenerated `api/_bootstrap-tier-keys.js`), `api/health.js` (`worldOverview`), `scripts/personal-collect.mjs`, `tests/bootstrap.test.mjs` (`PENDING_CONSUMERS`), `docs/data-sources.mdx`
- Test: `tests/world-overview-build.test.mjs`, `tests/world-overview-health-registration.test.mjs`, `tests/personal-collect-schedule.test.mjs`

**Interfaces:**
- Consumes: Task 2 `WorldRelationsPayload`, Task 3 `WorldPairStore`, Task 4 `AiRelationsPayload`, Task 5 types and `annotateWrongMarks`; `activeWarsReading`, `palestineLocator` from `scripts/active-wars.mjs`; `CII_RISK_SCORE_CACHE_KEYS` from `scripts/_cii-risk-cache-keys.mjs`; `wmApiBase`, `wmApiFetch` from `scripts/lib/personal-api.mjs` (GET `/api/intelligence/v1/get-risk-scores` → `{ ciiScores: [{ region, combinedScore, components: { ciiContribution } , computedAt }] }`); `redisPipeline` from `api/_upstash-json.js` and `unwrapEnvelope` from `scripts/_seed-envelope-source.mjs` for the HAPI batch; HAPI `conflict:humanitarian:v1:<CC>` (`previousCompleteSummary ?? summary`: `conflictFatalities`, `conflictDemonstrations`, `referencePeriod`); story pool.
- Produces:
  ```ts
  export const LEVEL_THRESHOLDS: { war: 1000; high: 100; medium: 25; tensionDeaths: 10; tensionCii: 50 };
  export const UNREST_THRESHOLDS: { ciiUnrest: 40; demonstrations: 300 };
  export const NEWS_ISSUE: { topStories: 50; minMentions: 2 };
  export const LINE_CAPS: { sanction: 200; tension: 100; tensionMinEventsPerDay: 10 };
  export const ARCHIVE_DAYS: 90; export const ARCHIVE_TTL_SECONDS: 7862400; export const SNAPSHOT_MAX_BYTES: 262144;
  export function conflictLevel(deaths: number | null, ciiScore: number | null): ConflictLevel | null;
  export function monthlyDeaths(args: { ucdp: { referenceMonth: string; conflicts: Array<{ code: string | null; deaths: number }> } | null; hapi: Record<string, { conflictFatalities?: number; referencePeriod?: string }> }): Record<string, { count: number; source: 'ucdp' | 'hapi'; month: string }>;
  export function formatUsdKo(valueUsd: number): string;               // '$25.7B', '$1.2T', '$450M'
  export function buildRelationLines(args: { relations: WorldRelationsPayload | null; trends: WorldPairStore | null; ai: AiRelationsPayload | null; citations: Record<string, SourceLink> }): RelationLine[];
  export function buildWorldOverviewSnapshot(inputs: BuildInputs, opts: { date: string; nowMs: number; marks: WrongMarksDoc | null; previousDates: string[] | null; config: { anchors: Record<string, [number, number]>; citations: Record<string, SourceLink> } }): WorldOverviewSnapshot;  // availableDates = nextAvailableDates(previousDates, date)
  export function nextAvailableDates(previous: string[] | null, date: string): string[];  // unique, ascending, >= addDays(date, -89)
  export function isValidSnapshot(data: unknown): boolean;
  // BuildInputs = { relations, trends, ai, ucdpEvents: unknown[] | null, hapi: Record<string, HapiSummary>, cii: { scores: CiiScore[]; asOf: number } | null, pool: unknown }
  ```
  `seed-world-overview.mjs` exports `declareRecords` (countries + relations) and `readBuildInputs(deps: { readValue, readHapi, fetchCii, nowMs })`. Bootstrap name `worldOverview` → `world-overview:snapshot:v1`, on-demand tier. Health name `worldOverview`, `maxStaleMin` 360.

- [ ] **Step 1: Write the failing tests** in `tests/world-overview-build.test.mjs`. Fixtures: `RELATIONS` (alliance `us-jp` a US b JP nameKo `미·일 안전보장조약`; sanctions pairs US>RU 812 and UN>KP 151, source `opensanctions`; trade SA>KR 25740855840; bank claims JP>AU 155381200000); `TRENDS.trends` with `JP:US` steady, `CN:US` `recentEventsPerDay` 34.2 and `recentIntensityPerDay` 500, `RU:UA` `recentEventsPerDay` 9; `AI` dated `2026-11-23` with one relation `support` US>UA confidence 0.5 and source `https://s/1`; `MARK_ON_US_UA_SUPPORT` = relation mark dated `2026-11-23`, `matchKey 'support:US>UA'`, `sourceUrls ['https://s/1']`; `EMPTY` = every input null and `hapi: {}`; `OPTS = { date: '2026-11-23', nowMs: NOW, marks: null, previousDates: null, config: CONFIG }`; `pick(obj, keys)` and `story(countryCodes)` are trivial helpers:
  ```js
  test('levels follow monthly deaths, then CII for 긴장·휴전', () => {
    const cases = [[1000, null, 'war'], [999, null, 'high'], [100, null, 'high'], [99, null, 'medium'], [25, null, 'medium'],
      [24, null, 'tension'], [10, null, 'tension'], [9, null, null], [9, 50, 'tension'], [null, 49.9, null], [0, 60, 'tension']];
    for (const [d, c, want] of cases) assert.equal(conflictLevel(d, c), want, `${d}/${c}`);
  });
  test('monthly deaths take the larger of UCDP and HAPI and say which', () => {
    const got = monthlyDeaths({ ucdp: { referenceMonth: '2026-10', conflicts: [{ code: 'UA', deaths: 3000 }, { code: 'SD', deaths: 1500 }] },
      hapi: { UA: { conflictFatalities: 4771, referencePeriod: '2026-10-01' }, SD: { conflictFatalities: 1206, referencePeriod: '2026-10-01' } } });
    assert.deepEqual(got.UA, { count: 4771, source: 'hapi', month: '2026-10' });
    assert.deepEqual(got.SD, { count: 1500, source: 'ucdp', month: '2026-10' });
  });
  test('builds labelled lines with trends from fixed relations, GDELT pairs and AI', () => {
    const lines = buildRelationLines({ relations: RELATIONS, trends: TRENDS, ai: AI, citations: CITATIONS });
    const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
    assert.deepEqual(pick(byId['fixed:alliance:JP-US'], ['field', 'label', 'directed']), { field: 'diplomacy', label: '미·일 안전보장조약', directed: false });
    assert.equal(byId['fixed:alliance:JP-US'].trend.state, 'steady');
    assert.deepEqual(pick(byId['fixed:sanction:US>RU'], ['field', 'label', 'score']), { field: 'finance', label: '제재 대상 812건', score: 1 });
    assert.ok(byId['fixed:sanction:UN>KP']);
    assert.equal(byId['fixed:economic.trade:SA>KR'].label, '전략 품목 수입 $25.7B');
    assert.equal(byId['fixed:economic.bank:JP>AU'].label, '은행 대외 채권 $155.4B');
    assert.equal(byId['fixed:tension:CN-US'].label, '충돌 사건 하루 34건');
    assert.equal(byId['fixed:tension:RU-UA'], undefined);           // trends['RU:UA'].recentEventsPerDay is 9
    assert.equal(byId['ai:support:US>UA'].score, 1.5);              // confidence 0.5
  });
  test('publishes a valid snapshot from HAPI alone and reports every missing input', () => {
    const s = buildWorldOverviewSnapshot({ relations: null, trends: null, ai: null, ucdpEvents: null, cii: null, pool: null,
      hapi: { UA: { conflictFatalities: 4771, conflictDemonstrations: 15, referencePeriod: '2026-10-01' } } },
      { date: '2026-11-23', nowMs: NOW, marks: null, previousDates: [], config: CONFIG });
    assert.equal(isValidSnapshot(s), true);
    assert.equal(s.countries.UA.level, 'war');
    assert.deepEqual(s.relations, []);
    assert.deepEqual(Object.fromEntries(Object.entries(s.inputs).map(([k, v]) => [k, v.status])),
      { relations: 'missing', trends: 'missing', ai: 'missing', ucdp: 'missing', hapi: 'ok', cii: 'missing', news: 'missing' });
    assert.deepEqual(s.availableDates, ['2026-11-23']);
  });
  test('uses yesterday AI as stale, ignores older AI', () => {
    const at = (date) => buildWorldOverviewSnapshot({ ...EMPTY, ai: { ...AI, date } }, OPTS).ai.status;
    assert.equal(at('2026-11-23'), 'ok'); assert.equal(at('2026-11-22'), 'stale'); assert.equal(at('2026-11-21'), 'missing');
  });
  test('정치 outline from CII unrest or HAPI demonstrations; 이슈 있음 from the news pool', () => {
    const s = buildWorldOverviewSnapshot({ ...EMPTY, cii: { asOf: NOW, scores: [{ region: 'FR', combinedScore: 4, components: { ciiContribution: 40 } }] },
      hapi: { IN: { conflictFatalities: 53, conflictDemonstrations: 300 }, US: { conflictFatalities: 5, conflictDemonstrations: 299 } },
      pool: { stories: [story(['DK']), story(['DK', 'RU']), story(['RU'])] } }, OPTS);
    assert.equal(s.countries.FR.unrest, true); assert.equal(s.countries.IN.unrest, true); assert.equal(s.countries.US?.unrest ?? false, false);
    assert.equal(s.countries.DK.inNews, true);
  });
  test('applies current marks while building', () => {
    const s = buildWorldOverviewSnapshot({ ...EMPTY, ai: AI }, { ...OPTS, marks: { marks: [MARK_ON_US_UA_SUPPORT], updatedAt: 1 } });
    assert.equal(s.relations.find((l) => l.id === 'ai:support:US>UA').mark.state, 'hidden');
  });
  test('keeps 90 days of archive dates and rejects oversized snapshots', () => {
    assert.deepEqual(nextAvailableDates(['2026-08-24', '2026-08-25', '2026-11-22'], '2026-11-22'), ['2026-08-25', '2026-11-22']);
    assert.equal(isValidSnapshot({ ...validSnapshot, relations: hugeLines(300_000) }), false);
  });
  test('falls back to the personal API for CII when the cached scores are gone', async () => {
    let calls = 0;
    const inputs = await readBuildInputs({ readValue: async () => null, readHapi: async () => ({}), nowMs: NOW,
      fetchCii: async () => { calls += 1; return { ciiScores: [{ region: 'IR', combinedScore: 50, components: { ciiContribution: 0 }, computedAt: NOW }] }; } });
    assert.equal(calls, 1); assert.equal(inputs.cii.scores[0].region, 'IR');
  });
  test('the today key equals the bootstrap on-demand key', () => {
    assert.equal(BOOTSTRAP_CACHE_KEYS.worldOverview, 'world-overview:snapshot:v1');
    assert.equal(BOOTSTRAP_TIERS.worldOverview, 'on-demand');
    assert.match(readFileSync('scripts/seed-world-overview.mjs', 'utf8'), /runSeed\('world-overview', 'snapshot', 'world-overview:snapshot:v1'/);
  });
  ```
  Add to `tests/personal-collect-schedule.test.mjs`:
  ```js
  test('the snapshot builder runs last, after every input collector', () => assert.equal(DEFAULT_COLLECTORS.at(-1), 'world-overview'));
  ```
  Add the row `['worldOverview', 'world-overview:snapshot:v1', 'seed-meta:world-overview:snapshot', 360]` to the health registration test.

- [ ] **Step 2: Run the tests and see them fail**

  Run: `node --import tsx --test tests/world-overview-build.test.mjs tests/world-overview-health-registration.test.mjs tests/personal-collect-schedule.test.mjs`
  Expected: FAIL on the missing module, bootstrap key, health entry and collector.

- [ ] **Step 3: Extend `shared/world-overview-config.json`** with `"anchors": { "EU": [4.35, 50.85] }` and `"citations"`: `opensanctions` (`https://www.opensanctions.org/datasets/sanctions/`, OpenSanctions, title `OpenSanctions consolidated sanctions targets (CC BY-NC 4.0)`), `un` (`https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list`), `uk` (`https://www.gov.uk/government/publications/the-uk-sanctions-list`), `comtrade` (`https://comtradeplus.un.org/`), `bis` (`https://www.bis.org/statistics/consstats.htm`), `gdelt` (`https://www.gdeltproject.org/`). Citations live here, not in `scripts/`, because they are links, not fetch targets.

- [ ] **Step 4: Implement `scripts/_world-overview-build.mjs`.** Line rules: alliance lines (field diplomacy, undirected, label `nameKo`, source from the alliance, score 1, value `since`); sanction lines from `relations.sanctions.pairs` top 200 (finance, directed, label `제재 대상 <count>건`, source = OpenSanctions citation, or UN/UK citation when `source` is `backup`); economic lines (finance, directed, `basis` trade or bank, labels `전략 품목 수입 <formatUsdKo>` and `은행 대외 채권 <formatUsdKo>`); tension lines from `trends.trends` where `recentEventsPerDay >= 10`, top 100 by `recentIntensityPerDay` (geopolitics, undirected, label `충돌 사건 하루 <round(recentEventsPerDay)>건`, GDELT citation); AI lines from `ai.relations` (`score = 1 + confidence`, `value = confidence`, label `summaryKo`). Fixed scores are `value / max(value)` within the same kind and basis. Every line gets `trend = trends?.trends[pairKey(from, to)] ?? null` (null for `EU`/`UN`). Countries: union of codes with a level, CII entry, HAPI entry, bloc membership, AI issue or news mention; `deaths` from `monthlyDeaths` (UCDP reading from `activeWarsReading(ucdpEvents, nowMs, { inPalestine })` inside a try: a throw means no UCDP), `level = conflictLevel(deaths?.count ?? null, cii?.score ?? null)`, `unrest` per `UNREST_THRESHOLDS`, `inNews` from the first 50 pool stories' `countryCodes` (≥ 2 mentions), `issue` from AI issues when AI status is ok or stale. Input statuses: `ok` with `asOf`, `stale` for yesterday's AI, `missing` when absent. Finish with `annotateWrongMarks(snapshot, marks)`.

- [ ] **Step 5: Implement `scripts/seed-world-overview.mjs`.** `readBuildInputs` reads relations, trends, AI, marks, UCDP (`.events`), pool and the archive date index with `readValue`; HAPI with one `redisPipeline` of `GET conflict:humanitarian:v1:<CC>` for every key of `shared/iso2-to-iso3.json`, each value through `unwrapEnvelope`; CII from `CII_RISK_SCORE_CACHE_KEYS.stale`, else `fetchCii()` = `wmApiFetch()(`${wmApiBase()}/api/intelligence/v1/get-risk-scores`, { headers: { 'User-Agent': 'WorldMonitor-Personal-Collect/1.0 (world-overview)' }, signal: AbortSignal.timeout(20_000) })`; a failed CII call yields `cii: null`. Direct run: `loadEnvFile(import.meta.url)`, `const date = kstDate(Date.now())`, then `runSeed('world-overview', 'snapshot', 'world-overview:snapshot:v1', fetchFn, { validateFn: isValidSnapshot, declareRecords, ttlSeconds: 172800, sourceVersion: 'world-overview-v1', schemaVersion: 1, maxStaleMin: 360, afterPublish })`; `afterPublish(data)` writes `world-overview:snapshot:v1:<date>` and `world-overview:snapshot-dates:v1` (= `data.availableDates`) with `writeExtraKey(..., ARCHIVE_TTL_SECONDS)`, then `markActivated('seed-activated:world-overview:snapshot')`.

- [ ] **Step 6: Register and document.** `shared/bootstrap-tier-keys.js`: append `worldOverview: 'world-overview:snapshot:v1'` to `BOOTSTRAP_CACHE_KEYS` and `'worldOverview'` to `ON_DEMAND_KEY_NAMES` with an apostrophe-free comment ("World overview first screen snapshot, fetched by that screen alone"); `npm run sync:bootstrap-tier-keys`. `tests/bootstrap.test.mjs`: add `'worldOverview'` to `PENDING_CONSUMERS` with the comment "first screen UI plan wires the consumer". `api/health.js`: `STANDALONE_KEYS.worldOverview = BOOTSTRAP_CACHE_KEYS.worldOverview`, `SEED_META.worldOverview` (`maxStaleMin: 360`, activation-marker cutover `issue: 9`), `ON_DEMAND_KEYS`, `ACTIVATION_MARKERS`. `scripts/personal-collect.mjs`: append `'world-overview'` as the last entry of `DEFAULT_COLLECTORS`. `docs/data-sources.mdx`: the level and outline thresholds with the 2026-10 distribution, the 이슈 있음 rule, line caps, the 30-line rule, archive retention (90 days, about 60–100 KB per day, at most 256 KB, about 5–9 MB total).

- [ ] **Step 7: Run the tests and checks**

  Run: `node --import tsx --test tests/world-overview-build.test.mjs tests/world-overview-shared.test.mjs tests/world-overview-health-registration.test.mjs tests/personal-collect-schedule.test.mjs tests/bootstrap.test.mjs tests/bootstrap-on-demand-cache-budget.test.mts tests/bootstrap-ondemand-public-key-guard.test.mts tests/active-wars.test.mjs tests/seed-contract.test.mjs tests/personal-seeders-no-upstream-hosts.test.mjs`
  Expected: PASS.
  Run: `node --import tsx scripts/check-health-probe-cutovers.mts origin/main && npm run sync:bootstrap-tier-keys:check && npm run generate && npm run docs:check && npm run typecheck`
  Expected: each exits 0; commit anything `npm run generate` rewrote.

- [ ] **Step 8: Commit**

  ```bash
  git add shared/world-overview-config.json scripts/_world-overview-build.mjs scripts/seed-world-overview.mjs shared/bootstrap-tier-keys.js api/_bootstrap-tier-keys.js api/health.js scripts/personal-collect.mjs tests/bootstrap.test.mjs docs/data-sources.mdx tests/world-overview-build.test.mjs tests/world-overview-health-registration.test.mjs tests/personal-collect-schedule.test.mjs
  git commit -m "feat(data): build one first-screen world overview snapshot per day with a 90-day archive" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AjhE6vfRCcusEi77VTyzp2"
  ```

---

### Task 7: Past-date and 틀림 route

> **Owner decision (2026-11-22) overrides the route design below.** Build this as a proper sebuf RPC, not a personal edge route. The owner installed the generator toolchain; generation runs only in the controller's WSL LF clone (`wsl-gen-lf.sh`), never on Windows.
> - **7a (worker):** add the proto definitions per `.agents/skills/add-rpc-endpoint/SKILL.md`: a new `WorldOverviewService` (`proto/worldmonitor/world_overview/v1/`) with `GetWorldOverviewSnapshot` (GET, request `date` YYYY-MM-DD optional, response = the `WorldOverviewSnapshot` shape from Task 5 as proto messages, plus `archived_dates`) and `SetWorldOverviewMark` (POST, request `item_kind` relation|issue, `item_key`, `action` mark|unmark; response `ok`, `mark`). Commit the proto only, then stop and report `NEEDS_GENERATION`.
> - **Controller:** runs generation in WSL, commits the generated client/server/openapi output (this also refreshes stale `docs/api` files from the earlier hosted-API removal), and hands back.
> - **7b (worker):** implement the handlers in `server/worldmonitor/world-overview/v1/` with the same behaviour as the route design below (date validation, archive read, mark/unmark rewriting today's key, mark rules from Task 5), register the service where the other sebuf services are registered, and add the RPC cache tier entry per the skill. Tests as in the steps below, against the handlers instead of the route. Ignore the `api/world-overview.ts`, `PERSONAL_EDGE_ENTRIES`, `.gitignore` and `api-route-exceptions.json` steps.

The original route design follows for behaviour reference only.

#### (Reference) Past-date and 틀림 route

**Files:**

- Create: `server/_shared/world-overview-route.ts`, `api/world-overview.ts`
- Modify: `scripts/build-sidecar-handlers.mjs` (`PERSONAL_EDGE_ENTRIES`), `.gitignore` (`/api/world-overview.js`), `api/api-route-exceptions.json`, `docs/data-sources.mdx`
- Test: `tests/world-overview-route.test.mts`, `tests/personal-edge-entries.test.mjs`

**Interfaces:**

- Consumes: Task 5 `annotateWrongMarks`, `applyMarkAction`, types; `WORLD_OVERVIEW_KEYS`; `getCachedJson`, `getCachedEnvelopeJson`, `setCachedJson` from `server/_shared/redis.ts` (always `raw = true`); `getCorsHeaders` from `api/_cors.js`.
- Produces:
  ```ts
  export interface WorldOverviewRouteDeps {
    corsHeaders(request: Request): Record<string, string>;
    readJson(key: string): Promise<unknown | null>;        // envelope-unwrapping read
    readEnvelope(key: string): Promise<unknown | null>;    // keeps a runSeed { _seed, data } envelope
    writeJson(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
    now(): number;
  }
  export const WORLD_OVERVIEW_ROUTE_MAX_BODY_BYTES: 4096;
  export const WRONG_MARKS_TTL_SECONDS: 34560000;
  export const TODAY_SNAPSHOT_TTL_SECONDS: 172800;
  export function createWorldOverviewHandler(deps: WorldOverviewRouteDeps): (request: Request) => Promise<Response>;
  ```
  HTTP contract (`/api/world-overview`, owner only behind the personal Basic-auth ingress; every response `Cache-Control: no-store`):
  - `GET ?date=YYYY-MM-DD` → 200 `{ snapshot: WorldOverviewSnapshot }`, annotated with the current marks; today's key when its `date` equals the request, else the archive key. 400 `{ error: 'INVALID_DATE' }` for a malformed or impossible date; 404 `{ error: 'NOT_FOUND' }`.
  - `POST` body `MarkAction` → 200 `{ snapshot, mark }`; writes the marks key (TTL 34560000) and, when the date is today's, rewrites the today key re-annotated (envelope `_seed` kept, TTL 172800). 400 `INVALID_JSON` / `INVALID_ARGUMENTS` / `NOT_MARKABLE`; 404 `NOT_FOUND` / `TARGET_NOT_FOUND` / `MARK_NOT_FOUND`; 413 `PAYLOAD_TOO_LARGE`.
  - `OPTIONS` → 204; anything else → 405 with `Allow: GET, POST, OPTIONS`.

- [ ] **Step 1: Write the failing tests** in `tests/world-overview-route.test.mts`, with an in-memory `Map` (`store`) behind the deps (`readJson` unwraps `{ _seed, data }`, `writeJson` stores the value and records `[key, value, ttl]` in `writes`, `now()` returns `NOW`). Fixtures: today key `world-overview:snapshot:v1` = `{ _seed: SEED, data: SNAP_TODAY }` (date `2026-11-23`, one AI relation `ai:tension:CN-US`, one fixed `fixed:tension:CN-US`, an AI issue on UA); archive `world-overview:snapshot:v1:2026-11-22` = `SNAP_PAST` (date `2026-11-22`, an AI issue on UA). `get(query)`, `post(body)`, `rawPost(text)` build requests to `http://x/api/world-overview`; `json(req)` runs the handler and parses the body; `MARK` is the relation mark action of the third test.
  ```ts
  test('serves a past date from its archive and today from the today key', async () => {
    assert.equal((await json(get('?date=2026-11-22'))).snapshot.date, '2026-11-22');
    assert.equal((await json(get('?date=2026-11-23'))).snapshot.generatedAt, SNAP_TODAY.generatedAt);
  });
  test('rejects malformed and impossible dates, and answers 404 for a missing day', async () => {
    for (const q of ['?date=yesterday', '?date=2026-02-30', '']) assert.equal((await handler(get(q))).status, 400);
    assert.equal((await handler(get('?date=2026-01-01'))).status, 404);
  });
  test('a mark hides the relation at once and keeps the today envelope', async () => {
    const res = await handler(post({ action: 'mark', date: '2026-11-23', target: { type: 'relation', relationId: 'ai:tension:CN-US' } }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mark.id, 'rel:2026-11-23:tension:CN-US');
    assert.equal(body.snapshot.relations.find((l) => l.id === 'ai:tension:CN-US').mark.state, 'hidden');
    const [, today, ttl] = writes.find(([k]) => k === 'world-overview:snapshot:v1');
    assert.deepEqual(today._seed, SEED); assert.equal(ttl, 172800);
    assert.equal(writes.find(([k]) => k === 'world-overview:wrong-marks:v1')[2], 34560000);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
  test('undo removes the annotation and keeps the record', async () => {
    await handler(post(MARK)); const res = await json(post({ action: 'unmark', markId: 'rel:2026-11-23:tension:CN-US' }));
    assert.equal(res.snapshot.relations.find((l) => l.id === 'ai:tension:CN-US').mark, undefined);
    assert.equal(store.get('world-overview:wrong-marks:v1').marks[0].undoneAt, NOW);
  });
  test('marks on a past date change no today key and show on the next read of that date', async () => {
    await handler(post({ action: 'mark', date: '2026-11-22', target: { type: 'issue', iso2: 'UA' } }));
    assert.equal(writes.some(([k]) => k === 'world-overview:snapshot:v1'), false);
    assert.equal((await json(get('?date=2026-11-22'))).snapshot.countries.UA.issue.mark.state, 'hidden');
  });
  test('refuses fixed lines, unknown targets, bad bodies and other methods', async () => {
    assert.equal((await handler(post({ action: 'mark', date: '2026-11-23', target: { type: 'relation', relationId: 'fixed:tension:CN-US' } }))).status, 400);
    assert.equal((await handler(post({ action: 'mark', date: '2026-11-23', target: { type: 'relation', relationId: 'ai:nope' } }))).status, 404);
    assert.equal((await handler(rawPost('{'))).status, 400);
    assert.equal((await handler(rawPost('x'.repeat(4097)))).status, 413);
    assert.equal((await handler(post({ action: 'delete' }))).status, 400);
    const put = await handler(new Request('http://x/api/world-overview', { method: 'PUT' }));
    assert.equal(put.status, 405); assert.equal(put.headers.get('allow'), 'GET, POST, OPTIONS');
  });
  ```
  Add to `tests/personal-edge-entries.test.mjs`:
  ```js
  it('bundles the world overview route the first screen calls', () => assert.ok(entries.includes('world-overview.ts')));
  ```

- [ ] **Step 2: Run the tests and see them fail**

  Run: `node --import tsx --test tests/world-overview-route.test.mts tests/personal-edge-entries.test.mjs`
  Expected: FAIL, the module and the entry are missing.

- [ ] **Step 3: Implement `server/_shared/world-overview-route.ts`** (body reading capped while streaming, as `readBodyWithin` in `server/_shared/travel-risk-export.ts`; dates valid only when `addDays(date, 0) === date`). **Implement `api/world-overview.ts`** after `api/travel-risk-assessment.ts`: `export const config = { runtime: 'edge' }`, default export `createWorldOverviewHandler({ corsHeaders: (r) => getCorsHeaders(r, 'GET, POST, OPTIONS'), readJson: (k) => getCachedJson(k, true), readEnvelope: (k) => getCachedEnvelopeJson(k, true), writeJson: (k, v, ttl) => setCachedJson(k, v, ttl, true), now: () => Date.now() })`.

- [ ] **Step 4: Register.** `scripts/build-sidecar-handlers.mjs`: add `'world-overview.ts'` to `PERSONAL_EDGE_ENTRIES` with a comment naming the first screen. `.gitignore`: `/api/world-overview.js` next to `/api/travel-risk-assessment.js`. `api/api-route-exceptions.json`: `{ "path": "api/world-overview.ts", "category": "internal-helper", "reason": "Personal-fork first-screen state: dated world overview snapshots (aggregate, unversioned screen state like api/bootstrap.js) and the owner's wrong-mark annotations behind the personal Basic-auth ingress. Not a sebuf service because the owner's machine cannot run make generate; see docs/superpowers/plans/2026-11-22-world-overview-data.md.", "owner": "@tkddls8848", "removal_issue": null }`. `docs/data-sources.mdx`: one paragraph on the route and the mark rules.

- [ ] **Step 5: Run the tests and checks**

  Run: `node --import tsx --test tests/world-overview-route.test.mts tests/personal-edge-entries.test.mjs tests/edge-functions.test.mjs tests/edge-function-bundles.test.mjs`
  Expected: PASS.
  Run: `npm run lint:api-contract && npm run lint:boundaries && npm run typecheck:api`
  Expected: each exits 0.

- [ ] **Step 6: Commit**

  ```bash
  git add server/_shared/world-overview-route.ts api/world-overview.ts scripts/build-sidecar-handlers.mjs .gitignore api/api-route-exceptions.json docs/data-sources.mdx tests/world-overview-route.test.mts tests/personal-edge-entries.test.mjs
  git commit -m "feat(api): serve past world overview snapshots and record wrong marks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AjhE6vfRCcusEi77VTyzp2"
  ```

---

## Live evidence (controller, after Task 7, kept separate from test results)

With `npm run start:personal` running on a fresh `npm run build:personal`: `npm run collect:personal -- world-relations gdelt-bulk-materializer world-relations-ai world-overview`, then check `/api/health` for `worldRelations`, `worldPairTrends`, `worldRelationsAi`, `worldOverview` (`OK`, or `EMPTY_ON_DEMAND` before the first publish), `GET /api/bootstrap?keys=worldOverview`, and `GET /api/world-overview?date=<today KST>`. Read `diagnostics.opensanctions.rows`, `sanctions.unmappedDatasets` (extend `shared/world-sanctions-issuers.json` for any large unmapped list in a follow-up commit), `sanctions.crossCheck`, the AI `status` and `diagnostics.calls`, and the snapshot size. This records live freshness; it is not a substitute for the tests and does not prove the UI.
