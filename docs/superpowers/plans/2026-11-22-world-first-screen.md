# World First Screen (① 단계) Implementation Plan

> **For agentic workers:** each task below is one worker. Read the header, Global Constraints, Rulings and Interfaces, then YOUR task only. Steps use checkbox (`- [ ]`) syntax.

**Goal:** `/dashboard` opens on a map-centric "world first screen" (choropleth + relation lines, ticker row, breaking-news row, five field buttons, date/timelapse shelf, country drawer). "전체 보기" switches to the existing map + inspector UI, and the 86 panels are not built until then.

**Architecture:** the world-overview snapshot (`worldOverview` on-demand bootstrap key, `WorldOverviewService` RPC for past dates and wrong-marks) is turned into a `WorldMapView` by a pure service, drawn by new DeckGL layers inside the existing `DeckGLMap`, and surrounded by new DOM components under `src/components/world/`. `src/app` owns the mode switch and wiring.

**Tech Stack:** TypeScript, Vite, deck.gl + MapLibre (existing), vitest + happy-dom for `tests/dom`, `node --import tsx --test` for `tests/*.test.mts`.

**Spec:** `docs/superpowers/specs/2026-11-21-world-overview-design.md` §5.1, §6. **Visual spec (binding for look):** `C:\Users\tkddl\orca\worldmonitor\.personal\argus-style-mockups\FINAL-SPEC-OPTION-A.md`, its `README.md` §6 (5 states per element), `option-a.html`, `shared-tokens.css`, `screenshots/option-a-*.png`. Read these by absolute path (the folder is not in git).

## Global Constraints

- Import direction `types -> config -> services -> components -> app` (`node scripts/lint-boundaries.mjs`). `src/components/world/*` must not import `src/app/*`.
- Already on `main` (do not redefine): `src/types/world-overview.ts` (view types), `src/config/world-overview-palette.ts` (map colours), `shared/world-overview.js` (`selectVisibleLines`, `countryFill`, `isDrawableEndpoint`, `DEFAULT_FIELDS`, `WORLD_FIELDS`, `FIELD_LABEL_KO`, `KIND_LABEL_KO`, `LEVEL_LABEL_KO`, `TREND_LABEL_KO`, `AI_DISCLAIMER_KO`, `LINE_BUDGET`=30).
- Never hand-edit `src/generated/`. No new npm dependencies. No emoji in UI; inline SVG icons 14px, stroke 1.5–1.6.
- Korean UI copy. Remove the mockup's `[예시 데이터]` badge and state-preview switch.
- Map 3.5 s gate and 180 ms search debounce stay as they are.
- Light and dark themes both work (`<html data-theme>` from `src/utils/theme-manager.ts`, event `theme-changed` on window).
- `:focus-visible` ring 2px `--accent`, offset 2px; `Escape` closes the drawer; `prefers-reduced-motion: reduce` disables motion.

## Rulings (controller decisions; spec wins over the mockup where they differ)

1. Fill mapping (`countryFill` result → `FillLevel`): `war`→4, `high`→3, `medium`→2, `tension`→1, `issue`→1, `null`→0. Countries absent from the snapshot use level 0. The design's "data none" colour is used only when the snapshot itself is missing (error/empty state).
2. Field behaviour follows spec §5.1 table, not the mockup's "max of active field scores": military → conflict fill; politics → unrest outline (`country.unrest`); diplomacy → bloc outlines + alliance lines; geopolitics → tension lines; finance → sanction + economic lines. When military is off, `level` is `null` and land is drawn with level-0 colour. Default fields = `DEFAULT_FIELDS` (military, geopolitics).
3. Lines on the map are `selectVisibleLines(snapshot, fields)` (budget 30), minus endpoints that fail `isDrawableEndpoint`. The drawer lists every non-hidden relation of the country, unbudgeted.
4. Trend: `rising`/`surging` = worsening (▲ 악화), `easing` = easing (▼ 완화), others steady. Default tags: at most 6 lines, greedy by `score` desc among worsening/easing lines, skipping a line if either endpoint already has a tag. With a selected country: tag every worsening/easing line touching it.
5. `economic` kind: violet dash-dot (`9 3.2 2 3.2`) with diamond marks on both ends, per the design appendix (FINAL-SPEC-OPTION-A 부록 2).
6. No dash flow animation (perf); dashes are static.
7. Mode preference key `worldmonitor-first-screen-mode` (`'world' | 'full'`, default `'world'`); field preference key `worldmonitor-world-fields` (JSON array, validated against `WORLD_FIELDS`, default `DEFAULT_FIELDS`). Date selection is not persisted (always opens on today).
8. Perf mark `wm:world:first-draw`: emitted once, after the first deck draw that contains the world fill layer with data.
9. Drawer open state selector for tests and perf: `.wfs-country-drawer[data-state="open"]`.

