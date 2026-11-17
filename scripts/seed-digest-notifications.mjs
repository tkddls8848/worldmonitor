#!/usr/bin/env node
/**
 * Daily brief composer for the personal build. Each collect pass:
 *   1. Scans the story accumulator for watchlist ticker stories and enqueues
 *      them on wm:events:queue (capped; nothing consumes it here).
 *   2. Composes the owner's brief with the default in-app brief rule:
 *      ZRANGEBYSCORE digest:accumulator:v1:${variant}:${lang} for the
 *      window, HMGET story:track:v1:${hash}, derives phase, filters
 *      fading/non-matching severity, dedups, synthesises the lead and writes
 *      brief:${PERSONAL_OWNER_ID}:${issueSlot} plus brief:latest:${PERSONAL_OWNER_ID}.
 *
 * Nothing is delivered: the mail, Telegram, Slack, Discord, Teams and webhook
 * channels and the Convex user, rule and channel lookups are gone.
 */
import { createRequire } from 'node:module';
import { loadEnvFile } from './_env-file.mjs';

loadEnvFile(import.meta.url);

const require = createRequire(import.meta.url);
const DIGEST_DIPLOMACY_DATA = require('../shared/diplomacy-keywords.json');
// Watchlist story alerts (#4922 U3): stocks.json feeds the ticker
// dictionary; loaded via the createRequire JSON pattern this file already
// uses for diplomacy-keywords.json (avoids the two-sided `with {type:
// 'json'}` bundler/node trap — see vercel-edge-gotchas).
const WATCHLIST_STOCKS_DATA = require('../shared/stocks.json');
const { callLLM } = require('./lib/llm-chain.cjs');
const { withAiRoutingPolicy } = require('./lib/ai-routing-policy.cjs');
const { flushPendingLlmEvents } = require('./lib/llm-telemetry.cjs');
import { readRawJsonFromUpstash, redisPipeline } from '../api/_upstash-json.js';
import { classifyFeelGood } from '../server/_shared/feelgood-classifier.js';
import { classifyEphemeralLiveCoverage } from '../shared/ephemeral-live-classifier.js';
import {
  deriveNotificationStoryPhase,
} from '../shared/story-phase.js';
import { shouldDropOpinionTrack } from './lib/digest-opinion-track-filter.mjs';
import {
  briefCandidateDue,
  buildBriefOnlyRules,
  composeBriefFromDigestStories,
  deriveThreadsFromOrderedStories,
  digestStoryToSynthesisShape,
  extractInsights,
  groupEligibleRulesByUser,
  shouldExitNonZero as shouldExitOnBriefFailures,
} from './lib/brief-compose.mjs';
import {
  applyDigestScoreFloor,
  createDigestMemo,
  getDigestScoreMin,
  pickWinningCandidateWithPool,
  readTimeAgeCutoffMs,
  runSynthesisWithFallback,
  shouldDropTrackByAge,
} from './lib/digest-orchestration-helpers.mjs';
import { issueSlotInTz } from '../shared/brief-filter.js';
import {
  MIN_CORROBORATING_PUBLISHERS,
  countPublisherFamilies,
} from '../shared/publisher-families.js';
import {
  enrichBriefEnvelopeWithLLM,
  generateDigestProsePublic,
  leadGroundsAgainstStory,
} from './lib/brief-llm.mjs';
import {
  resolveNonDueSynthesisReuse,
  DEFAULT_NONDUE_SYNTHESIS_REUSE_MIN,
} from './lib/brief-synthesis-reuse.mjs';
import { assertBriefEnvelope } from '../server/_shared/brief-render.js';
import {
  deduplicateStories,
  groupTopicsPostDedup,
  readOrchestratorConfig,
} from './lib/brief-dedup.mjs';
import { stripSourceSuffix } from './lib/brief-dedup-jaccard.mjs';
import { writeReplayLog } from './lib/brief-dedup-replay-log.mjs';
import { readStoryTracksChunked } from './lib/story-track-batch-reader.mjs';
import {
  attachDigestCorroboration,
  readStoryCorroboration,
  storyCorroborationField,
} from './lib/digest-corroboration.mjs';
import { buildTickerDictionary } from '../shared/ticker-extract.js';
import { scanAndEnqueueWatchlistStoryEvents as scanWatchlistStoryEvents } from './lib/watchlist-story-scan.mjs';
import { isMainModule } from './lib/main-module.mjs';
import { PERSONAL_OWNER_ID } from '../shared/personal-owner.js';

const EPHEMERAL_LIVE_LOG_TITLE_SAMPLE_LIMIT = 5;
const EPHEMERAL_LIVE_LOG_TITLE_MAX_CHARS = 160;

function compactDroppedEphemeralLiveTitle(title) {
  const compact = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!compact) return '<missing title>';
  return compact.length > EPHEMERAL_LIVE_LOG_TITLE_MAX_CHARS
    ? `${compact.slice(0, EPHEMERAL_LIVE_LOG_TITLE_MAX_CHARS - 3)}...`
    : compact;
}

// ── Config ────────────────────────────────────────────────────────────────────

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';
const ANALYST_RELAY_SECRET = process.env.RELAY_SHARED_SECRET ?? '';
const DIGEST_LAST_RUN_KEY = 'digest:last-run';
const DIGEST_LAST_RUN_META_KEY = 'seed-meta:digest:last-run';
const DIGEST_LAST_RUN_TTL_SECONDS = 7 * 24 * 60 * 60;
let digestRunStartedAtMs = null;

const DIGEST_MAX_ITEMS = 30;
const DIGEST_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h default lookback on first send

// ── Brief composer (consolidation of the retired seed-brief-composer) ──────

const WORLDMONITOR_PUBLIC_BASE_URL =
  process.env.WORLDMONITOR_PUBLIC_BASE_URL ?? 'https://worldmonitor.app';
const BRIEF_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
// Brief story window: derived per-rule from the rule's lastSentAt via
// digestWindowStartMs, identical to the send-loop window. The previous
// fixed-24h constant decoupled the canonical brief lead from the
// stories the email/Slack body actually shipped, reintroducing the
// cross-surface divergence the canonical-brain refactor is designed to
// eliminate (especially severe for weekly users — 7d email body vs 24h
// lead).
const INSIGHTS_KEY = 'news:insights:v1';

// Operator kill switch — used to intentionally silence brief compose.
// The URL signing secret is no longer required: the signed magazine URL only
// fed the removed delivery channels.
const BRIEF_COMPOSE_ENABLED = process.env.BRIEF_COMPOSE_ENABLED !== '0';

// Phase 3b LLM enrichment. Kept separate from AI_DIGEST_ENABLED so
// the email-digest AI summary and the brief editorial prose can be
// toggled independently (e.g. kill the brief LLM without silencing
// the email's AI summary during a provider outage).
const BRIEF_LLM_ENABLED = process.env.BRIEF_LLM_ENABLED !== '0';
// #4917: freshness budget for reusing the prior envelope's prose on
// non-due compose ticks (minutes; 0 disables reuse and restores the
// pre-#4917 synthesize-every-tick behavior). Due ticks always
// synthesize fresh regardless of this setting.
const NONDUE_SYNTHESIS_REUSE_MS = (() => {
  const raw = Number.parseInt(process.env.DIGEST_NONDUE_SYNTHESIS_REUSE_MIN ?? '', 10);
  const minutes = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_NONDUE_SYNTHESIS_REUSE_MIN;
  return minutes * 60_000;
})();

// Wall-clock budget for the default-brief pass (#9758). The pass stops
// starting new users at this budget; with one owner it bounds a single compose.
const BRIEF_ONLY_COMPOSE_BUDGET_MS = (() => {
  const raw = Number.parseInt(process.env.DIGEST_BRIEF_ONLY_BUDGET_MIN ?? '', 10);
  return (Number.isFinite(raw) && raw > 0 ? raw : 8) * 60_000;
})();

// Phase 3c — analyst-backed whyMatters enrichment via an internal Vercel
// edge endpoint. When the endpoint is reachable + returns a string, it
// takes priority over the direct-Gemini path. On any failure the cron
// falls through to its existing Gemini cache+LLM chain. Env override
// lets local dev point at a preview deployment or `localhost:3000`.
const BRIEF_WHY_MATTERS_ENDPOINT_URL =
  process.env.BRIEF_WHY_MATTERS_ENDPOINT_URL ??
  `${WORLDMONITOR_PUBLIC_BASE_URL}/api/internal/brief-why-matters`;

