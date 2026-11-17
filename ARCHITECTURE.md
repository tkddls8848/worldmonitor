# Architecture

## Personal fork runtime

`npm run build:personal` builds the Korean-first dashboard with `VITE_PERSONAL_MODE=true`.
`npm run start:personal` serves static assets and the existing loopback API from one Node.js process.
The ingress requires a personal password, uses private/no-store responses, and disables hosted API fallback and desktop-key relay.
The browser does not initialize Clerk, Convex, checkout, analytics, Sentry, or PWA service-worker caching in this build.
External access uses an HTTPS reverse proxy in front of the loopback listener.

Seeded datasets still use the existing transactional store contracts; personal startup accepts only a loopback Redis REST endpoint.
No storage configuration means those datasets are unavailable, not empty observations.

`WM_PERSONAL_STORE=embedded` starts that endpoint inside the personal server (`scripts/local/embedded-store.mjs`), so no Redis is installed or run.
It keeps data in memory, snapshots it to `.personal/store.ndjson`, and implements only the commands and pinned scripts the collectors and handlers use; any other `EVAL` script is refused.
`npm run collect:personal` runs the existing collectors against it in place of the Railway cron services, and `npm run tui:personal` opens the terminal dashboard (`cli/src/tui`) against the personal server with the owner's password.
`npm run scenario:local` evaluates a supplied exposure snapshot without a queue, Railway, or Redis.
This CLI is separate from the browser's existing asynchronous scenario route.
The deployment workflows removed from this fork are no longer part of its runtime or release procedure.
The sections below document remaining shared and legacy code while migration continues.

> **Inventory ownership**: map layers, services, protos, locales, CI workflows, and freshness sources are defined by their registries. `npm run docs:check` verifies registry and fixed-contract documentation; generated snapshots are refreshed with `npm run docs:stats`.
>
> **Ownership rule**: When deployment topology, API surface, desktop runtime, or bootstrap keys change, this document must be updated in the same PR.

> **Design philosophy**: For the "why" behind architectural decisions, intelligence tradecraft, and algorithmic choices, see [Design Philosophy](docs/architecture.mdx).

World Monitor is a real-time global intelligence dashboard built as a TypeScript single-page application. It aggregates data from dozens of external sources covering geopolitics, military activity, financial markets, cyber threats, climate events, maritime tracking, and aviation into a unified operational picture rendered through an interactive map and a grid of specialized panels.

---

## 1. System Overview

```
┌────────────────────────────────────────────────────────────────┐
│                        Browser / Desktop                        │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌─────────────┐  │
│  │ DeckGLMap│  │ GlobeMap │  │  Panels    │  │  Workers     │  │
│  │(deck.gl) │  │(globe.gl)│  │(Panel base)│  │(ML, analysis)│  │
│  └────┐─────┘  └────┐─────┘  └─────┐─────┘  └─────────────┘  │
│       └──────────────┴─────────────┘                           │
│                         │ fetch /api/*                          │
└─────────────────────────┴───────────────────────────────────┘
                          │
           ┌──────────────┼──────────────┐
           │              │              │
    ┌──────▼──────┐ ┌─────▼─────┐ ┌─────▼──────┐
    │   Vercel    │ │  Railway  │ │   Tauri    │
    │ Edge Funcs  │ │ AIS Relay │ │  Sidecar   │
    │ + Middleware│ │ + Seeds   │ │ (Node.js)  │
    └──────┬──────┘ └─────┬─────┘ └─────┬──────┘
           │              │              │
           └──────────────┼──────────────┘
                          │
                   ┌──────▼──────┐
                   │   Upstash   │
                   │    Redis    │
                   └──────┬──────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
        ┌─────▼───┐ ┌─────▼───┐ ┌────▼────┐
        │ Finnhub │ │  Yahoo  │ │ ACLED   │
        │ OpenSky │ │  GDELT  │ │ UCDP    │
        │ CoinGeck│ │  FRED   │ │ FIRMS   │
        │   ...   │ │   ...   │ │   ...   │
        └─────────┘ └─────────┘ └─────────┘
           885 observed source hosts
```

**Source files**: `package.json`, `vercel.json`

