# World Monitor (personal fork)

[简体中文](README.zh-CN.md) | [日本語](README.ja-JP.md) | [Русский](README.ru.md)

A single-owner fork of [World Monitor](https://github.com/koala73/worldmonitor), the real-time global intelligence dashboard. It runs on one machine as a personal dashboard, a local API, an embedded data store and the data collectors. Live AIS and siren adapters run inside the personal server; no separate relay is required. It has no accounts, payments, analytics or hosted deployment.

The World Monitor name and wordmark identify the official site at [www.worldmonitor.app](https://www.worldmonitor.app). This fork is not that site. The translated READMEs above still describe the upstream project. The upstream MCP server (`https://worldmonitor.app/mcp`), public API, desktop app and SDKs belong to the official service; this fork runs none of them.

## What it does

- **Curated news feeds** across global and regional categories, clustered and summarized into briefs
- **Dual map engine**: 3D globe (globe.gl) and WebGL flat map (deck.gl) with a shared map-layer catalog
- **[Country Instability Index (CII)](https://www.worldmonitor.app/country-instability-index/)**: CII v14 scores, bands and approximate 24-hour movement for 31 Tier-1 countries
- **Scenario analysis**: supply-chain and chokepoint scenarios on the dashboard, and `npm run scenario:local` for a snapshot file
- **AI briefs and the chat analyst**: the daily brief, country briefs and an analyst chat over the dashboard's data
- **Trip Assessment**: travel risk assessment for a country and dates
- **Intelligence history**: similar-event search and timelines over a local SQLite history
- **Finance, energy, climate, cyber, aviation and maritime panels** fed by the collectors
- **Korean-first UI** with the upstream languages still available

## Run it

Requires Node.js 24 (`.nvmrc`). Full instructions, in Korean, are in [SELF_HOSTING.md](./SELF_HOSTING.md).

```bash
npm ci
npm run build:personal      # strict VITE secret check, API handlers, dashboard build
npm run start:personal      # dashboard + local API + embedded store on http://127.0.0.1:3000
npm run collect:personal    # one collector pass; add `-- --watch 15` to repeat every 15 minutes
npm run tui:personal        # terminal dashboard against the personal server
```

Keys go in `.env.local` (never committed). `.env.example` lists the local runtime settings and common optional source keys.

| Key | Required | Used for |
|-----|----------|----------|
| `WM_PERSONAL_ALLOWED_HOSTS` | Optional | Exact Host values for a trusted HTTPS reverse proxy. The dashboard and API are served without a login. |
| `WM_PERSONAL_STORE=embedded`, `UPSTASH_REDIS_REST_URL=http://127.0.0.1:8079`, `UPSTASH_REDIS_REST_TOKEN` | Yes | The embedded store inside the personal server |
| `OPENROUTER_API_KEY` | For AI features | Summaries, briefs, scenarios, Trip Assessment, the chat analyst and history embeddings |
| `ANTHROPIC_API_KEY` | No | Tried before OpenRouter when set; the chain falls back to OpenRouter |
| Data-source keys (`FRED_API_KEY`, `ACLED_*`, `NASA_FIRMS_API_KEY`, ...) | No | Each enables its collector; a collector without its key fails and the pass continues |

For outside access, put an HTTPS reverse proxy in front of the loopback listener.

## Development

```bash
npm run dev                 # Vite dev server on localhost:3000
npm run typecheck           # browser TypeScript
npm run typecheck:api       # API TypeScript
npm run lint:boundaries     # import boundary rules
npm run test:data           # node:test unit suites (tests/)
npm run test:dom            # DOM suites (tests/dom/, vitest + happy-dom)
npm run test:api            # api/ handler and relay suites
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

## Tech stack

| Category | Technologies |
|----------|-------------|
| **Frontend** | Vanilla TypeScript, Vite, globe.gl + Three.js, deck.gl + MapLibre GL |
| **Server** | Node.js 24 personal server running the `api/` handlers locally |
| **Storage** | Embedded Redis-compatible store, `node:sqlite` for history |
| **AI/ML** | OpenRouter (optional Anthropic, Ollama), Transformers.js in the browser |
| **API contracts** | Protocol Buffers and sebuf HTTP annotations |

## Flight Data

Flight data provided graciously by [Wingbits](https://wingbits.com?utm_source=worldmonitor&utm_medium=referral&utm_campaign=worldmonitor), the most advanced ADS-B flight data solution.

## Data Sources

The collectors fetch public feeds and APIs across geopolitics, finance, energy, climate, aviation, cyber, military, infrastructure and news. `shared/source-attribution-manifest.json` lists every upstream host with its provider, license posture and required credit; `docs/source-attribution.mdx` is the readable credit list.

## License

**AGPL-3.0-only** for the source code. Commercial use is permitted under the AGPL when you comply with its copyleft and source-availability terms.

| Use Case | Allowed? |
|----------|----------|
| Personal / research / educational | Yes, under AGPL-3.0-only |
| Self-hosted instance | Yes, under AGPL-3.0-only |
| Fork and modify | Yes, share source under AGPL-3.0-only when required |
| Commercial use / SaaS | Yes, under AGPL-3.0-only when you comply with AGPL obligations |
| Private-source proprietary use or official branding rights | Separate commercial or trademark permission needed |

See [LICENSE](LICENSE) for the full code license and [docs/license.mdx](docs/license.mdx) for a plain-language summary. Commercial licensing is available as an alternative option for teams that need non-AGPL terms.

Copyright (C) 2026 Elie Habib. All rights reserved.

## Author

**Elie Habib** ([GitHub](https://github.com/koala73)) wrote World Monitor. This fork is maintained by its owner for personal use.

See the [Security Policy](./SECURITY.md) for responsible disclosure guidelines.