/**
 * Lowercase + collapse whitespace to mirror extractor-side gate in
 * server/worldmonitor/news/v1/list-feed-digest.ts
 * (normalizeForDescriptionEquality). Duplicated (not imported) because
 * that module is .ts on a different loader path; a shared .mjs helper
 * would be a cleaner home if more surfaces adopt this check.
 */
function normalizeForDescriptionEquality(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * POST one story to the analyst whyMatters endpoint. Returns the
 * string on success, null on any failure (auth, non-200, parse error,
 * timeout, missing value). The cron's `generateWhyMatters` is
 * responsible for falling through to the direct-Gemini path on null.
 *
 * Ground-truth signal: logs `source` (cache|analyst|gemini) and
 * `producedBy` (analyst|gemini|null) at the call site so the cron's
 * log stream has a forensic trail of which path actually produced each
 * story's whyMatters — needed for shadow-diff review and for the
 * "stop writing v2" decision once analyst coverage is proven.
 * (See feedback_gate_on_ground_truth_not_configured_state.md.)
 */
async function callAnalystWhyMatters(story) {
  if (!ANALYST_RELAY_SECRET) return null;
  // Forward a trimmed story payload so the endpoint only sees the
  // fields it validates. `description` is NEW for prompt-v2 — when
  // upstream has a real one (falls back to headline via
  // shared/brief-filter.js:134), it gives the LLM a grounded sentence
  // beyond the headline. Skip when it equals the headline (no signal).
  const payload = {
    headline: story.headline ?? '',
    source: story.source ?? '',
    threatLevel: story.threatLevel ?? '',
    category: story.category ?? '',
    country: story.country ?? '',
  };
  if (
    typeof story.description === 'string' &&
    story.description.length > 0 &&
    // Normalize-equality (case + whitespace) mirrors the extractor-side gate
    // in list-feed-digest.ts (normalizeForDescriptionEquality) so a feed
    // whose description only differs from the headline by casing/spacing
    // doesn't leak as "grounding" content here.
    normalizeForDescriptionEquality(story.description) !==
      normalizeForDescriptionEquality(story.headline ?? '')
  ) {
    payload.description = story.description;
  }
  try {
    const resp = await fetch(BRIEF_WHY_MATTERS_ENDPOINT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ANALYST_RELAY_SECRET}`,
        'Content-Type': 'application/json',
        // Explicit UA — Node undici's default is short/empty enough to
        // trip middleware.ts's "No user-agent or suspiciously short"
        // 403 path. Defense-in-depth alongside the PUBLIC_API_PATHS
        // allowlist. Distinct from ops curl / UptimeRobot so log grep
        // disambiguates cron traffic from operator traffic.
        'User-Agent': 'worldmonitor-digest-notifications/1.0',
        Accept: 'application/json',
      },
      body: JSON.stringify({ story: payload }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.warn(`[digest] brief-why-matters endpoint HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    if (!data || typeof data.whyMatters !== 'string') return null;
    // Emit the ground-truth provenance at the call site. `source` tells
    // us cache vs. live; `producedBy` tells us which LLM wrote the
    // string (or the cached value's original producer on cache hits).
    const src = typeof data.source === 'string' ? data.source : 'unknown';
    const producedBy = typeof data.producedBy === 'string' ? data.producedBy : 'unknown';
    console.log(
      `[brief-llm] whyMatters source=${src} producedBy=${producedBy} hash=${data.hash ?? 'n/a'}`,
    );
    return data.whyMatters;
  } catch (err) {
    console.warn(
      `[digest] brief-why-matters endpoint call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// Personalised digest prose honours the user's AI routing policy
// (docs/internal/ai-routing-policy.md). The policy lived in Convex; the
// personal build has one owner who picks providers by the API keys they set,
// so the owner's policy is the default (no provider restriction).
const resolveAiRoutingPolicy = async () => ({ kind: 'default' });

// Dependencies injected into brief-llm.mjs. Defined near the top so
// the upstashRest helper below is in scope when this closure runs
// inside composeAndStoreBriefForUser().
const briefLlmDeps = {
  callLLM,
  callAnalystWhyMatters,
  async cacheGet(key) {
    const raw = await upstashRest('GET', key);
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try { return JSON.parse(raw); } catch { return null; }
  },
  async cacheSet(key, value, ttlSec) {
    await upstashRest('SETEX', key, String(ttlSec), JSON.stringify(value));
  },
};

// ── Redis helpers ──────────────────────────────────────────────────────────────

/**
 * #4917: read the user's most recent stored brief envelope via the
 * latest-pointer, plus the time its prose was synthesized (carried on the
 * pointer; absent on pointers written before #9758). Returns null on any
 * miss/parse failure — callers treat null as "no prior envelope" and pay a
 * fresh synthesis.
 *
 * @returns {Promise<{ envelope: object; synthesizedAt: number|undefined } | null>}
 */
async function fetchLatestBriefEnvelope(userId) {
  try {
    const rawPtr = await upstashRest('GET', `brief:latest:${userId}`);
    if (typeof rawPtr !== 'string' || rawPtr.length === 0) return null;
    const ptr = JSON.parse(rawPtr);
    if (!ptr || typeof ptr.issueSlot !== 'string' || ptr.issueSlot.length === 0) return null;
    const rawEnv = await upstashRest('GET', `brief:${userId}:${ptr.issueSlot}`);
    if (typeof rawEnv !== 'string' || rawEnv.length === 0) return null;
    return {
      envelope: JSON.parse(rawEnv),
      synthesizedAt: Number.isFinite(ptr.synthesizedAt) ? ptr.synthesizedAt : undefined,
    };
  } catch {
    return null;
  }
}

async function upstashRest(...args) {
  const res = await fetch(`${UPSTASH_URL}/${args.map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'User-Agent': 'worldmonitor-digest/1.0',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    console.warn(`[digest] Upstash error ${res.status} for command ${args[0]}`);
    return null;
  }
  const json = await res.json();
  return json.result;
}

async function upstashPipeline(commands) {
  if (commands.length === 0) return [];
  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'worldmonitor-digest/1.0',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    console.warn(`[digest] pipeline error ${res.status}`);
    return [];
  }
  return res.json();
}

function compactDigestLastRunReason(reason) {
  return String(reason ?? 'unknown').replace(/\s+/g, ' ').trim().slice(0, 240);
}

async function writeDigestLastRunMeta({
  startedAtMs,
  finishedAtMs = Date.now(),
  status = 'ok',
  sentCount = 0,
  errorReason = null,
}) {
  const run = {
    fetchedAt: finishedAtMs,
    recordCount: 1,
    status,
    sentCount,
    startedAt: startedAtMs,
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
  };
  if (errorReason) run.errorReason = compactDigestLastRunReason(errorReason);

  try {
    const result = await upstashPipeline([
      ['SET', DIGEST_LAST_RUN_KEY, JSON.stringify(run), 'EX', String(DIGEST_LAST_RUN_TTL_SECONDS)],
      ['SET', DIGEST_LAST_RUN_META_KEY, JSON.stringify(run), 'EX', String(DIGEST_LAST_RUN_TTL_SECONDS)],
    ]);
    const ok = Array.isArray(result)
      && result.length === 2
      && result.every((cell) => cell && typeof cell === 'object' && !('error' in cell));
    if (!ok) {
      console.warn('[digest] last-run health write did not confirm both keys');
    }
    return ok;
  } catch (err) {
    console.warn(`[digest] last-run health write failed: ${err?.message ?? err}`);
    return false;
  }
}

// ── Schedule helpers ──────────────────────────────────────────────────────────

function toLocalHour(nowMs, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(nowMs));
    const hourPart = parts.find((p) => p.type === 'hour');
    return hourPart ? parseInt(hourPart.value, 10) : -1;
  } catch {
    return -1;
  }
}

/**
 * Read digest:last-sent:v1:{userId}:{variant} from Upstash. Returns
 * null on miss / parse error / network hiccup so the caller can treat
 * "first send" and "transient lookup failure" the same way (both fall
 * through to isDue's `lastSentAt === null` branch). Extracted so the
 * compose-flow's per-rule annotation pass and the send loop can share
 * one source of truth — Codex Round-3 High #1 + Round-4 fixes.
 *
 * @param {{ userId: string; variant?: string }} rule
 * @returns {Promise<number | null>}
 */