---

## 2. Personal runtime topology

| Process | Role |
|---------|------|
| Node.js personal server | Password-protected static dashboard and loopback API |
| Local data collectors | Fetch enabled providers using the operator's credentials |
| Local persistent data store | Preserve source datasets, timestamps and analysis history |
| Optional HTTPS proxy | Private external access to the same personal server |

Container images, Compose, nginx packaging and supervisor configuration are removed.
The remaining legacy data readers still require the local Redis compatibility adapter;
it is source-data storage, not permission to reconnect a shared hosted cache.
Source-only collector metadata lives in `scripts/railway-services.json` while its local scheduler replacement is developed.

## 3. Frontend Architecture

### Entry and Initialization

`src/main.ts` initializes Sentry error tracking, Vercel analytics, dynamic meta tags, runtime fetch patches (desktop sidecar redirection), theme application, and creates the `App` instance.

`App.init()` runs in 8 phases:

1. **Storage + i18n**: IndexedDB, language detection, locale loading
2. **ML Worker**: ONNX model prep (embeddings, sentiment, summarization)
3. **Sidecar**: Wait for desktop sidecar readiness (desktop only)
4. **Bootstrap**: Two-tier concurrent hydration from `/api/bootstrap` (fast 3s + slow 5s timeouts)
5. **Layout**: PanelLayoutManager renders map and panels
6. **UI**: SignalModal, IntelligenceGapBadge, BreakingNewsBanner, correlation engine
7. **Data**: Parallel `loadAllData()` + viewport-conditional `primeVisiblePanelData()`
8. **Refresh**: Variant-specific polling intervals via `startSmartPollLoop()`

### Component Model

All panels extend the `Panel` base class (109 classes across `src/components`). Panels render via `setContent(html)` (debounced 150ms) and use event delegation on a stable `this.content` element. Panels support resizable row/col spans persisted to localStorage.

### Dual Map System

- **DeckGLMap**: WebGL rendering via deck.gl + maplibre-gl. Supports ScatterplotLayer, GeoJsonLayer, PathLayer, IconLayer, PolygonLayer, ArcLayer, HeatmapLayer, H3HexagonLayer. PMTiles protocol for self-hosted basemap tiles. Supercluster for marker clustering.
- **Loaded news selection**: `MapContainer.onNewsClicked()` caches and forwards the callback to each renderer's `setOnNewsClick()`. The callback receives `Pick<NewsLocationMarker, 'article' | 'title'>`: optional original loaded article `{link, title, source}` and the displayed marker title. Existing markers without article metadata remain valid. The plugin uses this loaded identity to publish its latest interaction with current view context; it does not track popup visibility or fetch more data on selection.
- **GlobeMap**: 3D interactive globe via globe.gl. Single merged `htmlElementsData` array with `_kind` discriminator. Earth texture, atmosphere shader, auto-rotate after idle.

Layer definitions live in `src/config/map-layer-definitions.ts`, each specifying renderer support (flat/globe), premium status, variant filtering, and i18n keys.

### State Management

No external state library. `AppContext` is a central mutable object holding: map references, panel instances, panel/layer settings, all cached data (news, markets, predictions, clusters, intelligence caches), in-flight request tracking, and UI component references. URL state syncs bidirectionally via `src/utils/urlState.ts` (debounced 250ms).

### Web Workers

- **analysis.worker.ts**: News clustering (Jaccard similarity), cross-domain correlation detection
- **ml.worker.ts**: ONNX inference via `@xenova/transformers` (MiniLM-L6 embeddings, sentiment, summarization, NER), in-worker vector store for headline memory
- **vector-db.ts**: IndexedDB-backed vector store for semantic search

### Variant System

Detected by hostname (`tech.worldmonitor.app` → tech, `finance.worldmonitor.app` → finance, etc.) or localStorage on desktop. Controls: default panels, map layers, refresh intervals, theme, UI text. Variant change resets all settings to defaults.

**Source files**: `src/main.ts`, `src/App.ts`, `src/app/`, `src/components/Panel.ts`, `src/components/DeckGLMap.ts`, `src/components/GlobeMap.ts`, `src/config/variant.ts`, `src/workers/`

