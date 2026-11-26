# Architecture

## Personal fork runtime

This fork is a single-owner personal setup on one machine. It has four parts:

| Part | Command | Role |
|------|---------|------|
| Personal server | `npm run start:personal` (`scripts/personal-server.mjs`) | Serves the built dashboard (`dist/`) and the local API on loopback, `private, no-store` |
| Local API | `scripts/local/local-api-server.mjs`, started by the personal server | Runs the `api/` handlers (built with `npm run build:personal`) on a loopback port, with cloud fallback off |
| Embedded store | `scripts/local/embedded-store.mjs`, started when `WM_PERSONAL_STORE=embedded` | Redis REST compatible store on `127.0.0.1:8079`, snapshot in `.personal/store.ndjson`; implements only the commands and pinned scripts the collectors and handlers use |
| Collectors | `npm run collect:personal` (`scripts/personal-collect.mjs`) | Run the `seed-*` collectors against the store, once or with `--watch N` |

`npm run tui:personal` opens the terminal dashboard (`cli/src/tui`) against the personal server. `npm run scenario:local` evaluates a supplied exposure snapshot without a queue or store. The intelligence history is a `node:sqlite` file (`.personal/intel-history.sqlite`). The personal server also starts the scenario worker when a store is configured.

`npm run build:personal` runs the strict VITE secret guard, builds the API handler bundles and builds the Korean-first dashboard with `VITE_PERSONAL_MODE=true`. The browser has no sign-in, checkout, analytics, error reporting or service worker. LLM calls go to OpenRouter, with Anthropic tried first when `ANTHROPIC_API_KEY` is set. External access uses an HTTPS reverse proxy in front of the loopback listener.

Seeded datasets keep the existing store contracts; personal startup accepts only a loopback store endpoint. A dataset with no collected data is unavailable, not an empty observation.

> **Inventory ownership**: map layers, services, protos, locales, CI workflows, and freshness sources are defined by their registries. `npm run docs:check` verifies registry and fixed-contract documentation; generated snapshots are refreshed with `npm run docs:stats`.
>
> **Ownership rule**: When the runtime topology, API surface, or bootstrap keys change, this document must be updated in the same commit.

> **Design philosophy**: For the "why" behind architectural decisions, intelligence tradecraft, and algorithmic choices, see [Design Philosophy](docs/architecture.mdx).

World Monitor is a real-time global intelligence dashboard built as a TypeScript single-page application. It aggregates data from dozens of external sources covering geopolitics, military activity, financial markets, cyber threats, climate events, maritime tracking, and aviation into a unified operational picture rendered through an interactive map and a grid of specialized panels.