## Interfaces (exact names; each task implements its own, consumes others' as typed here)

**Task 1 – services** (`src/services/`):
- `world-overview.ts`: `normalizeWorldSnapshot(raw: unknown): WorldOverviewSnapshot | null` (accepts both the stored/bootstrap shape with `anchors` as `[lon, lat]` tuples and the RPC proto shape with `{latitude, longitude}`, `hasX` flags, `optional` fields; returns the `shared/world-overview.d.ts` type). `loadWorldOverview(date?: string): Promise<{ snapshot: WorldOverviewSnapshot | null; archivedDates: string[] }>` (no date: `ensureHydrated('worldOverview')` then RPC fallback; date: RPC with `date`). `setWorldMark(req: WorldMarkRequest): Promise<{ ok: boolean }>`.
- `world-overview-view.ts`: `fillLevelFor(fill: CountryFill): FillLevel`; `buildWorldMapView(snapshot: WorldOverviewSnapshot, fields: readonly WorldField[], selectedIso2: string | null): WorldMapView`; `buildCountryDrawerData(snapshot: WorldOverviewSnapshot, iso2: string, todayDate: string): CountryDrawerData` (names via `Intl.DisplayNames(['ko'|'en'], {type:'region'})`, fallback iso2); `filterDrawerRelations(rels: DrawerRelation[], filter: 'all' | 'worsening' | 'easing'): DrawerRelation[]`.
- `world-ticker.ts`: `buildTickerItems(src: { marketQuotes?: unknown; commodityQuotes?: unknown; cryptoQuotes?: unknown; macroSignals?: unknown }): TickerItem[]` — 8 items in this order when the data exists: 미 10년물 금리, S&P 500, 나스닥, KOSPI, WTI, 금, 원/달러, 비트코인. Missing → `value: null` (still listed). Each `id` is the source symbol.

**Task 2 – map** (`src/components/`):
- `map/world-overview-layers.ts`: `buildWorldOverviewLayers(view: WorldMapView, countries: GeoJSON.FeatureCollection, theme: ThemeName, hoverIso2: string | null): Layer[]` (pure; fill, unrest/bloc outlines, line casing, lines, end marks, tags).
- `DeckGLMap`: `setWorldOverviewMode(on: boolean): void` (on = hide every existing data layer and dot marker without changing the persisted `worldmonitor-layers`; off restores), `setWorldOverview(view: WorldMapView | null): void`, `onWorldLineClicked(cb: (lineId: string) => void): void`, `zoomBy(delta: number): void`, `resetWorldView(): void`. Line hover shows a tooltip: kind label, trend label, `label`.
- `MapContainer`: same five methods as pass-throughs (no-op on the SVG/mobile map except zoom/reset where it has an equivalent).

**Task 3 – chrome components** (`src/components/world/`, `src/styles/world-first-screen.css`):
- `WorldMasthead({ onToggleTheme, onOpenFullView, onTickerClick(id: string) })`: `.element`, `setTickerItems(items: TickerItem[])`, `destroy()`.
- `WorldDispatchBar({ onLocate(alert: BreakingAlert) })`: listens to `wm:breaking-news` itself (type from `src/services/breaking-news-alerts.ts`), keeps the last 10, ‹ › paging; `.element`, `destroy()`.
- `WorldKeyPlate()`: `.element`, `setFields(fields: readonly WorldField[])` (legend shows only what active fields draw).
- `WorldZoomControls({ onZoomIn, onZoomOut, onReset })`: `.element`.
- `WorldBottomShelf({ onFieldsChange(fields: WorldField[]), onDateChange(date: string) })`: `.element`, `setFields(fields)`, `setDates(available: string[], current: string)` (slider, ‹ ›, date input limited to available dates, timelapse play/stop stepping every 1200 ms through available dates; stops at the last date), `destroy()`.
- `WorldStatusBanner()`: `.element`, `setState(state: WorldLoadState, detail?: string)` (loading / empty / error copy per README §6; hidden on ok).
- CSS: tokens from FINAL-SPEC §2.2 under `.wfs-root` (light) and `:root[data-theme="dark"] .wfs-root` (dark); layout grid rows 38/32/1fr/48 px; breakpoints >1440, ≤1440, ≤768 per FINAL-SPEC §1 table.