---

## 4. API Layer

### Edge Functions

The `api/` directory holds two kinds of endpoints, both deployed as Vercel Edge Functions:

- **Domain intelligence gateways** — generated from proto contracts and backed by handlers under `server/worldmonitor/**`. The per-domain thin entry points (`api/<domain>/v<N>/[rpc].ts`) are produced via `createDomainGateway` (`server/gateway.ts`) and esbuild-bundled, so the *deployed* artifact is self-contained even though the source composes server-side modules.
- **Operational endpoints** — hand-written for concerns that don't fit the contract model: auth/session, checkout and customer portal, MCP, bootstrap/health, notifications, cache invalidation, and user workflows (e.g. `api/create-checkout.ts`, `api/customer-portal.ts`, `api/mcp.ts`, `api/user-prefs.ts`).

Compact health separates actionable `problems` from bounded `pending` diagnostics. Both retain the source diagnosis. Pending deadlines also bound the Redis verdict cache lifetime.

Edge functions are bundled per file: each deployed function may not pull in unrelated modules at runtime, a constraint enforced by `tests/edge-functions.test.mjs` and the pre-push esbuild bundle check. Hand-written endpoints that genuinely cannot be proto-defined are listed in `api/api-route-exceptions.json` and enforced by `npm run lint:api-contract`.

### Shared Helpers