---

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                           Browser                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌─────────────┐  │
│  │ DeckGLMap│  │ SVG Map  │  │  Panels   │  │  Workers    │  │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘  └─────────────┘  │
│       └─────────────┴──────────────┘                          │
│                     │ fetch /api/*                            │
└─────────────────────┼────────────────────────────────────────┘
                      │
           ┌──────────▼──────────┐       ┌────────────────────┐
           │  Personal server    │       │  Collectors        │
           │  (static + ingress) │       │  collect:personal  │
           │          │          │       └─────────┬──────────┘
           │   Local API server  │                 │
           │   (api/ handlers)   │                 │
           └──────────┬──────────┘                 │
                      │                            │
               ┌──────▼────────────────────────────▼──┐
               │ Embedded store (127.0.0.1:8079)      │
               │ + node:sqlite intelligence history   │
               └──────────────────┬───────────────────┘
                                  │
              ┌───────────────────┼──────────────────┐
        ┌─────▼───┐         ┌─────▼───┐         ┌────▼────┐
        │ Finnhub │         │  Yahoo  │         │ ACLED   │
        │ OpenSky │         │  GDELT  │         │ UCDP    │
        │   ...   │         │   ...   │         │   ...   │
        └─────────┘         └─────────┘         └─────────┘
        upstream hosts: shared/source-attribution-manifest.json
```

**Source files**: `package.json`, `scripts/personal-server.mjs`, `scripts/local/`

---

## 2. Personal runtime topology

| Process | Role |
|---------|------|
| Node.js personal server | Loopback-only static dashboard, local API and embedded store |
| Collectors | Fetch enabled providers using the owner's credentials |
| Scenario worker | Runs queued scenario jobs from the store |
| Optional HTTPS proxy | Private external access to the same personal server |

Container images, Compose, nginx, supervisor configuration and the hosted deployment (Vercel, Railway, Convex, Clerk) are removed. `docs/internal/public-launch-disclosures.md` lists what a future public launch would have to disclose.

## 3. Frontend Architecture

### Entry and Initialization

`src/main.ts` installs the startup fallbacks, the variant theme, the `/api/*` redirect patch (`installWebApiRedirect`), WebMCP tool registration and dynamic meta tags, then creates the `App` instance.

`App.init()` runs in 7 phases:

1. **Storage + i18n**: IndexedDB, language detection, locale loading
2. **ML Worker**: ONNX model prep (embeddings, sentiment, summarization)
3. **Bootstrap**: Two-tier concurrent hydration from `/api/bootstrap` (fast 3s + slow 5s timeouts)
4. **Layout**: PanelLayoutManager renders map and panels
5. **UI**: SignalModal, IntelligenceGapBadge, BreakingNewsBanner, correlation engine
6. **Data**: Parallel `loadAllData()` + viewport-conditional `primeVisiblePanelData()`
7. **Refresh**: Variant-specific polling intervals via `startSmartPollLoop()`

### Component Model

All panels extend the `Panel` base class (`src/components/Panel.ts`). Panels render via `setContent(html)` (debounced 150ms) and use event delegation on a stable `this.content` element. Panels support resizable row/col spans persisted to localStorage.

### Map System

- **DeckGLMap**: WebGL rendering via deck.gl + maplibre-gl. Supports ScatterplotLayer, GeoJsonLayer, PathLayer, IconLayer, PolygonLayer, ArcLayer, HeatmapLayer, H3HexagonLayer. PMTiles protocol for self-hosted basemap tiles. Supercluster for marker clustering.
- **Loaded news selection**: `MapContainer.onNewsClicked()` caches and forwards the callback to each renderer's `setOnNewsClick()`. The callback receives `Pick<NewsLocationMarker, 'article' | 'title'>`: optional original loaded article `{link, title, source}` and the displayed marker title. Existing markers without article metadata remain valid. The plugin uses this loaded identity to publish its latest interaction with current view context; it does not track popup visibility or fetch more data on selection.
- **MapComponent (SVG)**: D3/SVG renderer in `src/components/Map.ts` for phones and for desktops without hardware WebGL2. `MapContainer` picks DeckGL or SVG per device. There is no 3D globe; it was removed, and an agent `set_map_mode` request for `3d` is denied with `globe_unavailable`.

Layer definitions live in `src/config/map-layer-definitions.ts`, each specifying renderer support (`svg`/`deck`), variant filtering, and i18n keys. The personal build has no layer entitlements.

### State Management

No external state library. `AppContext` is a central mutable object holding: map references, panel instances, panel/layer settings, all cached data (news, markets, predictions, clusters, intelligence caches), in-flight request tracking, and UI component references. URL state syncs bidirectionally via `src/utils/urlState.ts` (debounced 250ms).

### Web Workers

- **analysis.worker.ts**: News clustering (Jaccard similarity), cross-domain correlation detection
- **ml.worker.ts**: ONNX inference via `@xenova/transformers` (MiniLM-L6 embeddings, sentiment, summarization, NER), in-worker vector store for headline memory
- **vector-db.ts**: IndexedDB-backed vector store for semantic search

### Variant System

Detected by hostname (`tech.worldmonitor.app` → tech, `finance.worldmonitor.app` → finance, etc.) or the `VITE_VARIANT` build variable; the personal build uses `full`. Controls: default panels, map layers, refresh intervals, theme, UI text. Variant change resets all settings to defaults.

**Source files**: `src/main.ts`, `src/App.ts`, `src/app/`, `src/components/Panel.ts`, `src/components/DeckGLMap.ts`, `src/components/Map.ts`, `src/config/variant.ts`, `src/workers/`

---

## 4. API Layer

### API entries

The `api/` directory holds two kinds of endpoints. `npm run build:personal` bundles them and the local API server runs them in-process:

- **Domain intelligence gateways** — generated from proto contracts and backed by handlers under `server/worldmonitor/**`. The per-domain thin entry points (`api/<domain>/v<N>/[rpc].ts`) are produced via `createDomainGateway` (`server/gateway.ts`) and esbuild-bundled into `api/<domain>/v<N>/[rpc].js` (gitignored build output).
- **Operational endpoints** — hand-written for concerns that don't fit the contract model: bootstrap/health, the brief reader, RSS and feed proxies, Trip Assessment (`api/travel-risk-assessment.ts`) and a few data passthroughs.

Compact health separates actionable `problems` from bounded `pending` diagnostics. Both retain the source diagnosis. Pending deadlines also bound the verdict cache lifetime.

Entries are bundled per file, a constraint enforced by `tests/edge-functions.test.mjs` and the pre-push esbuild bundle check. Hand-written endpoints that genuinely cannot be proto-defined are listed in `api/api-route-exceptions.json` and enforced by `npm run lint:api-contract`.

### Shared Helpers

| File | Purpose |
|------|---------|
| `_cors.js` | Origin allowlist |
| `_personal-providers.js` | Internal calls to the adapters inside the personal server; no external relay configuration |
| `_upstash-json.js` | Store reads for legacy entries |
| `_json-response.js` | JSON response helper |

### Gateway Factory

`server/gateway.ts` provides `createDomainGateway(routes)` for per-domain bundles. Pipeline:

1. Origin check (403 if disallowed)
2. CORS headers
3. OPTIONS preflight
4. Route matching (static Map lookup, then dynamic `{param}` scan)
5. POST-to-GET compatibility (for stale clients). Unmatched POSTs with a trusted `Content-Length` under 1 MB may be retried as GET when a GET handler exists for the path. The body is all-or-nothing: JSON objects of scalars and scalar arrays become query parameters; object values, nested/non-scalar array members, non-object JSON, malformed JSON, and unread bodies return 400 without applying a partial translation. Empty or whitespace-only bodies still fall through to GET with no extra query parameters. Unknown paths still 404/405. Array expansion remains capped at 200 values per key.
6. Handler execution with error boundary
7. ETag generation (FNV-1a hash) + 304 Not Modified
8. Cache header application

The personal ingress authenticates the owner before any request reaches the gateway, so the gateway applies no API keys, entitlements or rate limits.

### Cache Tiers

| Tier | s-maxage | Use case |
|------|----------|----------|
| fast | 300s | Live event streams, flight status |
| medium | 600s | Market quotes, stock analysis |
| slow | 1800s | ACLED events, cyber threats |
| static | 7200s | Humanitarian summaries, ETF flows |
| daily | 86400s | Critical minerals, static reference data |
| no-store | 0 | Vessel snapshots, aircraft tracking |

### Domain Handlers

`server/worldmonitor/<domain>/v1/handler.ts` exports handler objects with per-RPC functions. Each RPC function uses `cachedFetchJson()` from `server/_shared/redis.ts` for cache-miss coalescing: concurrent requests for the same key share a single upstream fetch and Redis write.

The `scorecard/v1` domain is an exception to request-time upstream fetching. Its generated `ScorecardService` country, list, and bloc RPCs read one frozen cohort from `scorecard:five-factor:v1:read-model`, then use `scorecard:five-factor:v1` only as a bounded last-good fallback. The canonical pure adapters and country scorer live under `scripts/scorecard/v1/` for the scripts-root publisher; a checked generator emits Edge-safe copies under the server domain, which owns Redis reads, bloc scoring, and public response conversion. See [Five-factor scorecard v1 architecture](docs/architecture/five-factor-scorecard-v1.md).

The `supply-chain/v1` country-vulnerability, ranking, and chokepoint-dependency RPCs also read a collector-published cohort instead of fetching upstream data at request time. `seed-supply-vulnerability.mjs` scores each country and builds the chokepoint inverse index in one pass, writes country and chokepoint shards into the inactive Redis slot, and switches the shared cohort pointer only after every shard is valid. The manifest and every shard carry an explicit redistribution-policy version; readers reject an older unmarked cohort until the matching publisher activates a current one. Every direct RPC or MCP response fails closed on provider inputs whose programmatic redistribution is restricted, The canonical cohort retains the full attribution-bound evidence for internal audit, but the restricted values do not leave through these routes. The three routes are also `no-store`.

`IntelligenceService.GetCountryCoverage` is the inverse case: it serves an agent surface that must agree, event for event, with what the browser country panel renders. Rather than reimplement the panel's rules server-side, the rules were moved to `shared/` and both sides import them — `country-headline-match.ts` (which country a headline is primarily about), `threat-keyword-classifier.ts` (lane and severity), and `country-timeline-events.ts` (36-hour incident clustering and structured-record precedence). A second copy of any of these is the defect this arrangement exists to prevent, and the ordering between them is load-bearing: cluster first, then filter by country, because a cluster is represented by its earliest member.

Its coverage half fetches Google News at request time through `news/v1`'s shared fetcher rather than standing up a second RSS transport; its structured half composes five existing first-party RPCs. Because several of those upstream handlers catch their own failures and return an empty array, this route cannot learn about an outage from a thrown error — it reads the backing seed key's own hit/miss/error status instead, and reports `failed` rather than `empty` when the cache is unreadable. Producers that genuinely cannot prove they were reached report `unknown`. `degraded` covers only `stale` and `failed`, the states that mean something changed; the per-producer `sources` block, always populated, is where the guarantee lives that an empty event list is never silently healthy.

`MarketService.GetPhysicalDivergenceIndex` is also a read-model RPC. The daily macro seed bundle normalizes SGE SHAU/SHAG benchmarks against the independently timestamped COMEX and FX snapshots, appends bounded per-metal history, and atomically publishes `market:physical-divergence:v1`, its health metadata, activation marker, and transition cooldowns. The handler revalidates the stored contract and re-ages every input clock before it serves the response; the route is `no-store` so independently aging cohorts are never joined through a stale shared cache. MCP reads the same normalized snapshot, and the commodities panel renders the same explicit `ok`, `insufficient_history`, `stale_input`, or `missing_input` states. See [Physical divergence index methodology](docs/methodology/physical-divergence-index.mdx).

**Source files**: `api/`, `server/gateway.ts`, `server/router.ts`, `server/_shared/redis.ts`, `server/worldmonitor/`

---

## 5. Proto/RPC Contract System

The project uses the **sebuf** framework built on Protocol Buffers:

```
proto/ definitions
    ↓ buf generate
src/generated/client/   (TypeScript RPC client stubs)
src/generated/server/   (TypeScript server message types)
docs/api/               (OpenAPI v3 specs)
```

Service definitions use `(sebuf.http.config)` annotations to map RPCs to HTTP verbs and paths. GET fields require `(sebuf.http.query)` annotation. `repeated string` fields need `parseStringArray()` in the handler. `int64` maps to `string` in TypeScript.

CI enforces generated code freshness via `.github/workflows/proto-check.yml`: runs `make generate` and fails if output differs from committed files. Phase 1 froze `proto/` and `src/generated/`; the leads, feedback and company-monitoring definitions whose gateways were deleted are pruned in Phase 2 (`RETIRED_GENERATED_SERVICES` in `scripts/enforce-sebuf-api-contract.mjs`).

**Source files**: `proto/`, `Makefile`, `src/generated/`, `.github/workflows/proto-check.yml`

---

## 6. Data Pipeline

### Bootstrap Hydration

`/api/bootstrap` reads cached keys from Redis in a single batch call. The SPA fetches two tiers concurrently (fast + slow) with separate abort controllers and timeouts. Large or opt-in datasets use a public, CDN-shielded single-key request and are consumed through `ensureHydrated(key)` only when their panel renders. Tier-hydrated data is consumed by panels via `getHydratedData(key)`.

### Seed Scripts

`scripts/seed-*.mjs` fetch upstream data, transform it, and write to Redis via `atomicPublish()` from `scripts/_seed-utils.mjs`. Atomic publish acquires a Redis lock (SET NX), validates data, writes the cache key, writes `seed-meta:<key>` with `{ fetchedAt, recordCount }`, and releases the lock.

`seed-five-factor-scorecard.mjs` runs inside the `seed-bundle-resilience` bundle. It reads only landed source snapshots, builds the closed scorecard evidence ledger, stages a narrow hash read model, and atomically switches the canonical cohort and read model with one idempotent Lua publication. `seed-meta:scorecard:five-factor` and health coverage remain separate from deployment and production-acceptance evidence.

`seed-supply-vulnerability.mjs` runs once per durable turn in the static-reference bundle after its mirrored inputs. It publishes `supply-chain:vulnerability:cohort:v1` plus two-slot country and chokepoint shards, then writes separate activation and seed-health metadata. The cohort pointer is the read authority; compatibility manifests are not independent publication clocks.

### Collectors

`npm run collect:personal` (`scripts/personal-collect.mjs`) runs the collectors one at a time against the embedded store, once or every N minutes with `-- --watch N`. `DEFAULT_COLLECTORS` lists every bundle and the standalone collectors it runs; a collector whose API key is missing fails on its own and the pass continues. Bundles skip members that are still fresh. Standalone collectors in `STANDALONE_INTERVAL_MIN` skip a pass while their last success (kept in `.personal/collect-state.json`) is younger than their interval. `seed-pizzint.mjs` runs the collector's PizzINT producer block against the store, since the relay itself does not run in personal mode.

The personal server runs the AIS and OREF live loops in-process. The collector runs batch producers through standalone seed scripts and the backup bundles.

The market backup bundle also persists 14 days of timestamped hourly Yahoo closes for the news-to-market correlation panel. This series is an on-demand bootstrap key, so it does not increase the default hydration payload.

### Refresh Scheduling

`startSmartPollLoop()` supports: exponential backoff (max 4x), viewport-conditional refresh (only if panel is near viewport), tab-pause (suspend when hidden), and staggered flush on tab visibility (150ms delays).

### Health Monitoring

`api/health.js` checks every bootstrap and standalone key. For each key it reads `seed-meta:<key>` and compares `fetchedAt` against `maxStaleMin`. Cascade groups handle fallback chains (e.g., theater-posture: live, stale, backup). Returns per-key status: OK, STALE, WARN, EMPTY.

**Source files**: `api/bootstrap.js`, `api/health.js`, `scripts/_seed-utils.mjs`, `scripts/seed-*.mjs`, `scripts/personal-providers.cjs`, `src/services/bootstrap.ts`, `src/app/refresh-scheduler.ts`

---

## 7. Local API server

`scripts/local/local-api-server.mjs` runs the bundled `api/` handlers on a dynamic loopback port. The personal server starts it with `mode: 'docker'` and cloud fallback off, so a missing handler answers 404 instead of reaching the upstream API. It strips its own transport token before a handler sees the request and monkey-patches `globalThis.fetch` to force IPv4 (many government APIs have broken IPv6).

**Source files**: `scripts/personal-server.mjs`, `scripts/local/local-api-server.mjs`, `scripts/build-sidecar-handlers.mjs`

---

## 8. Security Model

### Trust Boundaries

```
Browser ↔ Personal ingress (loopback, Host allowlist) ↔ Local API ↔ Upstream APIs
Collectors ↔ Upstream APIs, Embedded store
```

### Content Security Policy

`index.html` carries the CSP `<meta>` tag; `vite.config.ts` injects per-build nonces. The personal ingress serves the built HTML unchanged.

### Authentication

The personal ingress listens only on loopback and serves the dashboard without a login. It checks Host on every request and rejects cross-origin API requests. `WM_PERSONAL_ALLOWED_HOSTS` adds exact Host values for a trusted reverse proxy. The app serves these hosts without authentication, so the proxy controls remote access. Provider API keys stay in the server environment; `npm run security:vite-env-secrets -- --strict-local` keeps them out of `VITE_*` variables.

**Source files**: `scripts/personal-server.mjs`, `index.html`, `src/services/runtime.ts`, `scripts/check-vite-env-secrets.mjs`

---

## 9. Caching Architecture

### Four-Layer Hierarchy

```
Bootstrap seed (collectors write to the store)
    ↓ miss
In-memory cache (per server process, short TTL)
    ↓ miss
Embedded store (Redis REST compatible, cachedFetchJson coalesces concurrent misses)
    ↓ miss
Upstream API fetch (result cached back to Redis + seed-meta written)
```

### Cache Key Rules

Every RPC handler with shared cache MUST include request-varying parameters in the cache key. Failure to do so causes cross-request data leakage.

### ETag / Conditional Requests

`server/gateway.ts` computes an FNV-1a hash of each response body and returns it as an `ETag`. Clients send `If-None-Match` and receive `304 Not Modified` when content is unchanged.

### Cache headers

The personal ingress answers every request `private, no-store`, so `Cache-Control` and `CDN-Cache-Control` tiers set by handlers only matter to the browser and to code shared with the upstream deployment.

### Seed Metadata

Every cache write also writes `seed-meta:<key>` with `{ fetchedAt, recordCount }`. The health endpoint reads these to determine data freshness and raise staleness alerts.

The five-factor scorecard adds an atomic two-key read pattern: `scorecard:five-factor:v1` is the auditable evidence-plus-result rollback unit, while `scorecard:five-factor:v1:read-model` serves country fields and the compact list without downloading the multi-megabyte canonical value. Both keys switch and retain TTL together; malformed hash fields fall back to the canonical last-good cohort.

**Source files**: `server/_shared/redis.ts`, `server/gateway.ts`, `api/health.js`

---

## 10. Testing

### Unit and Integration

`node:test` runner. Test files in `tests/*.test.{mjs,mts}` cover: server handlers, cache keying, circuit breakers, edge function constraints, data validation, market quote dedup, health checks, panel config guardrails, and variant layer filtering. Run them with `node --import tsx --test`, as CI does.

### DOM tests

`tests/dom/*.test.mts` run under vitest with happy-dom (`npm run test:dom`).

### API and personal provider tests

`api/*.test.mjs` and the personal provider suites in `scripts/*.test.cjs` (`npm run test:api`) test CORS handling, bootstrap, health, feed proxies and the personal provider ingestion paths.

### End-to-End

Playwright specs in `e2e/*.spec.ts` test theme toggling, circuit breaker persistence, keyword spike flows, mobile map interactions, runtime fetch patching, and visual regression via golden screenshot comparison per variant.

### Edge Function Guardrails

`tests/edge-functions.test.mjs` validates that all non-helper `api/*.js` files are self-contained: no `node:` built-in imports, no cross-directory `../server/` or `../src/` imports. The pre-push hook also runs an esbuild bundle check on each endpoint.

### Pre-Push Hook

Runs before every `git push`:

1. TypeScript check (`tsc --noEmit` for src and API)
2. CJS syntax validation
3. Edge function esbuild bundle check
4. Edge function import guardrail test
5. Markdown lint
6. MDX lint (Mintlify compatibility)
7. Version sync check
8. Documentation contracts (`npm run docs:check`) when workflows, the CI/CD table, the docs checker, or the hook change

**Source files**: `tests/`, `e2e/`, `playwright.config.ts`, `.husky/pre-push`

---

## 11. CI/CD

| Workflow | Trigger | Checks |
|----------|---------|--------|
| `typecheck.yml` | PR, push to main | `tsc --noEmit` (TypeScript 7) for src, API, contract-test and e2e tsconfigs |
| `lint-code.yml` | PR, push to main | `biome` job: unicode safety, Biome lint, import boundaries, sebuf API-contract enforcement, bootstrap/live-video/TUI catalog sync checks, `lint:outbound-deadlines` (fails any `fetch()` call with no signal), safe-local-storage and overlay-reload policies, and the VITE secret guard. `markdown` job: markdownlint-cli2 on every push to main and, on PRs, only when markdown, its config, or package.json changes |
| `test.yml` | PR, push to main | Always-on `docs-stats` guardrails (including docs-only changes; it runs `npm run generate:check`, which fails when any committed derived file in `scripts/generate-derived.mjs` is stale). `test:data` runs on five `unit-shards` balanced by measured per-file durations: the `changes` job looks up the newest `data-test-durations-v1-*` cache entry once, every shard restores that exact entry (falling back together to the committed `scripts/shared/data-test-durations.json`), and one shard per run blends its own timings into a new entry. `unit-built-output` runs the suites that read built output. Shards check out full history blobless and restore the `scripts/` and `blog-site/` installed trees from one cache entry. `dom-tests` typechecks and runs `tests/dom/`. `api-tests` runs `npm run test:api` (the `api/` handler and personal provider suites). `variant-smoke` shards and `variant-smoke-full` run the Playwright ci-smoke specs; `consumer-prices` and `resilience-validation-smoke` are conditional gates |
| `proto-check.yml` | PR (proto changes), push to main | Generated code matches committed output at the exact head (`internal-generate`; on internal branches `internal-auto-generate` commits any drift) and at the merge result (`internal-merge-freshness`). The aggregate `proto-freshness` ignores a superseded head's merge verdict. `CODEGEN_INPUT_PATHS` must stay aligned with `PROTO_INPUTS` in `.husky/pre-push` |

The personal fork builds no container images and deploys nothing from CI.

**Source files**: `.github/workflows/`, `.husky/pre-push`. The workflow list is CI-checked against `.github/workflows/*.yml` by `npm run docs:check` — a new workflow file must be added to this table.

---

## 12. Directory Reference

```
.
├── api/                    API entries run by the local API server
│   ├── _*.js               Shared helpers (CORS, relay, store reads)
│   └── <domain>/           Domain endpoints (aviation/, climate/, conflict/, ...)
├── blog-site/              Static blog source (upstream; not built in personal mode)
├── cli/                    `worldmonitor` CLI and the terminal dashboard (cli/src/tui)
├── consumer-prices-core/   Consumer-price collection service (Playwright scrapers, per-country baskets; local process)
├── data/                   Static data (telegram channels, X accounts, OREF threat translations, forecast cohorts)
├── docs/                   Documentation sources; docs/internal/ holds internal notes
├── e2e/                    Playwright E2E specs
├── proto/                  Protobuf service definitions (sebuf framework)
├── public/                 Static assets served as-is
├── scripts/                Collectors, personal server, build and check scripts
│   └── local/              Local API server, embedded store, baseline tooling
├── server/                 Server-side code (bundled into the API entries)
│   ├── _shared/            Store, LLM, caching utilities
│   ├── gateway.ts          Domain gateway factory
│   ├── router.ts           Route matching
│   └── worldmonitor/       Domain handlers (mirrors proto structure)
├── shared/                 Cross-runtime data and helpers (markets, RSS domains, owner id)
├── src/                    Browser SPA (TypeScript)
│   ├── app/                App orchestration managers
│   ├── bootstrap/          Startup/recovery (chunk reload, boot failure, theme)
│   ├── components/         Panel subclasses + map components
│   ├── config/             Variant, panel, layer, market configurations
│   ├── data/               Static JSON datasets (conservation, renewable, happiness)
│   ├── e2e/                Map test harnesses (consumed by Playwright specs)
│   ├── generated/          Proto-generated client/server stubs (DO NOT EDIT)
│   ├── locales/            i18n translation files
│   ├── services/           Business logic organized by domain
│   ├── shared/             Cross-cutting helpers (registries, staleness)
│   ├── styles/             Global CSS (layers, themes, panel styles)
│   ├── types/              TypeScript type definitions
│   ├── utils/              Shared utilities (circuit-breaker, theme, URL state)
│   └── workers/            Web Workers (analysis, ML, vector DB)
└── tests/                  Unit/integration tests (node:test) and tests/dom (vitest)
```

The personal server starts `scripts/personal-providers.cjs` in-process for AIS, OREF and on-demand provider requests. It opens no relay listener. The private adapter route is blocked at ingress and accepts only the server-generated transport token. Batch tasks run only under `personal-collect.mjs`; `personal-collector-tasks.cjs` contains the remaining one-shot producers. Hosted cloud fallback, Telegram/X account feeds, the relay widget generator and downstream WebSocket fanout are removed.
