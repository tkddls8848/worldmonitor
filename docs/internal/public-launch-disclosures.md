# Disclosures for a future public launch

Status: internal. Recorded 2026-11-19 at the end of the Phase 1 reduction
(owner Ruling 15). Nothing here is published.

This fork runs as a single-owner personal dashboard: one local API, an
embedded store and the collectors, all on the owner's machine. It has no
accounts, no payments, no analytics and no error reporting, so it needs no
privacy policy today. The public privacy pages (`docs/privacy.mdx`,
`docs/zh/privacy.mdx`), their PDF (`public/legal/privacy.pdf`), their nav
entries and the tests that guarded them were deleted together with this
document's commit.

If the dashboard is ever offered to other people again, a privacy policy has
to be written before launch. This document lists what that policy would have
to cover, based on the code as it stands at the end of Phase 1, and the
requirements the deleted pages and their guard tests enforced.

## 1. Requirements carried over from the deleted pages

The deleted policy (last updated 2 November 2026) and its guard tests
(`privacy-collector-disclosure`, `dpa-contract`, `terms-eula-coherence`,
`legal-version`, `legal-footer-links`, `legal-pdf-freshness`) enforced these
rules. A new policy should meet them again.

1. **One subprocessor table, in the privacy policy.** Every provider that
   receives personal data gets a row with three columns: provider, purpose,
   and the personal data it processes. The Data Processing Addendum points at
   that table instead of copying it.
2. **Every live integration has a row.** The collector-disclosure guard
   failed when code called a vendor that the table did not name, for example
   a self-hosted analytics collector or a hosting platform. A new launch needs
   the same kind of check: scan the runtime code for vendor hosts and fail on
   any vendor without a row.
3. **Self-hosted collectors are named too.** The old table named the
   self-hosted Umami collector even though no vendor received its data, so a
   reader could match every request in a network log to a row.
4. **AI prompts are disclosed.** The text of a query and the context sent with
   it go to the model provider. The policy told users not to put sensitive
   personal data into prompts.
5. **Alert destinations are not subprocessors.** Telegram, Slack, Discord,
   webhooks, email and browser push received alerts because the user chose
   them. The policy said which identifiers were stored for each channel and
   that disconnecting a channel deleted them.
6. **Cookies and local storage are listed by purpose**: essential,
   preferences, analytics and the acquisition cookie (`wm-acq`, 90 days,
   first-party), each with what it records.
7. **Rights and contact.** Access, correction, export and deletion under
   GDPR and CCPA/CPRA, a self-service account deletion path, a contact
   address, and the right to complain to a data protection authority.
8. **Retention, international transfers, children and changes** each had a
   short section. Transfers relied on standard contractual clauses.
9. **One version for the accepted set.** The EULA, the Terms and the privacy
   policy carried one "Last updated" date, stored as `TERMS_VERSION` in
   `shared/legal.ts`, with a body digest per page so an edit without a version
   bump failed `tests/legal-version.test.mts`. Each page had a PDF built from
   the same version (`scripts/build-legal-pdfs.mjs`).
10. **The Chinese translation** (`docs/zh/privacy.mdx`) mirrored the English
    page, which stayed the binding version.
11. **New subprocessors** required 30 days' notice, as set out in section 8
    of the DPA.

The DPA (`docs/dpa.mdx`), the Terms and the EULA still link to `/privacy`.
They are public documents and are reviewed in Phase 2. Before a launch they
must point at the new policy.

## 2. Data recipients in the personal setup

These services receive data when the owner runs the dashboard and the
collectors. For a public launch each one that can receive user data becomes a
subprocessor row.

| Recipient | When it is called | What it receives | Configured by |
|---|---|---|---|
| OpenRouter | AI summaries, the daily brief, scenario analysis, Trip Assessment, the chat analyst, forecasts, and history embeddings (`openai/text-embedding-3-small`) | The prompt text and the context sent with it, such as headlines, country data and the user's chat question | `OPENROUTER_API_KEY` (in use) |
| Anthropic (optional) | The same LLM calls, tried before OpenRouter when a key is set; the chain falls back to OpenRouter when it is missing or fails | The prompt text and its context | `ANTHROPIC_API_KEY` |
| Ollama (optional) | A self-hosted or configured model endpoint in the LLM chain | The prompt text and its context | `OLLAMA_API_URL`, `OLLAMA_API_KEY` |
| Exa, Brave Search and SerpApi (optional) | Stock news search in the market service, and price lookups in two collectors | Search terms built from tickers, company names and products | `EXA_API_KEYS`, `BRAVE_API_KEYS`, `SERPAPI_API_KEYS` |
| Google Fact Check Tools (optional) | Claim lookups for fact checks | Search text built from headlines | `GOOGLE_FACT_CHECK_API_KEY` |
| Telegram (MTProto, optional) | The Telegram OSINT collector reads public channels | The owner's Telegram session; no user data | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION` |
| Axiom (optional, off) | Usage and LLM-call telemetry in `server/_shared/usage.ts` and `scripts/lib/llm-telemetry.cjs` | Request metadata, LLM model, token counts and latency. Nothing is sent unless both variables are set; the personal setup sets neither | `USAGE_TELEMETRY=1` and `AXIOM_API_TOKEN` |
| Upstream data sources | Collectors and on-demand API handlers fetch public feeds and APIs | Plain HTTP requests with a `User-Agent`; no user data. Some sources need an API key | Section 3 |