| File | Purpose |
|------|---------|
| `_cors.js` | Origin allowlist (worldmonitor.app, Vercel previews, tauri://localhost, localhost) |
| `_rate-limit.js` | Upstash sliding window rate limiting, IP extraction |
| `_api-key.js` | Origin-aware API key validation (desktop requires key, trusted browser exempt) |
| `_relay.js` | Factory for proxying requests to Railway relay service |

### Gateway Factory

`server/gateway.ts` provides `createDomainGateway(routes)` for per-domain Edge Function bundles. Pipeline:

1. Origin check (403 if disallowed)
2. CORS headers
3. OPTIONS preflight
4. API key validation
5. Rate limiting (endpoint-specific, then global fallback)
6. Route matching (static Map lookup, then dynamic `{param}` scan)
7. POST-to-GET compatibility (for stale clients). Unmatched POSTs with a trusted `Content-Length` under 1 MB may be retried as GET when a GET handler exists for the path. The body is all-or-nothing: JSON objects of scalars and scalar arrays become query parameters; object values, nested/non-scalar array members, non-object JSON, malformed JSON, and unread bodies return 400 without applying a partial translation. Empty or whitespace-only bodies still fall through to GET with no extra query parameters. Unknown paths still 404/405. Array expansion remains capped at 200 values per key.
8. Handler execution with error boundary
9. ETag generation (FNV-1a hash) + 304 Not Modified
10. Cache header application

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

The `scorecard/v1` domain is an exception to request-time upstream fetching. Its generated `ScorecardService` country, list, and bloc RPCs read one frozen cohort from `scorecard:five-factor:v1:read-model`, then use `scorecard:five-factor:v1` only as a bounded last-good fallback. The canonical pure adapters and country scorer live under `scripts/scorecard/v1/` for the scripts-root Railway publisher; a checked generator emits Edge-safe copies under the server domain, which owns Redis reads, bloc scoring, and public response conversion. See [Five-factor scorecard v1 architecture](docs/architecture/five-factor-scorecard-v1.md).

The `supply-chain/v1` country-vulnerability, ranking, and chokepoint-dependency RPCs also read a Railway-published cohort instead of fetching upstream data at request time. `seed-supply-vulnerability.mjs` scores each country and builds the chokepoint inverse index in one pass, writes country and chokepoint shards into the inactive Redis slot, and switches the shared cohort pointer only after every shard is valid. The manifest and every shard carry an explicit redistribution-policy version; readers reject an older unmarked cohort until the matching publisher activates a current one. Every direct RPC or MCP response fails closed on provider inputs whose programmatic redistribution is restricted, including requests with freely mintable browser-session tokens. The canonical cohort retains the full attribution-bound evidence for internal audit, but the restricted values do not leave through these routes. The three routes are also `no-store`.

`IntelligenceService.GetCountryCoverage` is the inverse case: it serves an agent surface that must agree, event for event, with what the browser country panel renders. Rather than reimplement the panel's rules server-side, the rules were moved to `shared/` and both sides import them — `country-headline-match.ts` (which country a headline is primarily about), `threat-keyword-classifier.ts` (lane and severity), and `country-timeline-events.ts` (36-hour incident clustering and structured-record precedence). A second copy of any of these is the defect this arrangement exists to prevent, and the ordering between them is load-bearing: cluster first, then filter by country, because a cluster is represented by its earliest member.

Its coverage half fetches Google News at request time through `news/v1`'s shared fetcher rather than standing up a second RSS transport; its structured half composes five existing first-party RPCs. Because several of those upstream handlers catch their own failures and return an empty array, this route cannot learn about an outage from a thrown error — it reads the backing seed key's own hit/miss/error status instead, and reports `failed` rather than `empty` when the cache is unreadable. Producers that genuinely cannot prove they were reached report `unknown`. `degraded` covers only `stale` and `failed`, the states that mean something changed; the per-producer `sources` block, always populated, is where the guarantee lives that an empty event list is never silently healthy.

`MarketService.GetPhysicalDivergenceIndex` is also a read-model RPC. The daily macro seed bundle normalizes SGE SHAU/SHAG benchmarks against the independently timestamped COMEX and FX snapshots, appends bounded per-metal history, and atomically publishes `market:physical-divergence:v1`, its health metadata, activation marker, and transition cooldowns. The Edge handler revalidates the stored contract and re-ages every input clock before it serves the response; the route is `no-store` so independently aging cohorts are never joined through a stale shared cache. MCP reads the same normalized snapshot, and the commodities panel renders the same explicit `ok`, `insufficient_history`, `stale_input`, or `missing_input` states. See [Physical divergence index methodology](docs/methodology/physical-divergence-index.mdx).

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

CI enforces generated code freshness via `.github/workflows/proto-check.yml`: runs `make generate` and fails if output differs from committed files.

**Source files**: `proto/`, `Makefile`, `src/generated/`, `.github/workflows/proto-check.yml`

---

## 6. Data Pipeline

### Bootstrap Hydration

`/api/bootstrap` reads cached keys from Redis in a single batch call. The SPA fetches two tiers concurrently (fast + slow) with separate abort controllers and timeouts. Large or opt-in datasets use a public, CDN-shielded single-key request and are consumed through `ensureHydrated(key)` only when their panel renders. Tier-hydrated data is consumed by panels via `getHydratedData(key)`.

### Seed Scripts

`scripts/seed-*.mjs` fetch upstream data, transform it, and write to Redis via `atomicPublish()` from `scripts/_seed-utils.mjs`. Atomic publish acquires a Redis lock (SET NX), validates data, writes the cache key, writes `seed-meta:<key>` with `{ fetchedAt, recordCount }`, and releases the lock.

`seed-five-factor-scorecard.mjs` runs inside Railway's measured `seed-bundle-resilience` placement. It reads only landed source snapshots, builds the closed scorecard evidence ledger, stages a narrow hash read model, and atomically switches the canonical cohort and read model with one idempotent Lua publication. `seed-meta:scorecard:five-factor` and health coverage remain separate from deployment and production-acceptance evidence.

`seed-supply-vulnerability.mjs` runs once per durable turn in the static-reference Railway bundle after its mirrored inputs. It publishes `supply-chain:vulnerability:cohort:v1` plus two-slot country and chokepoint shards, then writes separate activation and seed-health metadata. The cohort pointer is the read authority; compatibility manifests are not independent publication clocks.

### AIS Relay Seed Loops

The Railway relay service (`scripts/ais-relay.cjs`) runs continuous seed loops:

- Market data (stocks, commodities, crypto, stablecoins, sectors, ETF flows, gulf quotes)
- Aviation (international delays)
- Positive events
- GPSJAM (GPS interference)
- Risk scores (CII)
- UCDP events

These are the primary seeders. Standalone `seed-*.mjs` scripts on Railway cron are secondary/backup.

The market backup bundle also persists 14 days of timestamped hourly Yahoo closes for the news-to-market correlation panel. This series is an on-demand bootstrap key, so it does not increase the default hydration payload.

### Refresh Scheduling

`startSmartPollLoop()` supports: exponential backoff (max 4x), viewport-conditional refresh (only if panel is near viewport), tab-pause (suspend when hidden), and staggered flush on tab visibility (150ms delays).

### Health Monitoring

`api/health.js` checks every bootstrap and standalone key. For each key it reads `seed-meta:<key>` and compares `fetchedAt` against `maxStaleMin`. Cascade groups handle fallback chains (e.g., theater-posture: live, stale, backup). Returns per-key status: OK, STALE, WARN, EMPTY.

**Source files**: `api/bootstrap.js`, `api/health.js`, `scripts/_seed-utils.mjs`, `scripts/seed-*.mjs`, `scripts/ais-relay.cjs`, `src/services/bootstrap.ts`, `src/app/refresh-scheduler.ts`

---

## 7. Desktop Architecture

### Tauri Shell

Tauri 2.x (Rust) manages the app lifecycle, system tray, and IPC commands:

- **Secret management**: Read/write platform keyring (macOS Keychain, Windows Credential Manager, Linux keyring)
- **Sidecar control**: Spawn Node.js process, probe port, inject environment variables
- **Window management**: Three trusted windows (main, settings, live-channels) with Edit menu for macOS clipboard shortcuts

### Node.js Sidecar

`src-tauri/sidecar/local-api-server.mjs` runs on a dynamic port. It dynamically loads Edge Function handler modules from `api/`, injects secrets from the keyring via environment variables, and monkey-patches `globalThis.fetch` to force IPv4 (Node.js tries IPv6 first, but many government APIs have broken IPv6).

### Fetch Patching

`installRuntimeFetchPatch()` in `src/services/runtime.ts` replaces `window.fetch` on the desktop renderer. All `/api/*` requests route to the sidecar with `Authorization: Bearer <token>` (5-min TTL from Tauri IPC). If the sidecar fails, requests fall back to the cloud API.

Seed-owned scorecard RPC paths are always cloud-preferred on desktop. The sidecar does not carry the Railway-published scorecard cohort, so routing these paths locally would create a false unavailable state instead of using the authenticated cloud API.

**Source files**: `src-tauri/src/main.rs`, `src-tauri/sidecar/local-api-server.mjs`, `src/services/runtime.ts`, `src/services/tauri-bridge.ts`

---

## 8. Security Model

### Trust Boundaries

```
Browser ↔ Vercel Edge ↔ Upstream APIs
Desktop ↔ Sidecar ↔ Cloud API / Upstream APIs
```

### Content Security Policy

Three CSP sources that must stay in sync:

1. `index.html` `<meta>` tag (development, Tauri fallback)
2. `vercel.json` HTTP header (production, overrides meta)
3. `src-tauri/tauri.conf.json` (desktop)

### Authentication

API keys are required for non-browser origins. Trusted browser origins (production domains, Vercel preview deployments, localhost) are exempt. Premium RPC paths always require a key.

### Bot Protection

`middleware.ts` filters automated traffic: blocks known crawler user-agents on API and asset paths, allows social preview bots (Twitter, Facebook, LinkedIn, Telegram, Discord) on story and OG endpoints.

### Rate Limiting

Per-IP sliding window via Upstash with per-endpoint overrides for high-traffic paths.

### Desktop Secret Storage

Secrets are stored in the platform keyring (never plaintext), injected into the sidecar via Tauri IPC, and scoped to an allowlist of environment variable keys.

**Source files**: `middleware.ts`, `vercel.json`, `index.html`, `src-tauri/tauri.conf.json`, `api/_api-key.js`, `server/_shared/rate-limit.ts`

---

## 9. Caching Architecture

### Four-Layer Hierarchy

```
Bootstrap seed (Railway writes to Redis on schedule)
    ↓ miss
In-memory cache (per Vercel instance, short TTL)
    ↓ miss
Redis (Upstash, cross-instance, cachedFetchJson coalesces concurrent misses)
    ↓ miss
Upstream API fetch (result cached back to Redis + seed-meta written)
```

### Cache Key Rules

Every RPC handler with shared cache MUST include request-varying parameters in the cache key. Failure to do so causes cross-request data leakage.

### ETag / Conditional Requests

`server/gateway.ts` computes an FNV-1a hash of each response body and returns it as an `ETag`. Clients send `If-None-Match` and receive `304 Not Modified` when content is unchanged.

### CDN Integration

`CDN-Cache-Control` headers give Cloudflare edge (when enabled) longer TTLs than `Cache-Control`, since CF can revalidate via ETag without full payload transfer.

The header only sets the TTL; it does not make a response cacheable. Cloudflare decides eligibility from its cache rules first, and HTML documents on `www` are bypassed by default (see the cache-rule note in §2). Adding `CDN-Cache-Control` to a new document route therefore has to be paired with a zone rule that re-admits it — by extending the surface model in `scripts/cloudflare-cache-rule.mjs` (`CONTENT_CORPUS_PREFIXES` for a new corpus family, `ENTRY_DOCUMENTS` for an exact-path entry document, `EDGE_CACHED_FAMILIES` / `AGENT_TEXT_FILES` otherwise) and re-running `scripts/cloudflare-cache-rule.mjs --apply`; `tests/cloudflare-cache-rule.test.mjs` fails when the two halves disagree.

### Seed Metadata

Every cache write also writes `seed-meta:<key>` with `{ fetchedAt, recordCount }`. The health endpoint reads these to determine data freshness and raise staleness alerts.

The five-factor scorecard adds an atomic two-key read pattern: `scorecard:five-factor:v1` is the auditable evidence-plus-result rollback unit, while `scorecard:five-factor:v1:read-model` serves country fields and the compact list without downloading the multi-megabyte canonical value. Both keys switch and retain TTL together; malformed hash fields fall back to the canonical last-good cohort.

**Source files**: `server/_shared/redis.ts`, `server/gateway.ts`, `api/health.js`

---

## 10. Testing

### Unit and Integration

`node:test` runner. Test files in `tests/*.test.{mjs,mts}` cover: server handlers, cache keying, circuit breakers, edge function constraints, data validation, market quote dedup, health checks, panel config guardrails, and variant layer filtering.

### Sidecar and API Tests

`api/*.test.mjs` and `src-tauri/sidecar/*.test.mjs` test CORS handling, YouTube embed proxying, and local API server behavior.

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
| `lint-code.yml` | PR, push to main | Biome lint + sebuf API-contract enforcement; `lint:outbound-deadlines` fails any `fetch()` call with no signal (`scripts/audit-outbound-calls.mjs --check`); markdownlint-cli2 in a `markdown` job that runs on every push to main and, on PRs, only when markdown, its config, or package.json changes; `doc-anchors` installs a pinned `mint` (up to three attempts, since a registry 404 once failed the install) and exports the authored docs with `mint export --disable-openapi` (preloading `scripts/mint-export-preload.mjs`, which stubs Mint's crash-prone online probe and names pages that fail to render) and checks every anchor against the rendered pages |
| `test.yml` | PR, push to main | Unit/integration suite, always-on docs-stats guardrails (including docs-only changes; docs-stats runs `npm run generate:check`, which fails when any committed derived file in `scripts/generate-derived.mjs` is stale), plus conditional resilience-validation and consumer-prices gates. `test:data` runs on five unit shards balanced by measured per-file durations: the `changes` job looks up the newest `data-test-durations-v1-*` cache entry once, every shard restores that exact entry (falling back together to the committed `scripts/shared/data-test-durations.json` when there is none), and one shard per run, rotating from the shard that saved the restored entry, blends its own timings into a new entry whether the run passed or failed, plus `unit-built-output` for the suites that read built output. Both check out full history blobless (`filter: blob:none`): suites and the health-probe cutover gate read commit history, and the few old blobs they need are fetched on demand. Unit shards also need `scripts/` deps, which suites that load seeder package imports resolve from, and `blog-site/` deps. They restore both installed trees from one `actions/cache` entry keyed on the two manifests, lockfiles and `.npmrc` files plus the vendored `file:` dependency, and install and save them only on a miss; `WM_EXPECT_SCRIPTS_DEPS` fails a shard whose `scripts/` tree is missing, and setup-node's npm cache stays off in that job. `unit-built-output` restores its `blog-site/` installed tree the same way (`built-output-deps-v1-*`, keyed on its install inputs and `vendor/**`), installs and saves it only on a miss; its setup-node npm cache is off as well. The `consumer-prices` job installs Redis with the cached local action and requires its publisher expiry/concurrency regression to run in CI. |
| `proto-check.yml` | PR (proto changes) | Generated code matches committed output at the exact PR head (`internal-generate`; on internal branches `internal-auto-generate` commits any drift) and, in parallel, at the PR merge result (`internal-merge-freshness`). When a generated commit is pushed, the aggregate `proto-freshness` ignores the superseded head's merge verdict and the new commit gets its own run |

Personal builds do not build or publish container images. The Test workflow no longer runs the digest-image or Umami image/PostgreSQL jobs; data-worker source checks remain.

**Source files**: `.github/workflows/`, `.husky/pre-push`. The workflow list is CI-checked against `.github/workflows/*.yml` by `npm run docs:check` — a new workflow file must be added to this table.

---

## 12. Directory Reference

```
.
├── api/                    Vercel Edge Functions (self-contained JS)
│   ├── _*.js               Shared helpers (CORS, rate-limit, API key, relay, Sentry, session)
│   └── <domain>/           Domain endpoints (aviation/, climate/, conflict/, ...)
├── blog-site/              Static blog (built into public/blog/)
├── cli/                    Official `worldmonitor` npm CLI (zero-dep ESM, MCP-first; published via cli-v* tag)
├── consumer-prices-core/   Consumer-price collection service (Playwright scrapers, per-country baskets; local process)
├── convex/                 Convex backend (billing/entitlements, user state, broadcast, forms, intel history)
├── data/                   Static data (telegram channels, X accounts, OREF threat translations, forecast cohorts)
├── docs/                   Mintlify documentation site
├── e2e/                    Playwright E2E specs
├── pro-test/               Standalone Pro QA app (separate package)
├── proto/                  Protobuf service definitions (sebuf framework)
├── public/                 Static assets served as-is (favicons, textures, .well-known agent-skills/MCP, llms.txt)
├── scripts/                Seed scripts, build helpers, relay service
├── server/                 Server-side code (bundled into Edge Functions)
│   ├── _shared/            Redis, rate-limit, LLM, caching utilities
│   ├── gateway.ts          Domain gateway factory
│   ├── router.ts           Route matching
│   └── worldmonitor/       Domain handlers (mirrors proto structure)
├── shared/                 Cross-platform JSON configs (markets, RSS domains)
├── src/                    Browser SPA (TypeScript)
│   ├── app/                App orchestration managers
│   ├── bootstrap/          Startup/recovery (chunk reload, deferred Sentry, SW update)
│   ├── components/         Panel subclasses + map components
│   ├── config/             Variant, panel, layer, market configurations
│   ├── data/               Static JSON datasets (conservation, renewable, happiness)
│   ├── e2e/                Map test harnesses (consumed by Playwright specs)
│   ├── embed/              Embeddable widget loader
│   ├── generated/          Proto-generated client/server stubs (DO NOT EDIT)
│   ├── locales/            i18n translation files
│   ├── services/           Business logic organized by domain
│   ├── shared/             Cross-cutting helpers (premium paths, registries, staleness)
│   ├── shims/              Runtime shims (child-process for sidecar)
│   ├── styles/             Global CSS (layers, themes, panel styles)
│   ├── types/              TypeScript type definitions
│   ├── utils/              Shared utilities (circuit-breaker, theme, URL state)
│   └── workers/            Web Workers (analysis, ML, vector DB)
├── src-tauri/              Tauri desktop shell (Rust)
│   └── sidecar/            Node.js sidecar API server
├── tests/                  Unit/integration tests (node:test)
└── workers/                Cloudflare Workers (edge CORS preflight for api.worldmonitor.app)
```
