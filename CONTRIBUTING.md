# Contributing to this fork

This is a single-owner personal fork of World Monitor. It runs as a personal dashboard, a local API, an embedded data store and the data collectors on the owner's machine. There are no outside contributors, pull requests or hosted deployments; this guide records how changes are made and verified here.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Development Setup](#development-setup)
- [Preflight](#preflight)
- [Complete one change](#complete-one-change)
- [Delivery](#delivery)
- [Coding Standards](#coding-standards)
- [Working with Sebuf (RPC Framework)](#working-with-sebuf-rpc-framework)
- [Adding Data Sources](#adding-data-sources)
- [Adding RSS Feeds](#adding-rss-feeds)
- [Code of Conduct](#code-of-conduct)

## Architecture Overview

World Monitor is a real-time OSINT dashboard built with **Vanilla TypeScript** (no UI framework), **MapLibre GL + deck.gl** for map rendering, and a Proto-first RPC framework called **Sebuf** for API communication. See [ARCHITECTURE.md](ARCHITECTURE.md) for the personal runtime.

### Key Technologies

| Technology | Purpose |
|---|---|
| **TypeScript** | All code: frontend, API handlers and server modules |
| **Vite** | Build tool and dev server |
| **Sebuf** | Proto-first HTTP RPC framework for typed API contracts |
| **Protobuf / Buf** | Service and message definitions across domains |
| **MapLibre GL** | Base map rendering (tiles, globe mode, camera) |
| **deck.gl** | WebGL overlay layers (scatterplot, geojson, arcs, heatmaps) |
| **d3** | Charts, sparklines, and data visualization |
| **Node.js 24** | Personal server, local API, embedded store and collectors |
| **node:sqlite** | Intelligence history |
| **Playwright** | End-to-end and visual regression testing |

### Variant System

The codebase produces app variants from the same source. The personal build uses `full`.

| Variant | Command | Focus |
|---|---|---|
| `full` | `npm run dev` | Geopolitics, military, conflicts, infrastructure |
| `tech` | `npm run dev:tech` | Startups, AI/ML, cloud, cybersecurity |
| `finance` | `npm run dev:finance` | Markets, trading, central banks, commodities |
| `commodity` | `npm run dev:commodity` | Commodities, mining, energy markets |
| `happy` | `npm run dev:happy` | Positive news and constructive signals |
| `energy` | `npm run dev:energy` | Energy security, chokepoints, oil/gas |

Variants share all code but differ in default panels, map layers, and RSS feeds. Default panels and map layers live in `src/config/panels.ts`; feeds come from `shared/news-catalog.json` via `src/config/feeds.ts`.

### Directory Structure

| Directory | Purpose |
|---|---|
| `src/components/` | UI components |
| `src/services/` | Data fetching modules: sebuf client wrappers, AI, signal analysis |
| `src/config/` | Static data and variant configs (feeds, geo, military, pipelines, ports) |
| `src/generated/` | Auto-generated sebuf client + server stubs (**do not edit by hand**) |
| `src/types/` | TypeScript type definitions |
| `src/locales/` | i18n JSON files |
| `src/workers/` | Web Workers for analysis |
| `server/` | Sebuf handler implementations |
| `api/` | API entries the local server runs (sebuf gateways + legacy endpoints) |
| `proto/` | Protobuf service and message definitions |
| `data/` | Static JSON datasets |
| `docs/` | Documentation + generated OpenAPI specs |
| `e2e/` | Playwright end-to-end tests |
| `scripts/` | Collectors, the personal server, build and check scripts |

## Development Setup

Use Node.js 24 from `.nvmrc`, matching the CI workflows.

```bash
npm ci

# Personal runtime (see SELF_HOSTING.md for .env.local)
npm run build:personal
npm run start:personal
npm run collect:personal
npm run tui:personal

# Development server (full variant, default)
npm run dev

# Type checking and boundaries
npm run typecheck
npm run typecheck:api
npm run lint:boundaries

# Tests
npm run test:related       # data tests the change can reach (POSIX shells)
npm run test:data          # all node:test suites in tests/ (CI runs these on every push)
npm run test:dom           # DOM suites in tests/dom/
npm run test:api           # api/ handler and relay suites
npm run test:e2e:full      # Playwright end-to-end tests (full variant)
```

The dev server runs at `http://localhost:3000` (override the port with `DEV_PORT` in `.env.local`). On Windows, `test:related` cannot spawn its test runs; run the changed files directly with `node --import tsx --test <file>`, as CI does.

### Environment Variables

Copy `.env.example` to `.env.local` and fill in the keys you need. The personal server uses the embedded store settings; AI features need `OPENROUTER_API_KEY`. Without a data source's key its collector fails and its panel shows no data.

## Preflight

```bash
npm run --silent agent:preflight -- --mode review
npm run --silent agent:preflight -- --mode tests
npm run --silent agent:preflight -- --mode repair --issue 123
```

| Mode | Readiness field | What it permits |
|---|---|---|
| `review` | `readiness.sourceReview.ready` | Inspect the committed `checks.source.headOid` through Git objects, including in a dirty checkout. No dependency installation or inventory generation. |
| `tests` | `readiness.tests.ready` | Run tests against the working tree, including intentional edits. Prepares dependencies and inventory in the current checkout. |
| `repair` | `readiness.repair.ready` | Edit with current base ancestry, GitHub access and dependencies. |

Read each blocker's `reason` and `nextAction`. Readiness is neither authority nor a test result. Its branch and pull-request blockers do not apply to this fork: work happens on `main`. Preflight does not link env files or run package lifecycle scripts. A credential available elsewhere does not prove this process can use it; run the checks that need no credentials and report the remaining gate.

## Complete one change

1. Define the user's action and expected result before editing. Include a failure or recovery case when it matters. For a small change, one sentence is enough. For larger work, name acceptance criteria, non-goals, and expected files.
2. Trace only the path needed for that result. Find the interface, service, persistence, workers, and external dependencies involved. Read callers and existing tests. Inspect suitable existing code or services before adding infrastructure.
3. Keep one owner responsible for integration and completion. Delegate only independent work that reduces total effort. Avoid recursive delegation and repeated review exchanges without new evidence.
4. Reproduce the current behavior. Make the smallest complete root-cause change. Reuse existing patterns. Add a test only when existing coverage cannot prove the changed outcome or a material failure mode.
5. Verify the same action and result. Classify failures as product defects, baseline failures, missing prerequisites, or execution restrictions. Investigate repeated failures before changing direction. Measure before and after any performance claim.
6. Commit to `main` and push, with evidence and clear limits in the commit message. Separate blocking defects from optional improvements. Stop when the agreed scope is complete and sufficiently verified.

### Verify the changed path

Use the [code and check map](AGENTS.md#find-the-code-and-its-checks) to select the
required gates. Run focused checks first and heavy checks sequentially. Keep useful
regression coverage. Remove a check only with evidence that its protection is
obsolete, redundant, or ineffective.

For browser work, use the [verification skill](.agents/skills/verify-worldmonitor/SKILL.md)
and the relevant feature recipe. Country Brief is a worked example with an existing
local command and CI coverage. Extend that proof for a changed outcome instead of
creating a second runner.

`npm run dev` serves the app and executes registered versioned RPC handlers through
`sebufApiPlugin` in `vite.config.ts`. This includes the prediction handler. It also
has selected legacy dev middleware. Other legacy API routes depend on their proxy
or middleware configuration and may return source text or an error.

- A deterministic browser test can stub HTTP responses while exercising real application assets, request construction, hydration, rendering, URL state, and reload behavior. State which responses are controlled.
- A local unmocked RPC request exercises the Node dev router and registered handler. It needs the handler's credentials and dependencies to prove useful data. An empty response alone does not prove a provider or cache works.
- Vite does not prove the personal server's ingress (loopback binding, Host checks, no-store headers) or the built handler bundles. Use `npm run build:personal` and `npm run start:personal` when the acceptance criterion requires those paths.
- Worker and freshness changes require producer-to-reader checks and, when needed, source-specific natural-run evidence. A parent bundle success is insufficient. Do not run production seeders or deploy without authorization.

Before handoff, run `git diff --check` and `git status --short`. Report the exercised
path, commands and results, evidence location, and unverified parts. A timeout,
interruption, skipped job, or unmet prerequisite is not a pass. Keep local proof,
pushed, CI, live observation and acceptance separate.

## Delivery

This fork has one owner. Changes go straight to `main`; there is no pull request or review step.

1. Follow [the completion workflow](#complete-one-change). Update docs when behavior or contracts change. Run the required checks for affected code and variants.
2. Commit to `main` with a descriptive message that states the outcome, for example `fix: resolve RSS feed timeout for Al Jazeera`. Keep one feature or fix per commit series.
3. Fetch `origin/main` and reconcile it before pushing. Push to `origin` (`tkddls8848/worldmonitor`). Never push to `upstream`, and never bypass the pre-push gate with `--no-verify`.
4. After pushing, watch CI on the pushed commit and repair relevant failures with a follow-up commit. Green checks do not prove deployment or production acceptance.
5. Do not create a feature branch or pull request unless the owner asks for one. Deployment still requires the owner's explicit authorization.

## Coding Standards

### TypeScript

- Use TypeScript for all new code
- Avoid `any` types — use proper typing or `unknown` with type guards
- Export interfaces/types for public APIs
- Use meaningful variable and function names

### Code Style

- Follow the existing code style in the repository
- Use `const` by default, `let` when reassignment is needed
- Prefer functional patterns (map, filter, reduce) over imperative loops
- Keep functions focused — one responsibility per function
- Add JSDoc comments for exported functions and complex logic

### File Organization

- Static layer/geo data and variant configs go in `src/config/`
- Sebuf handler implementations go in `server/worldmonitor/{domain}/v1/`
- API gateways and legacy endpoints go in `api/`
- UI components (panels, map, modals) go in `src/components/`
- Service modules (data fetching, client wrappers) go in `src/services/`
- Proto definitions go in `proto/worldmonitor/{domain}/v1/`

## Working with Sebuf (RPC Framework)

Sebuf is the project's custom Proto-first HTTP RPC framework — a lightweight alternative to gRPC-Web. All API communication between client and server uses Sebuf.

### How It Works

1. **Proto definitions** in `proto/worldmonitor/{domain}/v1/` define services and messages
2. **Code generation** (`make generate`) produces:
   - TypeScript clients in `src/generated/client/` (e.g., `MarketServiceClient`)
   - Server route factories in `src/generated/server/` (e.g., `createMarketServiceRoutes`)
3. **Handlers** in `server/worldmonitor/{domain}/v1/handler.ts` implement the service interface
4. **Gateway** in `api/[domain]/v1/[rpc].ts` registers all handlers and routes requests
5. **Clients** in `src/services/{domain}/index.ts` wrap the generated client for app use

### Adding a New RPC Method

1. Add the method to the `.proto` service definition
2. Run `make generate` to regenerate client/server stubs
3. Implement the handler method in the domain's `handler.ts`
4. The client stub is auto-generated — use it from `src/services/{domain}/`

Use `make lint` to lint proto files and `make breaking` to check for breaking changes against main.

### Proto Conventions

- **Time fields**: Use `int64` (Unix epoch milliseconds), not `google.protobuf.Timestamp`
- **int64 encoding**: Apply `[(sebuf.http.int64_encoding) = INT64_ENCODING_NUMBER]` on time fields so TypeScript receives `number` instead of `string`
- **HTTP annotations**: Every RPC method needs `option (sebuf.http.config) = { path: "...", method: POST }`

### Proto Codegen Requirements

Run `make install` to install everything automatically, or install individually:

```bash
make install-buf       # Install buf CLI (requires Go)
make install-plugins   # Install sebuf protoc-gen plugins (requires Go)
```

The pinned sebuf version is set by `SEBUF_VERSION` in the `Makefile` (currently **v0.11.1**). All three plugins — `protoc-gen-ts-client`, `protoc-gen-ts-server`, `protoc-gen-openapiv3` — must be installed from the same sebuf release. If you see codegen drift after pulling, rerun `make install-plugins` to resync.

### Derived Files

Product facts, `llms.txt`, the AI search briefing, source attribution, catalogs, locales and legal digests are committed outputs of generators in `scripts/`. Run `npm run generate` after changing anything they read; it runs each generator's `--check` and rewrites only what is stale, in dependency order. `npm run generate:check` reports without writing. The pre-push hook regenerates stale files and stops the push so you can commit them, and the always-on `docs-stats` CI job runs the check. Proto output is separate (`make generate`, below). App translations, internal links, the sitemap and docs page dates are not covered; see the header of `scripts/generate-derived.mjs`.

### Generated Artifacts

`make generate` writes generated files under `src/generated/` and `docs/api/`, plus the seven scorecard Edge mirrors named by `scripts/generate-scorecard-edge-mirrors.mjs`. These files remain committed to the repository and must never be edited by hand. CI regenerates them in `proto-check.yml` and fails on drift. The owner's machine has no `buf` or `make`, so proto changes wait for an environment that has them.

### OpenAPI Output

`make generate` (i.e. `cd proto && buf generate`) produces:

| File | Purpose |
| --- | --- |
| `docs/api/{Service}.openapi.yaml` / `.json` | Per-service specs — referenced individually by Mintlify in `docs/docs.json` |
| `docs/api/worldmonitor.openapi.yaml` | **Unified bundle** spanning every service (sebuf ≥ v0.11.0) — use this for external consumers, API explorers, or anywhere you want a single spec covering all RPCs |

The unified bundle is emitted by a third `protoc-gen-openapiv3` invocation in `proto/buf.gen.yaml` using `bundle=true`, `bundle_only=true`, and `strategy: all`. Regenerate alongside the per-service files; do not edit by hand.

## Adding Data Sources

To add a new data layer to the map:

1. **Define the data source** — identify the API or dataset you want to integrate
2. **Add the proto service** (if the data needs a backend proxy) — define messages and RPC methods in `proto/worldmonitor/{domain}/v1/`
3. **Generate stubs** — run `make generate`
4. **Implement the handler** in `server/worldmonitor/{domain}/v1/`
5. **Register the handler** in `api/[domain]/v1/[rpc].ts` and `vite.config.ts` (for local dev), then rebuild with `npm run build:personal`
6. **Create the service module** in `src/services/{domain}/` wrapping the generated client
7. **Add the layer config** and implement the map renderer following existing layer patterns
8. **Add to layer toggles** — make it toggleable in the UI
9. **Add the collector** to `DEFAULT_COLLECTORS` in `scripts/personal-collect.mjs` if it should run every pass

For endpoints that deal with non-JSON payloads (XML feeds, binary data, HTML embeds), you can add a standalone endpoint in `api/` instead of Sebuf. For anything returning JSON, prefer Sebuf — the typed contracts are always worth it.

### Data Source Requirements

- Must be freely accessible (no paid-only APIs for core functionality)
- Must have a permissive license or be public government data
- Should update at least daily for real-time relevance
- Must include geographic coordinates or be geo-locatable

### Source attribution ledger

Any new outbound host that appears in a URL literal under `scripts/`, `server/`, `api/`, or `src/` is discovered by `scripts/source-attribution.mjs` and needs a curated row in `shared/source-attribution-manifest.json`. This catches contributions that only add data — a feed URL — with no obvious link to the ledger:

```bash
npm run sources:check     # fails with "missing manifest entry for <host>"
npm run sources:generate  # writes the row and regenerates docs/source-attribution.mdx
```

Give the host a display name only by adding it to `PROVIDER_OVERRIDES` in that script and bumping `PROVIDER_IDENTITY_REVIEW` to the recomputed digest; provider identities are hash-pinned so renaming one stays an explicit review event. Because the script lives inside the roots it scans, a URL you cite in one of its own strings counts as a discovered source — fine when that host is already registered (the licence links on existing rows), but citing an unregistered host invents a provider row for it.

Two ordering rules follow from the manifest being a fixpoint of the source tree: a row cannot be added ahead of the code that introduces its host, and a rebase that lands alongside another attribution change should re-run `sources:generate` rather than hand-merge the generated files.

### Country boundary overrides

Country outlines are loaded from `public/data/countries.geojson`. Optional higher-resolution overrides (sourced from [Natural Earth](https://www.naturalearthdata.com/)) are served from R2 CDN. The app loads overrides after the main file and replaces geometry for any country whose `ISO3166-1-Alpha-2` (or `ISO_A2`) matches. To refresh boundary overrides from Natural Earth, run:

```bash
node scripts/fetch-country-boundary-overrides.mjs
rclone copy public/data/country-boundary-overrides.geojson r2:worldmonitor-maps/
```

## Adding RSS Feeds

To add new RSS feeds:

1. Verify the feed is reliable and actively maintained
2. Assign a **source tier** (1-4) based on editorial reliability
3. Flag any **state affiliation** or **propaganda risk**
4. Categorize the feed (geopolitics, defense, energy, tech, etc.)
5. Test that the feed parses correctly through the RSS proxy

## Code of Conduct

The upstream project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