The embedded store (`scripts/personal-server.mjs`, port 8079, snapshot
`.personal/store.ndjson`) and the intelligence history database
(`node:sqlite`) stay on the owner's machine. They are not recipients.

For a public launch, add rows for whatever hosting, CDN, logging and email
delivery the launch uses. The personal setup has none.

## 3. What the collectors fetch

The collectors (`scripts/seed-*.mjs`, `scripts/seed-bundle-*.mjs`,
`scripts/ais-relay.cjs`, `consumer-prices-core/`) and the API handlers fetch
public data: news feeds, conflict and disaster data, markets, energy, shipping
and aviation positions, climate and cyber threat feeds, and official
statistics. They send no user data upstream. The request carries a
`User-Agent` and, for some sources, the owner's API key.

The authoritative list of upstream hosts is generated from the code:

- `shared/source-attribution-manifest.json`: every host found by a lexical
  scan of `scripts/`, `server/`, `api/` and `src/`, with its provider, license
  posture and required credit. At the end of Phase 1 it held 1,081 host
  entries: 122 reviewed, 761 in terms review and 198 excluded (local, test or
  transport hosts).
- `docs/source-attribution.mdx`: the generated, readable credit list.
- `npm run sources:check` fails when the code calls a host that the manifest
  does not list.

For a public launch: finish the terms review of the 761 hosts, confirm that
redistribution is allowed for each source shown to users, and publish the
credit list.

## 4. What the browser stores locally

The dashboard keeps all its state in the browser. Nothing is synced to a
server account.

| Storage | Name | Contents |
|---|---|---|
| `localStorage` | `worldmonitor-*` and `wm-*` keys | Panel layout, enabled layers, map view, theme, language, saved filters, watchlists, onboarding and dismissal flags, and the persistent-cache fallback (`worldmonitor-persistent-cache:*`) |
| IndexedDB | `worldmonitor_persistent_cache` | Cached API responses, so the dashboard can draw before the network answers |
| IndexedDB | `worldmonitor_db` | Keyword baselines for spike detection (counts and rolling averages) |
| IndexedDB | the vector database in `src/workers/vector-db.ts` | Headline embeddings for in-browser similarity search |
| Cookie | dismissal flags from `src/utils/cross-domain-storage.ts` | Set only on `*.worldmonitor.app` hosts, so it is not used locally |

The personal server uses HTTP Basic authentication (user `owner`). The
browser keeps those credentials for the session; the dashboard does not
store them.

For a public launch, list each of these by purpose (essential, preferences,
analytics) as rule 6 above requires.

## 5. Telemetry and vendors removed in Phase 1

Removed from code, so nothing is sent to them. If any comes back, it needs a
subprocessor row again.

| Vendor or feature | Former purpose | Removed in |
|---|---|---|
| Clerk | Sign-in and accounts | Task 10 |
| Convex | Accounts, entitlements, API keys, alert rules, preferences and survey answers | Task 10 (`convex/` deleted) |
| Dodo Payments | Checkout and subscriptions | Tasks 8 and 9 |
| Resend | Transactional and digest email | Tasks 5 and 8 |
| Telegram, Slack, Discord, webhook and web push delivery | Alert and digest delivery | Tasks 5 and 8 (the Telegram OSINT collector stays; see section 2) |
| Sentry | Error and crash reports | Task 10 |
| Vercel Web Analytics | Traffic analytics | Task 10 |
| Umami (self-hosted at `abacus.worldmonitor.app`) | Product analytics | Task 10 |
| DebugBear | Real-user performance monitoring | Task 10 |
| Vercel, Railway and Cloudflare hosting | Edge APIs, workers, CDN and Turnstile | Tasks 4, 6 and 8; the personal server replaces them |
| Mintlify | Hosted documentation | Not used locally; `docs/` remains as source files |
| Upstash (cloud) | Rate limits and cache | Replaced by the embedded local store |
| The `wm-acq` acquisition cookie | Checkout channel attribution | Task 9 removed checkout, so nothing sets it; `shared/acquisition-source.ts` remains with no runtime caller |

Some comments and generated files still name these vendors, such as Sentry
issue numbers in code comments. They do not send data. The Axiom telemetry
code is still present but off (section 2).