async function getLastSentAt(rule) {
  if (!rule?.userId || !rule.variant) return null;
  const key = `digest:last-sent:v1:${rule.userId}:${rule.variant}`;
  try {
    const raw = await upstashRest('GET', key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed.sentAt === 'number' ? parsed.sentAt : null;
  } catch {
    return null;
  }
}

/**
 * Build the synthesis context (profile, greeting) for the canonical
 * synthesis call. greeting is the time-of-day-appropriate opener. The
 * user-preferences profile came from Convex; the personal build has no
 * preferences store, so profile is always null — the same
 * non-personalised synthesis a failed prefs lookup produced.
 *
 * @param {{ userId: string; variant?: string; digestTimezone?: string }} rule
 * @param {number} nowMs
 * @returns {Promise<{ profile: string | null; greeting: string | null }>}
 */
async function buildSynthesisCtx(rule, nowMs) {
  if (!rule?.userId) return { profile: null, greeting: null };
  const profile = null;
  const tz = rule.digestTimezone ?? 'UTC';
  const localHour = toLocalHour(nowMs, tz);
  const greeting = localHour >= 5 && localHour < 12 ? 'Good morning'
    : localHour >= 12 && localHour < 17 ? 'Good afternoon'
    : localHour >= 17 && localHour < 22 ? 'Good evening'
    : 'Good evening';
  return { profile, greeting };
}

function isDue(rule, lastSentAt) {
  const nowMs = Date.now();
  const tz = rule.digestTimezone ?? 'UTC';
  const primaryHour = rule.digestHour ?? 8;
  const localHour = toLocalHour(nowMs, tz);
  const hourMatches = rule.digestMode === 'twice_daily'
    ? localHour === primaryHour || localHour === (primaryHour + 12) % 24
    : localHour === primaryHour;
  if (!hourMatches) return false;
  if (lastSentAt === null) return true;
  const minIntervalMs =
    rule.digestMode === 'daily'        ? 23 * 3600000
    : rule.digestMode === 'twice_daily' ? 11 * 3600000
    : rule.digestMode === 'weekly'      ? 6.5 * 24 * 3600000
    : 0;
  return (nowMs - lastSentAt) >= minIntervalMs;
}

// ── Story helpers ─────────────────────────────────────────────────────────────

function flatArrayToObject(flat) {
  const obj = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    obj[flat[i]] = flat[i + 1];
  }
  return obj;
}

function derivePhase(track, nowMs = Date.now()) {
  return deriveNotificationStoryPhase({
    mentionCount: parseInt(track.mentionCount ?? '1', 10),
    firstSeen: parseInt(track.firstSeen ?? '0', 10),
    lastSeen: parseInt(track.lastSeen ?? String(nowMs), 10),
  }, nowMs);
}

function matchesSensitivity(ruleSensitivity, severity) {
  if (ruleSensitivity === 'all') return true;
  if (ruleSensitivity === 'high') return severity === 'high' || severity === 'critical';
  return severity === 'critical';
}

// ── Watchlist story alerts (#4922 item e / U3) ───────────────────────────────
//
// @notification-source: rss
//   The watchlist publisher below builds payload.title from RSS story-track
//   rows (title persisted at ingest by list-feed-digest). Payload shape is
//   fixed by the U3 design: { title, link, source, tickers, importanceScore,
//   coalesceKey } — no `description` field is emitted. Registered in
//   tests/notification-relay-payload-audit.test.mjs.
//
// Once per cron tick (every 30 min), independent of digest rules and digest
// delivery: scan the story accumulator, extract tickers from title +
// description, and enqueue one `watchlist_story_alert` event per story whose
// importance score clears WATCHLIST_STORY_SCORE_MIN. The notification relay
// fans events out to PRO users whose alert rule opted in AND whose
// rule.tickers intersects payload.tickers.
//
// Re-alert protection: publisher-side SET NX on the shared scan-dedup
// keyspace, keyed on the coalesceKey (`watchlist:${storyHash}` — stable
// story identity) via the shared buildDedupMaterial helper, 24h TTL — a
// story that stays in the 24h scan window alerts once, not every 30-min
// tick. LPUSH failure rolls the dedup key back so the next tick retries
// (ais-relay publishNotificationEvent parity).

const WATCHLIST_TICKER_DICTIONARY = buildTickerDictionary(WATCHLIST_STOCKS_DATA?.symbols ?? []);

/**
 * One watchlist scan per cron tick. Best-effort and self-contained: any
 * failure logs and returns — it must never block digest delivery, and a
 * digest failure must never block it (hence the call sits at the very top
 * of main(), before the digest-rules fetch).
 */
async function scanAndEnqueueWatchlistStoryEvents(nowMs) {
  return scanWatchlistStoryEvents(nowMs, {
    env: process.env,
    upstashRest,
    upstashPipeline,
    readStoryTracksChunked,
    tickerDictionary: WATCHLIST_TICKER_DICTIONARY,
    logger: console,
    scanWindowMs: DIGEST_LOOKBACK_MS,
  });
}

const DIGEST_DIPLOMACY_KEYWORDS = DIGEST_DIPLOMACY_DATA.diplomacyKeywords;
const DIGEST_FLASHPOINT_KEYWORDS = DIGEST_DIPLOMACY_DATA.flashpointKeywords;
const DIGEST_DIPLOMACY_FLASHPOINT_PAIRS = DIGEST_DIPLOMACY_DATA.diplomacyFlashpointPairs;