**Task 4 – country drawer** (`src/components/world/WorldCountryDrawer.ts`, `src/styles/world-country-drawer.css`):
- `WorldCountryDrawer({ onClose, onSelectCountry(iso2: string), onMark(req: WorldMarkRequest): Promise<void>, onOpenFullPanels(iso2: string) })`: `.element`, `open(data: CountryDrawerData)`, `update(data: CountryDrawerData)`, `close()`, `isOpen(): boolean`, `destroy()`. Root class `wfs-country-drawer`, `data-state="open"|"closed"`. Content order per FINAL-SPEC §3.1: header (ISO, serif ko name, en name, close, CII gauge 0–100, updated time) → AI notice bar (`AI_DISCLAIMER_KO`, `틀림 신고` per item) → 오늘의 핵심 이슈 → 국가 간 관계 with `[전체][▲ 악화][▼ 완화]` filter (uses the same rule as `filterDrawerRelations`; implement locally, do not import Task 1) and clickable counterpart cards → 출처 링크 (new tab, `rel="noopener noreferrer"`) → footer `이 국가의 전체 86개 패널 열기`. Mark buttons only when `isToday`; hidden items show "틀림으로 표시함 · 취소" (unmark); `mark.state === 'reappeared'` shows "다시 나타남, 이전에 틀림으로 표시함". ≤768 px becomes a bottom sheet (68vh).

**Task 5 – mode switch** (`src/app/`, `src/App.ts`, `src/services/world-first-screen-prefs.ts`):
- `world-first-screen-prefs.ts`: `getFirstScreenMode(): 'world' | 'full'`, `setFirstScreenMode(m)`, `getWorldFields(): WorldField[]`, `setWorldFields(f: readonly WorldField[])` (Ruling 7; storage via `loadFromStorage`/`saveToStorage` from `src/utils`).
- `src/app/world-first-screen.ts`: `export interface WorldFirstScreenSlots { root: HTMLElement; masthead: HTMLElement; dispatch: HTMLElement; stage: HTMLElement; shelf: HTMLElement }` and `export function mountWorldFirstScreen(ctx: AppContext, slots: WorldFirstScreenSlots, hooks: { openFullView(): void }): { destroy(): void; onEnter(): void }` — a stub that returns no-ops (Task 7 fills it).
- In world mode: render the `.wfs-root` shell with the four slots, build only the `MapContainer` (mounted in `stage`) and call `map.setWorldOverviewMode(true)` if the method exists; do NOT construct panels, the inspector shell, panel tabs, `BreakingNewsBanner`, or run `loadAllData`/`runVisibleDataFanout`/`primeVisiblePanelData`. Run only the news load that feeds `checkBatchForBreakingAlerts` (so `wm:breaking-news` fires). `enterFullView()` builds everything lazily once (first time) and shows the existing layout; `enterWorldView()` hides it and shows the shell again. Both persist the mode. Country clicks go to the world screen in world mode and to the existing country brief in full mode. A saved `'full'` boots straight into the existing UI exactly as today.

**Task 6 – perf tooling** (`scripts/perf-personal.mjs`, `scripts/perf/*`): metric `worldReady` from mark `wm:world:first-draw`; when `#panelsGrid` is absent, `panelsReady` and the panel interaction are `null` (not a failure) and stats/compare skip nulls; country interaction in world mode measures click → `.wfs-country-drawer[data-state="open"]`.

**Task 7 – integration** (after 1–6 merge): fill `mountWorldFirstScreen`: load snapshot, build view, push to map, wire every component callback (fields → prefs + view; date/timelapse → `loadWorldOverview(date)`; country click → drawer via `buildCountryDrawerData`; drawer counterpart → select; mark → `setWorldMark` then reload today; open full panels → `openFullView` then existing country brief; theme toggle; ticker from hydrated `marketQuotes`/`commodityQuotes`/`cryptoQuotes`/`macroSignals` + click → full view revealing the markets panel; zoom; status banner states).