function digestSignalText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Word-start containment in digest-normalized text. Mirrors
// shared/brief-filter.js:containsKeywordToken — prevents 'pact' inside
// 'impact' (false positive) while still matching 'iran' inside
// 'iranian' (demonym preserved). PR #3909 review (P2).
function digestContainsKeywordToken(text, kw) {
  if (!kw) return false;
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}`).test(text);
}

function digestHasDiplomacyFlashpointSignal(title) {
  const text = digestSignalText(title);
  if (
    DIGEST_DIPLOMACY_FLASHPOINT_PAIRS.some(([entity, action]) =>
      digestContainsKeywordToken(text, entity) && digestContainsKeywordToken(text, action),
    )
  ) {
    return true;
  }
  return DIGEST_DIPLOMACY_KEYWORDS.some((kw) => digestContainsKeywordToken(text, kw)) &&
    DIGEST_FLASHPOINT_KEYWORDS.some((kw) => digestContainsKeywordToken(text, kw));
}

function digestPercentile(sortedNumbers, pct) {
  if (sortedNumbers.length === 0) return 0;
  const idx = Math.min(sortedNumbers.length - 1, Math.floor((sortedNumbers.length - 1) * pct));
  return sortedNumbers[idx];
}

function logDigestImportanceObservability(stories, { variant, lang, sensitivity }) {
  if (!Array.isArray(stories) || stories.length === 0) return;
  const clusterSizes = stories
    .map((s) => Array.isArray(s.mergedHashes) && s.mergedHashes.length > 0 ? s.mergedHashes.length : 1)
    .sort((a, b) => a - b);
  const diplomacyHits = stories.filter((s) => digestHasDiplomacyFlashpointSignal(s.title)).length;
  // #6428: a metric named corroboration must count publishers, or the number
  // an operator reads while diagnosing a quiet notification run overstates
  // independence exactly like the gates used to.
  const corroborationHits = stories.filter((s) =>
    countPublisherFamilies(s.sources) >= MIN_CORROBORATING_PUBLISHERS ||
    (Array.isArray(s.mergedHashes) && s.mergedHashes.length >= 2)
  ).length;
  if (diplomacyHits === 0 && corroborationHits === 0) return;
  console.log(
    `[digest] buildDigest importance signals variant=${variant} lang=${lang} ` +
      `sensitivity=${sensitivity} diplomacy=${diplomacyHits} ` +
      `corroboration=${corroborationHits} ` +
      `clusterSizeP50=${digestPercentile(clusterSizes, 0.5)} ` +
      `clusterSizeP90=${digestPercentile(clusterSizes, 0.9)}`,
  );
}

// ── Digest content ────────────────────────────────────────────────────────────

// Dedup lives in scripts/lib/brief-dedup.mjs (orchestrator) with the
// legacy Jaccard in scripts/lib/brief-dedup-jaccard.mjs. The orchestrator
// reads DIGEST_DEDUP_MODE at call time — default 'jaccard' keeps
// behaviour identical to pre-embedding production. stripSourceSuffix
// is imported from the Jaccard module so the text/HTML formatters
// below keep their current per-story title cleanup.

async function buildDigest(rule, windowStartMs) {
  const variant = rule.variant ?? 'full';
  const lang = rule.lang ?? 'en';
  const accKey = `digest:accumulator:v1:${variant}:${lang}`;

  const hashes = await upstashRest(
    'ZRANGEBYSCORE', accKey, String(windowStartMs), String(Date.now()),
  );
  if (!Array.isArray(hashes) || hashes.length === 0) return null;

  // null = at least one story-track chunk failed. Returning null here
  // matches the legacy semantic (single-pipeline failure produced
  // an empty story list → null buildDigest result → cron skipped
  // sending the digest for this user/variant). The alternative —
  // shipping a digest built from only the successfully-fetched
  // chunks — would silently drop stories AND mark the slot as sent,
  // suppressing retry on the next tick. See:
  //   scripts/lib/story-track-batch-reader.mjs (bail-on-failure rationale).
  const trackResults = await readStoryTracksChunked(hashes, upstashPipeline, {
    fields: [
      'title', 'severity', 'publishedAt', 'isOpinion', 'isFeelGood',
      'isEphemeralLiveCoverage', 'link', 'description', 'mentionCount',
      'firstSeen', 'lastSeen', 'currentScore', 'category', 'entityCorroborationCount',
      storyCorroborationField(variant, lang),
    ],
  });
  if (trackResults === null) return null;

  // READ-time freshness cutoff is anchored to the rule's own digest
  // window. Daily user (24h window) → 48h cutoff; weekly user (7d
  // window) → 8d cutoff. See: skill ingest-gate-tightening-leaves-
  // residue-in-read-path. Legacy rows without publishedAt fall through
  // (back-compat); pre-deploy residue with no publishedAt is handled
  // by audit --mode=residue (one-shot).
  const ageCutoffMs = readTimeAgeCutoffMs(windowStartMs);

  const stories = [];
  let droppedStaleAtRead = 0;
  let droppedOpinion = 0;
  let droppedFeelGood = 0;
  let droppedEphemeralLive = 0;
  const droppedEphemeralLiveTitleSamples = [];
  for (let i = 0; i < hashes.length; i++) {
    const raw = trackResults[i]?.result;
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const track = flatArrayToObject(raw);
    if (!track.title || !track.severity) continue;

    if (shouldDropTrackByAge(track, ageCutoffMs)) {
      droppedStaleAtRead++;
      continue;
    }

    // Non-event brief exclusion (F3). The brief is event-driven intelligence
    // — an op-ed or historical explainer is not an event.
    // Ingest stamps `isOpinion` on the story:track:v1 row. Explicit "1" and
    // "0" are authoritative; only unstamped legacy rows are classified at
    // read time by the pure helper below.
    if (shouldDropOpinionTrack(track)) {
      droppedOpinion++;
      continue;
    }

    // Feel-good / lifestyle exclusion (sibling to the opinion filter
    // above). Same plumbing: trust the ingest stamp when present;
    // re-classify pre-stamp residue rows from persisted title/link/
    // description. The brief is event-driven; a vintage-warplane
    // veterans' reunion in a 9,800-person town is not an event. See
    // docs/plans/2026-05-17-001-fix-feelgood-lifestyle-filter-plan.md.
    //
    // M6 / adv-005 — opinion+feel-good counter asymmetry: a row matched
    // by BOTH classifiers (columnist-nostalgia essay; op-ed-with-tribute
    // framing) increments only droppedOpinion above — the opinion
    // `continue` already fired. droppedFeelGood is therefore "rows the
    // feel-good filter dropped *after* opinion passed on them in this
    // run," not "all feel-good content seen." Applies to stamped,
    // residue-classified, and mixed paths equally. See Operational
    // Notes in the plan for the operator-facing version.
    const stampedFeelGood = track.isFeelGood === '1';
    const feelGoodStampMissing = typeof track.isFeelGood !== 'string' || track.isFeelGood.length === 0;
    if (
      stampedFeelGood ||
      (feelGoodStampMissing && classifyFeelGood({
        title: track.title,
        link: track.link ?? '',
        description: typeof track.description === 'string' ? track.description : '',
      }))
    ) {
      droppedFeelGood++;
      continue;
    }

    // Ephemeral live-programming exclusion. This is intentionally a digest/
    // brief read-path filter, not a global news-feed drop: live video teasers
    // can be acceptable inside a live news surface, but a delayed daily brief
    // should not tell readers hours later to "WATCH LIVE" a briefing that may
    // address something.
    const stampedEphemeralLive = track.isEphemeralLiveCoverage === '1';
    const ephemeralLiveStampMissing =
      typeof track.isEphemeralLiveCoverage !== 'string' ||
      track.isEphemeralLiveCoverage.length === 0;
    if (
      stampedEphemeralLive ||
      (ephemeralLiveStampMissing && classifyEphemeralLiveCoverage({
        title: track.title,
        link: track.link ?? '',
        description: typeof track.description === 'string' ? track.description : '',
      }))
    ) {
      droppedEphemeralLive++;
      if (droppedEphemeralLiveTitleSamples.length < EPHEMERAL_LIVE_LOG_TITLE_SAMPLE_LIMIT) {
        droppedEphemeralLiveTitleSamples.push(compactDroppedEphemeralLiveTitle(track.title));
      }
      continue;
    }

    const phase = derivePhase(track);
    if (phase === 'fading') continue;
    if (!matchesSensitivity(rule.sensitivity ?? 'high', track.severity)) continue;

    stories.push({
      hash: hashes[i],
      title: track.title,
      link: track.link ?? '',
      severity: track.severity,
      currentScore: parseInt(track.currentScore ?? '0', 10),
      mentionCount: parseInt(track.mentionCount ?? '1', 10),
      phase,
      sources: [],
      // Cleaned RSS description from list-feed-digest's parseRssXml; empty
      // on old story:track rows (pre-fix, 48h bleed) and feeds without a
      // description. Downstream adapter falls back to the cleaned headline.
      description: typeof track.description === 'string' ? track.description : '',
      // EventCategory persisted by parseRssXml + buildStoryTrackHsetFields
      // (`isFeelGood` PR added the field; the category sibling closes the
      // 8/8 'General' threads-card gap PR #3697 exposed). Defensive empty
      // string on missing/non-string: shared/brief-filter.js's
      // `asTrimmedString(raw.category) || 'General'` fallback covers
      // pre-stamp residue rows. Display-side word-wise titleCase happens
      // once at the envelope-build site in shared/brief-filter.js.
      category: typeof track.category === 'string' ? track.category : '',
      // Cross-title entity corroboration persisted by list-feed-digest.
      // This is distinct from exact-title source sets: the brief composer
      // uses it only for the narrow lead/card coherence override when
      // the LLM's top-ranked story is a corroborated flashpoint-diplomacy
      // development.
      entityCorroborationCount: parseInt(track.entityCorroborationCount ?? '0', 10) || 0,
      // #9213: the verdict list-feed-digest served for this variant, stored
      // on the track row; attachDigestCorroboration resolves it per item.
      corroboration: readStoryCorroboration(track, variant, lang),
    });
  }

  if (droppedStaleAtRead > 0) {
    const cutoffH = Math.round((Date.now() - ageCutoffMs) / (60 * 60 * 1000));
    console.warn(
      `[digest] buildDigest read-time freshness floor dropped ${droppedStaleAtRead} ` +
        `stale items (window cutoff: ${cutoffH}h ago) — likely pre-deploy residue`,
    );
  }

  if (droppedOpinion > 0) {
    console.log(
      `[digest] buildDigest opinion filter dropped ${droppedOpinion} ` +
        `op-ed/analysis item(s) from the pool (variant=${rule.variant ?? 'full'} ` +
        `lang=${rule.lang ?? 'en'} sensitivity=${rule.sensitivity ?? 'high'})`,
    );
  }

  if (droppedFeelGood > 0) {
    console.log(
      `[digest] buildDigest feel-good filter dropped ${droppedFeelGood} ` +
        `feel-good/lifestyle item(s) from the pool (variant=${rule.variant ?? 'full'} ` +
        `lang=${rule.lang ?? 'en'} sensitivity=${rule.sensitivity ?? 'high'})`,
    );
  }

  if (droppedEphemeralLive > 0) {
    const titleSampleSuffix = droppedEphemeralLiveTitleSamples.length > 0
      ? ` sample_titles=${JSON.stringify(droppedEphemeralLiveTitleSamples)}`
      : '';
    console.log(
      `[digest] buildDigest ephemeral-live filter dropped ${droppedEphemeralLive} ` +
        `live-programming teaser(s) from the pool (variant=${rule.variant ?? 'full'} ` +
        `lang=${rule.lang ?? 'en'} sensitivity=${rule.sensitivity ?? 'high'})` +
        titleSampleSuffix,
    );
  }

  if (stories.length === 0) return null;

  stories.sort((a, b) => b.currentScore - a.currentScore);
  const cfg = readOrchestratorConfig(process.env);
  // Sample tsMs BEFORE dedup so briefTickId anchors to tick-start, not
  // to dedup-completion. Dedup can take a few seconds on cold-cache
  // embed calls; we want the replay log's tick id to reflect when the
  // tick began processing, which is the natural reading of
  // "briefTickId" for downstream readers.
  const tsMs = Date.now();
  const { reps: dedupedAll, embeddingByHash, logSummary } =
    await deduplicateStories(stories);
  // Replay log (opt-in via DIGEST_DEDUP_REPLAY_LOG=1). Best-effort — any
  // failure is swallowed by writeReplayLog. Runs AFTER dedup so the log
  // captures the real rep + cluster assignments. RuleId omits userId on
  // purpose: dedup input is shared across users of the same (variant,
  // lang, sensitivity), and we don't want user identity in log keys.
  // See docs/brainstorms/2026-04-23-001-brief-dedup-recall-gap.md §5 Phase 1.
  //
  // AWAITED on purpose: this script exits via explicit process.exit(1)
  // on the brief-compose failure gate (~line 1539) and on main().catch
  // (~line 1545). process.exit does NOT drain in-flight promises like
  // natural exit does, so a `void` call here would silently drop the
  // last N ticks' replay records — exactly the runs where measurement
  // fidelity matters most. writeReplayLog has its own internal try/
  // catch + early return when the flag is off, so awaiting is free on
  // the disabled path and bounded by the 10s Upstash pipeline timeout
  // on the enabled path.
  // Codex PR #3617 P1 — hydrate sources on `dedupedAll` BEFORE
  // writeReplayLog so the replay records carry the canonical source
  // count Sprint 1 / U6 needs to evaluate +5-evolution bypasses. The
  // pre-fix order wrote replay records with `sources: []` (hydration
  // happened later, only on the post-cap `top` slice), which made U6
  // structurally unable to detect source-count evolution.
  //
  // Implementation: run SMEMBERS for every rep's mergedHashes BEFORE
  // the replay-log write. `top` (built later as a slice of dedupedAll)
  // shares object references with the reps we're hydrating here, so the
  // later "hydrate top.sources" block becomes a no-op and is removed
  // below. Cost: one Upstash pipeline with ~30 SMEMBERS commands per
  // tick — bounded by the dedup output size (typically 20-30 reps).
  {
    const preCmds = [];
    const preIdx = [];
    for (let i = 0; i < dedupedAll.length; i++) {
      dedupedAll[i].sources = [];
      const hashes = Array.isArray(dedupedAll[i].mergedHashes)
        ? dedupedAll[i].mergedHashes
        : [dedupedAll[i].hash];
      for (const h of hashes) {
        if (typeof h === 'string' && h.length > 0) {
          preCmds.push(['SMEMBERS', `story:sources:v1:${h}`]);
          preIdx.push(i);
        }
      }
    }
    if (preCmds.length > 0) {
      try {
        const preResults = await upstashPipeline(preCmds);
        for (let j = 0; j < preResults.length; j++) {
          const arr = preResults[j]?.result ?? [];
          const target = dedupedAll[preIdx[j]];
          for (const src of arr) {
            if (!target.sources.includes(src)) target.sources.push(src);
          }
        }
      } catch (err) {
        // Best-effort: if the source pipeline fails, replay-log carries
        // empty source arrays (the pre-fix shape). Cooldown evolution
        // bypass goes blind for that tick — preferable to crashing the
        // cron over a non-load-bearing diagnostic write.
        console.warn(
          `[digest] U6 pre-hydrate sources failed: ${err?.message ?? err} — replay records will carry empty sources for this tick`,
        );
      }
    }
  }
  // #9213: per-item corroboration, after sources are hydrated.
  attachDigestCorroboration(dedupedAll, stories);
  const ruleKey = `${variant}:${lang}:${rule.sensitivity ?? 'high'}`;
  await writeReplayLog({
    stories,
    reps: dedupedAll,
    embeddingByHash,
    cfg,
    tickContext: {
      briefTickId: `${ruleKey}:${tsMs}`,
      ruleId: ruleKey,
      tsMs,
    },
  });
  // Apply the absolute-score floor AFTER dedup so the floor runs on
  // the representative's score (mentionCount-sum doesn't change the
  // score field; the rep is the highest-scoring member of its
  // cluster). At DIGEST_SCORE_MIN=0 this is a no-op.
  const scoreFloor = getDigestScoreMin();
  const deduped = applyDigestScoreFloor(dedupedAll, scoreFloor);
  if (scoreFloor > 0 && dedupedAll.length !== deduped.length) {
    console.log(
      `[digest] score floor dropped ${dedupedAll.length - deduped.length} ` +
        `of ${dedupedAll.length} clusters (DIGEST_SCORE_MIN=${scoreFloor})`,
    );
  }
  // If the floor drained every cluster, return null with a distinct
  // log line so operators can tell "floor too high" apart from "no
  // stories in window" (the caller treats both as a skip but the
  // root causes are different — without this line the main-loop
  // "No stories in window" message never fires because [] is truthy
  // and silences the diagnostic at the caller's guard).
  if (deduped.length === 0) {
    if (scoreFloor > 0 && dedupedAll.length > 0) {
      console.log(
        `[digest] score floor dropped ALL ${dedupedAll.length} clusters ` +
          `(DIGEST_SCORE_MIN=${scoreFloor}) — skipping user`,
      );
    }
    return null;
  }
  const sliced = deduped.slice(0, DIGEST_MAX_ITEMS);

  // Secondary topic-grouping pass: re-orders `sliced` so related stories
  // form contiguous blocks. Disabled via DIGEST_DEDUP_TOPIC_GROUPING=0.
  // Gate on the sidecar Map being non-empty — this is the precise
  // signal for "primary embed path produced vectors". Gating on
  // cfg.mode is WRONG: the embed path can run AND fall back to
  // Jaccard at runtime (try/catch inside deduplicateStories), leaving
  // cfg.mode==='embed' but embeddingByHash empty. The Map size is the
  // only ground truth. Kill-switch (mode=jaccard) and runtime fallback
  // both produce size=0 → shouldGroupTopics=false → no misleading
  // "topic grouping failed: missing embedding" warn.
  // Errors from the helper are returned (not thrown) and MUST NOT
  // cascade into the outer Jaccard fallback — they just preserve
  // primary order.
  const shouldGroupTopics = cfg.topicGroupingEnabled && embeddingByHash.size > 0;
  const { reps: top, topicCount, error: topicErr } = shouldGroupTopics
    ? groupTopicsPostDedup(sliced, cfg, embeddingByHash)
    : { reps: sliced, topicCount: sliced.length, error: null };
  if (topicErr) {
    console.warn(
      `[digest] topic grouping failed, preserving primary order: ${topicErr.message}`,
    );
  }
  if (logSummary) {
    const finalLog =
      shouldGroupTopics && !topicErr
        ? logSummary.replace(
            /clusters=(\d+) /,
            `clusters=$1 topics=${topicCount} `,
          )
        : logSummary;
    console.log(finalLog);
  }

  // Codex PR #3617 P1 — sources are already hydrated on `dedupedAll`
  // BEFORE the writeReplayLog call above (so U6 replay records carry
  // canonical source counts). `top` items are references to the same
  // objects, so they already have `sources` populated. The redundant
  // hydration block that lived here pre-fix has been removed; it would
  // have RESET (top[i].sources = []) and re-fetched, doubling the
  // SMEMBERS pipeline cost per tick for no functional benefit.

  logDigestImportanceObservability(top, {
    variant,
    lang,
    sensitivity: rule.sensitivity ?? 'high',
  });

  return top;
}

// ── Brief composition ────────────────────────────────────────────────────────

/**
 * Write brief:{userId}:{issueSlot} for every eligible user and
 * brief:latest:{userId} as the latest-pointer for share/readback, then
 * return { briefByUser, counters } for the digest loop + main's
 * end-of-run exit gate. One brief per user regardless of how many
 * variants they have enabled.
 *
 * Returns empty counters when brief composition is disabled,
 * insights are unavailable, or the signing secret is missing. Never
 * throws — the digest send path must remain independent of the
 * brief path, so main() handles exit-codes at the very end AFTER
 * the digest has been dispatched.
 *
 * @param {unknown[]} rules
 * @param {number} nowMs
 * @param {{ deadlineMs?: number }} [opts] stop starting new users at this wall-clock time
 * @returns {Promise<{ briefByUser: Map<string, object>; composeSuccess: number; composeFailed: number }>}
 */
async function composeBriefsForRun(rules, nowMs, { deadlineMs } = {}) {
  const briefByUser = new Map();
  if (!BRIEF_COMPOSE_ENABLED) return { briefByUser, composeSuccess: 0, composeFailed: 0 };

  // The brief's story list now comes from the same digest accumulator
  // the email reads (buildDigest). news:insights:v1 is still consulted
  // for the global "clusters / multi-source" stat-page numbers, but no
  // longer for the story list itself. A failed or empty insights fetch
  // is NOT fatal — we fall back to zeroed numbers and still ship the
  // brief, because the stories are what matter. (A mismatched brief
  // was far worse than a brief with dashes on the stats page.)
  let insightsNumbers = { clusters: 0, multiSource: 0 };
  try {
    // raw = true pins the bare-key read (#7674): the seeder fleet publishes
    // bare rows and must keep doing so even if VERCEL_ENV ever leaks into
    // this container's runtime. The api readers of this key are hard-locked
    // raw too (api/latest-brief.ts and the brief routes).
    const insightsRaw = await readRawJsonFromUpstash(INSIGHTS_KEY, 3_000, true);
    if (insightsRaw) insightsNumbers = extractInsights(insightsRaw).numbers;
  } catch (err) {
    console.warn('[digest] brief: insights read failed, using zeroed stats:', err.message);
  }

  // Memoize buildDigest by (variant, lang, sensitivity, windowStart) for
  // this cron run. The key and its sensitivity default live in
  // scripts/lib/digest-orchestration-helpers.mjs (createDigestMemo) so
  // tests/digest-memo-sensitivity.test.mjs can prove a stricter user never
  // inherits a looser populator's pool, rather than grepping this file.
  const digestFor = createDigestMemo(buildDigest, { nowMs, lookbackMs: DIGEST_LOOKBACK_MS });

  // Pre-annotate every eligible rule with its lastSentAt + isDue
  // status. The compose flow uses this to prefer a "due-this-tick"
  // candidate as the canonical synthesis source, falling back to any
  // eligible candidate when nothing is due (preserving today's
  // dashboard refresh contract for weekly users on non-due ticks).
  // Codex Round-3 High #1 + Round-4 High #1 + Round-4 Medium #2.
  //
  // One Upstash GET per rule per tick; with caching across rules of
  // the same user this is cheap. The send loop in main() reads from
  // this same map (via getLastSentAt) so compose + send agree on
  // lastSentAt for every rule.
  const annotatedByUser = new Map();
  for (const [userId, candidates] of groupEligibleRulesByUser(rules)) {
    const annotated = [];
    for (const rule of candidates) {
      // Brief-only rules are never sent, so they have no last-sent record.
      const lastSentAt = rule.briefOnly ? null : await getLastSentAt(rule);
      annotated.push({ rule, lastSentAt, due: briefCandidateDue(rule, lastSentAt, isDue) });
    }
    annotatedByUser.set(userId, annotated);
  }

  let composeSuccess = 0;
  let composeFailed = 0;
  let composeDeferred = 0;
  for (const [userId, annotated] of annotatedByUser) {
    // A bounded pass (the default-brief pass) stops starting new users at its
    // deadline; the rest are composed on a later tick.
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      composeDeferred++;
      continue;
    }
    try {
      const hit = await composeAndStoreBriefForUser(userId, annotated, insightsNumbers, digestFor, nowMs);
      if (hit) {
        briefByUser.set(userId, hit);
        composeSuccess++;
      }
    } catch (err) {
      composeFailed++;
      console.warn(`[digest] brief: compose failed for ${userId}:`, err.message);
    }
  }
  console.log(
    `[digest] brief: compose_success=${composeSuccess} compose_failed=${composeFailed} ` +
      `deferred=${composeDeferred} total_users=${annotatedByUser.size}`,
  );
  return { briefByUser, composeSuccess, composeFailed };
}

/**
 * Per-user: pick a winning candidate (DUE rules first, then any
 * eligible rule), pull its digest pool, run canonical synthesis
 * over the FULL pre-cap pool, then compose the envelope with the
 * synthesis spliced in. SETEX the envelope, sign the magazine URL.
 *
 * Returns the entry the caller should stash in briefByUser, or null
 * when no candidate had stories. The entry's `synthesisLevel` field
 * tells the send loop which fallback path produced the lead (1 =
 * canonical, 2 = degraded, 3 = stub) — drives the email subject-line
 * ternary and the parity log.
 *
 * @param {string} userId
 * @param {Array<{ rule: object; lastSentAt: number | null; due: boolean }>} annotated
 * @param {{ clusters: number; multiSource: number }} insightsNumbers
 * @param {(rule: object) => Promise<unknown[]>} digestFor
 * @param {number} nowMs
 */
async function composeAndStoreBriefForUser(userId, annotated, insightsNumbers, digestFor, nowMs) {
  // Two-pass walk extracted to a pure helper so it can be unit-tested
  // (A6.l + A6.m). When no candidate has a non-empty pool — OR when
  // every non-empty candidate has its stories filtered out by the
  // composer (URL/headline/shape filters) — returns null.
  //
  // The `tryCompose` callback is the filter-rejection fall-through:
  // before the original PR, the legacy loop kept trying lower-priority
  // candidates whenever compose returned null. Without this hook the
  // helper would claim the first non-empty pool as winner and the
  // caller would bail on filter-drop, suppressing briefs that a
  // lower-priority candidate would have produced.
  //
  // We compose WITHOUT synthesis here (cheap — pure JS, no I/O) just
  // to check filter survival; the real composition with synthesis
  // splice-in happens once below, after the winner is locked in.
  const log = (line) => console.log(line);
  const winnerResult = await pickWinningCandidateWithPool(
    annotated,
    digestFor,
    log,
    userId,
    (cand, stories) => {
      const test = composeBriefFromDigestStories(
        cand.rule,
        stories,
        insightsNumbers,
        { nowMs },
      );
      return test ?? null;
    },
  );
  if (!winnerResult) return null;
  const { winner, stories: winnerStories } = winnerResult;

  // ── Canonical synthesis (3-level fallback chain) ────────────────────
  //
  // L1: full pre-cap pool + personalised ctx (profile, greeting). The
  //     desired outcome — single LLM call per user, lead anchored on
  //     the wider story set the model has the most signal from.
  // L2: post-cap envelope-only + empty ctx. Mirrors today's
  //     enrichBriefEnvelopeWithLLM behavior — used when L1 returns
  //     null (LLM down across all providers, parse failure).
  // L3: stub from assembleStubbedBriefEnvelope. The brief still
  //     ships; only the lead text degrades. Email subject downgrades
  //     from "Intelligence Brief" to "Digest" (driven by
  //     synthesisLevel === 3 in the send loop).
  const sensitivity = winner.rule.sensitivity ?? 'high';
  let synthesis = null;
  let publicLead = null;
  let synthesisLevel = 3;  // pessimistic default; bumped on success
  let synthesisReused = false;
  // When this brief's prose was generated: this tick unless it is reused, in
  // which case the reused prose keeps its original time (written to the
  // brief:latest pointer so the next reuse check ages it correctly).
  let synthesizedAt = nowMs;
  if (BRIEF_LLM_ENABLED) {
    // Synthesis-boundary adapter. `winnerStories` is the raw
    // buildDigest pool ({ title, severity, sources }); the synthesis
    // path (buildDigestPrompt / checkLeadGrounding / hashDigestInput)
    // reads { headline, threatLevel, source, category, country }.
    // Without this mapping every prompt story line rendered as
    // "[h:hash] [] undefined — …" and the model confabulated the
    // whole brief. Adapt ONCE here — runSynthesisWithFallback's L2
    // slice and generateDigestProsePublic both inherit the adapted
    // shape. composeBriefFromDigestStories below KEEPS the raw
    // `winnerStories` (digestStoryToUpstreamTopStory expects the raw
    // shape). See plan 2026-05-14-001 F2 / Phase 2.
    const synthesisStories = winnerStories.map(digestStoryToSynthesisShape);

    // #4917: on a non-due tick the compose only refreshes the dashboard
    // preview — nothing is delivered — so a young prior envelope's prose
    // can stand in for the paid synthesis + public-lead calls, provided
    // it still grounds against the CURRENT pool (pool rotation or an L3
    // stub lead fails the gate and pays a fresh generation). Due ticks
    // never enter this branch: delivered digests are always fresh
    // (`winner.due` is preferred by pickWinningCandidateWithPool, so a
    // due candidate with stories is always the winner).
    if (!winner.due && NONDUE_SYNTHESIS_REUSE_MS > 0) {
      const prior = await fetchLatestBriefEnvelope(userId);
      const decision = resolveNonDueSynthesisReuse(prior?.envelope ?? null, {
        nowMs,
        maxAgeMs: NONDUE_SYNTHESIS_REUSE_MS,
        currentStories: synthesisStories,
        priorSynthesizedAt: prior?.synthesizedAt,
      });
      if (decision.reuse) {
        synthesis = decision.synthesis;
        publicLead = decision.publicLead;
        synthesisLevel = 1;
        synthesisReused = true;
        synthesizedAt = decision.synthesizedAt;
        console.log(
          `[digest] synthesis reused user=${userId} ` +
            `age_min=${Math.round(decision.ageMs / 60_000)} public=${publicLead ? 1 : 0}`,
        );
      } else if (decision.reason !== 'no_prior_envelope') {
        console.log(`[digest] synthesis reuse declined user=${userId} reason=${decision.reason}`);
      }
    }

    if (!synthesisReused) {
      const ctx = await buildSynthesisCtx(winner.rule, nowMs);
      const result = await runSynthesisWithFallback(
        userId,
        synthesisStories,
        sensitivity,
        ctx,
        withAiRoutingPolicy(briefLlmDeps, await resolveAiRoutingPolicy(userId)),
        (level, kind, err) => {
          if (kind === 'throw') {
            console.warn(
              `[digest] brief: synthesis L${level} threw for ${userId} — falling to L${level + 1}:`,
              err?.message,
            );
          } else if (kind === 'success' && level === 2) {
            console.log(`[digest] synthesis level=2_degraded user=${userId}`);
          } else if (kind === 'success' && level === 3) {
            console.log(`[digest] synthesis level=3_stub user=${userId}`);
          }
        },
      );
      synthesis = result.synthesis;
      synthesisLevel = result.level;
      // Public synthesis — parallel call. Profile-stripped; cache-
      // shared across all users for the same (date, sensitivity,
      // story-pool). Captures the FULL prose object (lead + signals +
      // threads) since each personalised counterpart in the envelope
      // can carry profile bias and the public surface needs sibling
      // safe-versions of all three. Failure is non-fatal — the
      // renderer's public-mode fail-safes (omit pull-quote / omit
      // signals page / category-derived threads stub) handle absence
      // rather than leaking the personalised version. Same adapted
      // pool as the personalised synthesis.
      try {
        const pub = await generateDigestProsePublic(synthesisStories, sensitivity, briefLlmDeps);
        if (pub) publicLead = pub;  // { lead, threads, signals, rankedStoryHashes }
      } catch (err) {
        console.warn(`[digest] brief: publicLead generation failed for ${userId}:`, err?.message);
      }
    }
  }

  // The followed-countries bias came from Convex. The personal build has no
  // follow list, so the bias input stays empty — the same input the fetch's
  // soft-error path produced, which leaves the ranking unbiased.
  const followedCountriesUsed = [];

  // Compose envelope with synthesis pre-baked. The composer applies
  // severity/topic-cluster ordering BEFORE the cap, with
  // rankedStoryHashes only as a tie-breaker inside similarly severe
  // blocks, so critical clusters survive MAX_STORIES_PER_USER.
  const dropStats = {
    severity: 0,
    headline: 0,
    url: 0,
    shape: 0,
    cap: 0,
    source_topic_cap: 0,
    institutional_static_page: 0,
    ephemeral_live: 0,
    in: winnerStories.length,
  };
  const orderStats = {
    leadDiplomacyOverride: false,
  };
  const envelope = composeBriefFromDigestStories(
    winner.rule,
    winnerStories,
    insightsNumbers,
    {
      nowMs,
      onDrop: (ev) => { dropStats[ev.reason] = (dropStats[ev.reason] ?? 0) + 1; },
      onOrder: (ev) => { orderStats.leadDiplomacyOverride = ev.leadDiplomacyOverride === true; },
      synthesis: synthesis || publicLead
        ? {
            ...(synthesis ?? {}),
            publicLead: publicLead?.lead ?? undefined,
            publicSignals: publicLead?.signals ?? undefined,
            publicThreads: publicLead?.threads ?? undefined,
          }
        : undefined,
      followedCountries: followedCountriesUsed,
    },
  );

  // Operator-visible signal that the followed-country bias did
  // (or did not) participate in this user's compose. Distinct log
  // line so the brief-filter-drops grep stays clean. Captures the
  // clamped list (post free-tier truncation) so an operator
  // reading the log can recompute "why was this story boosted".
  // Empty list → no-op (and we don't log to keep volume sane).
  if (followedCountriesUsed.length > 0) {
    console.log(
      `[digest] brief followed-bias user=${userId} ` +
        `count=${followedCountriesUsed.length} ` +
        `countries=${followedCountriesUsed.join(',')}`,
    );
  }

  // Per-attempt filter-drop line for the winning candidate. Same
  // shape today's log emits — operators can keep their existing
  // queries. The `due` field is new; legacy parsers ignore unknown
  // fields.
  const out = envelope?.data?.stories?.length ?? 0;
  console.log(
    `[digest] brief filter drops user=${userId} ` +
      `sensitivity=${sensitivity} ` +
      `variant=${winner.rule.variant ?? 'full'} ` +
      `due=${winner.due} ` +
      `outcome=${envelope ? 'shipped' : 'rejected'} ` +
      `in=${dropStats.in} ` +
      `dropped_severity=${dropStats.severity} ` +
      `dropped_url=${dropStats.url} ` +
      `dropped_headline=${dropStats.headline} ` +
      `dropped_shape=${dropStats.shape} ` +
      `dropped_cap=${dropStats.cap} ` +
      `dropped_source_topic_cap=${dropStats.source_topic_cap} ` +
      `dropped_institutional_static_page=${dropStats.institutional_static_page} ` +
      `dropped_ephemeral_live=${dropStats.ephemeral_live} ` +
      `out=${out}`,
  );

  if (!envelope) return null;

  // ── Lead ↔ final-card-#1 coherence (F4) ─────────────────────────────
  //
  // The synthesis emits `lead` and `rankedStoryHashes` as independent
  // fields with no constraint that the lead is ABOUT the story that
  // renders first. And `rankedStoryHashes[0]` is NOT
  // `data.stories[0]` — `orderBriefCandidates` re-sorts by severity /
  // topic-block / score with the LLM rank only as a tie-breaker. So
  // the coherence check must run AFTER `filterTopStories` has produced
  // the final order, against `envelope.data.stories[0]` — never
  // `rankedStoryHashes[0]`. It runs here in the orchestration layer
  // (not inside the pure `composeBriefFromDigestStories`) so the
  // composer stays I/O-free; `data.stories` is identical before and
  // after `enrichBriefEnvelopeWithLLM` (skipDigestProse → per-story
  // only), so checking now is equivalent to checking post-enrich.
  //
  // Measure-first (plan F4, option b): emit a telemetry line every
  // brief and a warn on mismatch — ship the brief as-is. Once the
  // mismatch RATE is known in production, decide between regenerating
  // the lead bound to stories[0] or having the LLM emit a separate
  // leadStoryHash. See docs/plans/2026-05-14-001-…-plan.md (F4).
  if (synthesis?.lead && Array.isArray(envelope?.data?.stories) && envelope.data.stories.length > 0) {
    const card1 = envelope.data.stories[0];
    const card1Headline = typeof card1?.headline === 'string' ? card1.headline : '';
    // leadGroundsAgainstStory: true iff the lead shares ≥1 proper-noun
    // anchor with card #1's headline (fixed threshold of 1 — coherence
    // asks "same story?", not "how grounded?"). checkLeadGrounding is
    // the wrong fit here: a single headline can carry ≥4 anchors,
    // tripping its size-based threshold up to 2.
    const coherent = leadGroundsAgainstStory(synthesis.lead, card1Headline);
    const coherentVia = !coherent
      ? 'mismatch'
      : (orderStats.leadDiplomacyOverride ? 'lead_diplomacy_override' : 'natural');
    console.log(
      `[digest] lead card1 coherence user=${userId} ` +
        `coherent=${coherent} synthesis_level=${synthesisLevel} ` +
        `coherent_via=${coherentVia} ` +
        `card1_clusterId=${card1?.clusterId ?? '?'}`,
    );
    if (!coherent) {
      console.warn(
        `[digest] LEAD/CARD-#1 INCOHERENCE user=${userId} — digest.lead does not ` +
          `reference the rendered first story. ` +
          `lead="${synthesis.lead.slice(0, 90)}" card1="${card1Headline.slice(0, 90)}"`,
      );
    }
  }

  // Per-story whyMatters enrichment. The canonical synthesis is
  // already spliced into the envelope above; `skipDigestProse: true`
  // makes this pass fill ONLY per-story rationales and leave
  // `envelope.data.digest` untouched. Without the flag,
  // enrichBriefEnvelopeWithLLM re-synthesises the digest prose here
  // (a second, ctx-free generateDigestProse call) and overwrites the
  // compose-pass synthesis — the "call site 2" parity regression.
  // See docs/plans/2026-05-14-001-fix-brief-pipeline-parity-grounding-opinion-plan.md.
  // Failures fall through cleanly — the stub `whyMatters` from the
  // composer is acceptable.
  let finalEnvelope = envelope;
  if (BRIEF_LLM_ENABLED) {
    try {
      const enriched = await enrichBriefEnvelopeWithLLM(envelope, winner.rule, briefLlmDeps, { skipDigestProse: true });
      // Defence in depth: re-validate the enriched envelope against
      // the renderer's strict contract before we SETEX it. If
      // enrichment produced a structurally broken shape (bad cache
      // row, code bug, upstream type drift) we'd otherwise SETEX it
      // and /api/brief would 404 the user's brief at read time. Fall
      // back to the unenriched envelope — which is already known to
      // pass assertBriefEnvelope() because composeBriefFromDigestStories
      // asserted on construction.
      try {
        assertBriefEnvelope(enriched);
        finalEnvelope = enriched;
      } catch (assertErr) {
        console.warn(`[digest] brief: enriched envelope failed assertion for ${userId} — shipping unenriched:`, assertErr?.message);
      }
    } catch (err) {
      console.warn(`[digest] brief: per-story enrichment threw for ${userId} — shipping unenriched envelope:`, err?.message);
    }
  }

  // ── Threads ↔ story-walk consistency (F7 / Phase 6) ─────────────────
  //
  // Re-derive the rendered "On The Desk" threads from the FINAL ordered
  // story walk — one thread per topic-cluster, in walk order — instead
  // of the LLM's independent `synthesis.threads` judgment that the
  // composer spliced in. This closes the 2026-05-13 bug where the
  // threads page listed topics in an order the story walk did not
  // follow and a story (hantavirus) was covered by no thread. The LLM
  // still emits `synthesis.threads` (it stays the checkLeadGrounding
  // haystack) — only the RENDERED threads change. Runs here, after
  // `enrichBriefEnvelopeWithLLM`, so each teaser is the LLM per-story
  // description; re-asserts before shipping and falls back to the
  // prior (synthesis/stub) threads if the derived shape somehow fails.
  if (Array.isArray(finalEnvelope?.data?.stories) && finalEnvelope?.data?.digest) {
    const derivedThreads = deriveThreadsFromOrderedStories(finalEnvelope.data.stories);
    if (derivedThreads.length > 0) {
      const withThreads = {
        ...finalEnvelope,
        data: {
          ...finalEnvelope.data,
          digest: {
            ...finalEnvelope.data.digest,
            threads: derivedThreads,
            // Derived threads carry no personalised content (category +
            // per-story description), so the share-URL surface renders
            // the same set — keep publicThreads in sync when present.
            ...(finalEnvelope.data.digest.publicThreads !== undefined
              ? { publicThreads: derivedThreads }
              : {}),
          },
        },
      };
      try {
        assertBriefEnvelope(withThreads);
        finalEnvelope = withThreads;
      } catch (threadErr) {
        console.warn(
          `[digest] brief: derived-threads envelope failed assertion for ${userId} — keeping prior threads:`,
          threadErr?.message,
        );
      }
    }
  }

  // Slot (YYYY-MM-DD-HHMM in the user's tz) is what routes the
  // magazine URL + Redis key. Using the same tz the composer used to
  // produce envelope.data.date guarantees the slot's date portion
  // matches the displayed date. Two same-day compose runs produce
  // distinct slots so each digest dispatch freezes its own URL.
  const briefTz = winner.rule?.digestTimezone ?? 'UTC';
  const issueSlot = issueSlotInTz(nowMs, briefTz);
  const key = `brief:${userId}:${issueSlot}`;
  // The latest-pointer lets readers (dashboard panel, share-url
  // endpoint) locate the most recent brief without knowing the slot.
  // One SET per compose is cheap and always current.
  const latestPointerKey = `brief:latest:${userId}`;
  // synthesizedAt and composedAt ride on the pointer, not the envelope (the
  // renderer rejects unknown envelope keys); the api readers use issueSlot
  // only. synthesizedAt ages reused prose; composedAt (every compose, reused
  // prose included) orders the budgeted default-brief pass.
  const latestPointerValue = JSON.stringify({ issueSlot, synthesizedAt, composedAt: nowMs });
  // raw = true pins the bare-key write (#7674): the digest composer publishes
  // the envelopes every api/brief reader resolves raw; see the insights read
  // above for the VERCEL_ENV-leak rationale.
  const pipelineResult = await redisPipeline([
    ['SETEX', key, String(BRIEF_TTL_SECONDS), JSON.stringify(finalEnvelope)],
    ['SETEX', latestPointerKey, String(BRIEF_TTL_SECONDS), latestPointerValue],
  ], 5_000, true);
  if (!pipelineResult || !Array.isArray(pipelineResult) || pipelineResult.length < 2) {
    throw new Error('null pipeline response from Upstash');
  }
  for (const cell of pipelineResult) {
    if (cell && typeof cell === 'object' && 'error' in cell) {
      throw new Error(`Upstash SETEX error: ${cell.error}`);
    }
  }

  return {
    envelope: finalEnvelope,
    chosenVariant: winner.rule.variant,
    // synthesisLevel goes here — NOT in the envelope (renderer's
    // assertNoExtraKeys would reject it).
    synthesisLevel,
    // Canonical synthesis ({lead, threads, signals, rankedStoryHashes}
    // or null for L3 stub / BRIEF_LLM_ENABLED=false).
    synthesis,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const nowMs = Date.now();
  digestRunStartedAtMs = nowMs;
  console.log('[digest] Brief run start:', new Date(nowMs).toISOString());

  // Watchlist story alerts (#4922 U3): enqueue BEFORE the brief compose so a
  // compose failure can't suppress the scan. Never throws.
  await scanAndEnqueueWatchlistStoryEvents(nowMs);

  // Default-brief pass for the single owner. The Convex user and rule lookups
  // are replaced by one compose-only rule carrying the defaults the
  // default-brief pass gave a paid user without a digest rule
  // (buildBriefOnlyRules). Whether the prose is regenerated on this pass is
  // decided inside composeBriefsForRun (briefCandidateDue → isDue, then the
  // non-due synthesis reuse window).
  const ownerRules = buildBriefOnlyRules([PERSONAL_OWNER_ID], []);
  const { composeSuccess, composeFailed } = await composeBriefsForRun(ownerRules, nowMs, {
    deadlineMs: Date.now() + BRIEF_ONLY_COMPOSE_BUDGET_MS,
  });

  // Brief-compose failure gate. Denominator is attempted writes
  // (shouldExitNonZero enforces this).
  if (shouldExitOnBriefFailures({ success: composeSuccess, failed: composeFailed })) {
    console.warn(
      `[digest] brief: exiting non-zero — compose_failed=${composeFailed} compose_success=${composeSuccess} crossed the threshold`,
    );
    await writeDigestLastRunMeta({
      startedAtMs: nowMs,
      status: 'error',
      errorReason: `brief_compose_failed:${composeFailed}:success:${composeSuccess}`,
    });
    // process.exit does not drain in-flight promises — flush fire-and-forget
    // llm_call telemetry first (bounded by the 1.5s fetch timeout).
    await flushPendingLlmEvents();
    process.exit(1);
  }

  await writeDigestLastRunMeta({ startedAtMs: nowMs });
  console.log(`=== Done (${Date.now() - nowMs}ms) ===`);
}

export {
  buildDigest,
  composeAndStoreBriefForUser,
  composeBriefsForRun,
  fetchLatestBriefEnvelope,
  getLastSentAt,
  isDue,
};

if (isMainModule(import.meta.url, process.argv[1])) {
  if (process.env.DIGEST_CRON_ENABLED === '0') {
    console.log('[digest] DIGEST_CRON_ENABLED=0 — skipping run');
    process.exit(0);
  }
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.error('[digest] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set');
    process.exit(1);
  }
  main().catch(async (err) => {
    const finishedAtMs = Date.now();
    console.error('[digest] Fatal:', err);
    await writeDigestLastRunMeta({
      startedAtMs: digestRunStartedAtMs ?? finishedAtMs,
      finishedAtMs,
      status: 'error',
      errorReason: `fatal:${err?.message ?? err}`,
    });
    await flushPendingLlmEvents();
    process.exit(1);
  });
}