## Review Focus

1. Snapshot missing (collector not run yet) → status banner "데이터 없음", map still drawn with level-0 land, no crash.
2. RPC error on a past date → error banner, previous view kept.
3. Saved preference `'full'` from before this change, or old `worldmonitor-layers` values → boots into the existing UI unchanged.
4. Country with no relations / no issue → drawer sections show their empty copy, not blank.
5. Theme switch while drawer open and lines drawn → map colours and chrome both update.

---

## Task 1: services
- [ ] Tests first: `tests/world-overview-view.test.mts` (Rulings 1–4, both snapshot shapes via `normalizeWorldSnapshot`, drawer data, filter), `tests/world-ticker.test.mts` (order, missing data → null). Use fixtures, no network.
- [ ] Implement the three modules; register the world-overview client the way other clients are registered in `src/services/generated-rpc-clients.ts`.
- [ ] `node --import tsx --test` both files; `npm run typecheck`; `node scripts/lint-boundaries.mjs`. Commit `feat(world): first-screen snapshot, view and ticker services`.

## Task 2: map layers
- [ ] Tests first: `tests/world-overview-layers.test.mts` for `buildWorldOverviewLayers` (layer ids present, fill colour per level and theme, dimming 0.36 when selected, casing under lines, dash per kind, tag count ≤6, no layers for empty view). Check the country GeoJSON property used for ISO2 in `src/services/country-geometry.ts`.
- [ ] Implement layers (use `@deck.gl/extensions` `PathStyleExtension` for dashes only if already installed; otherwise draw dashes as split path segments). Implement the DeckGLMap/MapContainer methods and Ruling 8 mark via `src/utils/lcp-debug.ts`.
- [ ] Add a DOM test only if an existing `tests/dom/deckgl-*` test shows a cheap pattern for `setWorldOverviewMode` restore; otherwise cover restore logic as a pure helper in the node test.
- [ ] Run tests, `npm run typecheck`, lint-boundaries. Commit `feat(world): deck layers for country fill and relation lines`.

## Task 3: chrome components
- [ ] Tests first: `tests/dom/world-chrome.test.mts` (ticker renders 8 items with up/down classes and `—` for null; dispatch bar shows the last alert on `wm:breaking-news`; shelf emits field changes (zero active fields is allowed and means an empty map); date step/clamp; timelapse stops at last date with fake timers; key plate hides line kinds of inactive fields; status banner states).
- [ ] Implement components + CSS following the visual spec exactly (sizes, tokens, focus, breakpoints). Follow the repo convention for how component CSS is imported.
- [ ] `npx vitest run --config vitest.dom.config.mts tests/dom/world-chrome.test.mts`; typecheck; lint-boundaries. Commit `feat(world): first-screen chrome components`.

## Task 4: country drawer
- [ ] Tests first: `tests/dom/world-country-drawer.test.mts` (open/close/Escape, section order, filter, counterpart click, mark only when isToday, unmark copy, reappeared copy, empty-state copy, sources open in new tab with noopener).
- [ ] Implement + CSS. Run the test; typecheck; lint-boundaries. Commit `feat(world): country drawer`.

## Task 5: mode switch
- [ ] Tests first: `tests/dom/first-screen-mode.test.mts` (prefs defaults/validation; world mode builds no panels and no inspector; enterFullView builds once; toggling back and forth keeps one map instance; saved `'full'` boots the old layout). Reuse helpers from `tests/dom/app-destroy-lifecycle.test.mts` / `inspector-shell-and-tray.test.mts`.
- [ ] Implement. Keep every existing `tests/dom` test that touches panel-layout/App passing (run the ones you touched).
- [ ] typecheck; lint-boundaries. Commit `feat(world): first-screen mode switch with deferred panels`.

## Task 6: perf tooling
- [ ] Tests first in the existing perf test files (find them with `ls tests | grep perf`): null metrics skipped, `worldReady` summarized and compared.
- [ ] Implement. Run the perf tests. Commit `feat(perf): world first-screen readiness metric`.

## Task 7: integration
- [ ] After merging 1–6: implement `mountWorldFirstScreen`, run all world tests + typecheck + lint, build, live check on the personal server, perf run. Commit `feat(world): wire the first screen`.
