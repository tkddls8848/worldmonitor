// Tests for the three Pro-gated historical-intelligence RPCs (#5694):
//   POST /api/intelligence/v1/search-intel-history
//   GET /api/intelligence/v1/get-intel-timeline
//   POST /api/intelligence/v1/get-similar-events
//
// Two layers, mirroring the sibling suites:
//   - behavioural handler tests (store and fetch stubbed) modelled on
//     tests/china-decision-signals-handler.test.mts
//   - structural wiring assertions (proto → handler → registries) modelled on
//     tests/regional-snapshot-weekly-brief.test.mjs
//
// No network: every test stubs globalThis.fetch (embeddings + Redis cache) and
// replaces the history store through setIntelHistoryStoreForTests. One suite
// reads a real temporary SQLite store end to end. Run via `npm run test:data`.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

// The client resolves every environment variable at call time, so setting them
// here (module body runs after the import graph is evaluated, before any test
// callback) is sufficient.
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-upstash-token';

import { normalizeForEmbedding } from '../scripts/lib/brief-embedding.mjs';
import {
  EMBED_DIMS,
  EMBED_MODEL,
  OPENROUTER_EMBEDDINGS_URL,
} from '../scripts/lib/brief-dedup-consts.mjs';
import {
  INTEL_HISTORY_DIMS,
  INTEL_HISTORY_EMBED_MODEL,
  openIntelHistoryStore,
} from '../shared/intel-history-store.mjs';
import { setIntelHistoryStoreForTests } from '../server/_shared/intel-history-client';
import { normalizeQueryText } from '../server/_shared/intel-history-embed';
import { getIntelTimeline } from '../server/worldmonitor/intelligence/v1/get-intel-timeline';
import { getSimilarEvents } from '../server/worldmonitor/intelligence/v1/get-similar-events';
import { searchIntelHistory } from '../server/worldmonitor/intelligence/v1/search-intel-history';
import { validationFailure } from './helpers/validation-failure.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const ctx = {} as never;

// ── fetch harness (embeddings provider + Redis cache) ───────────────────────

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const realFetch = globalThis.fetch;
let calls: RecordedCall[] = [];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function vector(fill = 0.5): number[] {
  return new Array(EMBED_DIMS).fill(fill);
}

/**
 * Install a fetch stub that routes by URL. Each route is a function so a test
 * can throw (network failure) or return a non-ok Response.
 */
function stubFetch(routes: Record<string, (call: RecordedCall) => Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    const call: RecordedCall = { url, method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    const route = routes[url];
    if (!route && url.startsWith('https://fake-upstash.upstash.io/get/')) return jsonResponse({ result: null });
    if (!route && url === 'https://fake-upstash.upstash.io/') return jsonResponse({ result: 'OK' });
    if (!route) throw new Error(`unstubbed fetch: ${url}`);
    return route(call);
  }) as typeof globalThis.fetch;
}

function embeddingsOk(): Response {
  return jsonResponse({ data: [{ index: 0, embedding: vector() }] });
}

// ── store harness ───────────────────────────────────────────────────────────

type StoreArgs = Record<string, unknown>;
type StoreResult = Record<string, unknown>;
let storeCalls: Array<{ op: 'timeline' | 'search'; args: StoreArgs }> = [];

/** Replace the history store; each op returns its result or throws. */
function stubStore(ops: {
  timeline?: (args: StoreArgs) => StoreResult;
  search?: (args: StoreArgs) => StoreResult;
}): void {
  const unexpected = (op: string) => () => { throw new Error(`unexpected store ${op}`); };
  setIntelHistoryStoreForTests({
    timeline: ((args: StoreArgs) => {
      storeCalls.push({ op: 'timeline', args });
      return (ops.timeline ?? unexpected('timeline'))(args);
    }) as never,
    search: ((args: StoreArgs) => {
      storeCalls.push({ op: 'search', args });
      return (ops.search ?? unexpected('search'))(args);
    }) as never,
  });
}

const lastStoreCall = (op: 'timeline' | 'search') => storeCalls.filter((c) => c.op === op).at(-1);

const storeRecord = {
  id: '1',
  domain: 'conflict',
  resource: 'acled-events',
  country: 'UA',
  category: 'battle',
  title: 'Shelling near Kharkiv',
  summary: 'Sustained artillery fire reported overnight.',
  sourceUrl: 'https://example.test/a',
  occurredAt: 1_750_000_000_000,
  ingestedAt: 1_750_000_060_000,
  runId: 'run-1',
  dedupeKey: 'conflict:acled:1',
  score: 0.83,
};

beforeEach(() => {
  calls = [];
  storeCalls = [];
  // Unstubbed store reads fail loudly rather than touching a real database.
  stubStore({});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setIntelHistoryStoreForTests(null);
});

// ── normalization parity ────────────────────────────────────────────────────

describe('query-time normalization parity', () => {
  // The seed writer embeds normalizeForEmbedding(title + summary); the query
  // side must apply the identical transform or recall silently degrades.
  // normalizeForEmbedding itself lives in a node:crypto-importing module that
  // cannot load on the Vercel Edge runtime, so the edge copy is re-derived —
  // this test is the drift guard for that duplication.
  const fixtures = [
    'Shelling near Kharkiv',
    '  MULTIPLE   spaces\tand\ntabs  ',
    'Oil tanker seized in the Strait of Hormuz - Reuters',
    'Cyber incident at a utility — bbc.com',
    'Port strike in Rotterdam',
    '',
  ];

  for (const fixture of fixtures) {
    it(`matches normalizeForEmbedding for ${JSON.stringify(fixture)}`, () => {
      assert.equal(normalizeQueryText(fixture), normalizeForEmbedding(fixture));
    });
  }
});

// ── scope normalization ─────────────────────────────────────────────────────

describe('scope normalization', () => {
  // The store compares scope values with = against what the seeders wrote, so
  // a lower-case or padded country silently matches nothing — indistinguishable,
  // to the caller, from "we have no history for that country".
  it('upper-cases and trims country before querying', async () => {
    stubFetch({});
    stubStore({ timeline: () => ({ records: [storeRecord], partial: false, nextCursor: null }) });

    await getIntelTimeline(ctx, { domain: '', country: ' ua ', from: 0, to: 0, limit: 0 });

    assert.equal(lastStoreCall('timeline')?.args.country, 'UA');
  });

  it('lower-cases and trims domain before querying', async () => {
    stubFetch({});
    stubStore({ timeline: () => ({ records: [], partial: false, nextCursor: null }) });

    await getIntelTimeline(ctx, { domain: ' Conflict ', country: '', from: 0, to: 0, limit: 0 });

    assert.equal(lastStoreCall('timeline')?.args.domain, 'conflict');
  });

  it('rejects negative bounds before reading the store', async () => {
    stubFetch({});
    await assert.rejects(getIntelTimeline(ctx, {
      domain: 'conflict',
      country: '',
      from: -86_400_000,
      to: 0,
      limit: 0,
    }), validationFailure('from', /must be an integer/i));
    assert.equal(calls.length, 0);
    assert.equal(storeCalls.length, 0);
  });

  // Whitespace must not satisfy the "at least one scope" requirement and then
  // match nothing downstream.
  it('rejects a whitespace-only scope as unscoped', async () => {
    stubFetch({});
    await assert.rejects(
      getIntelTimeline(ctx, { domain: '   ', country: '  ', from: 0, to: 0, limit: 0 }),
      validationFailure('domain', /at least one of domain or country/i),
    );
    assert.equal(calls.length, 0, 'no upstream call for an unscoped read');
    assert.equal(storeCalls.length, 0);
  });

  it('rejects invalid domains, countries, inverted bounds, and excessive limits', async () => {
    stubFetch({});
    const invalidRequests = [
      ['domain', { domain: 'cyber', country: '', from: 0, to: 0, limit: 0 }],
      ['country', { domain: 'conflict', country: 'U1', from: 0, to: 0, limit: 0 }],
      ['from', { domain: 'conflict', country: '', from: 2, to: 1, limit: 0 }],
      ['limit', { domain: 'conflict', country: '', from: 0, to: 0, limit: 201 }],
    ] as const;
    for (const [field, request] of invalidRequests) {
      await assert.rejects(getIntelTimeline(ctx, request), validationFailure(field));
    }
    assert.equal(calls.length, 0);
    assert.equal(storeCalls.length, 0);
  });
});

// ── embedding dimension parity ──────────────────────────────────────────────

describe('embedding dimension contract', () => {
  // The seeder embeds at EMBED_DIMS and the store validates every stored and
  // query vector against INTEL_HISTORY_DIMS. A mismatch is not a type error —
  // it surfaces as every insert being rejected at runtime.
  it('pins EMBED_DIMS and INTEL_HISTORY_DIMS together', () => {
    assert.equal(INTEL_HISTORY_DIMS, EMBED_DIMS);
  });

  // The per-row stamp (#5742) names the space every stored vector lives in.
  // It must be the seeder's model@dims literally, or a model swap on one side
  // would stamp rows as current while embedding them in another space.
  it('pins INTEL_HISTORY_EMBED_MODEL to the seeder model and dimension', () => {
    assert.equal(INTEL_HISTORY_EMBED_MODEL, `${EMBED_MODEL}@${EMBED_DIMS}`);
  });
});

// ── query-vector cache ──────────────────────────────────────────────────────

describe('query-vector cache', () => {
  // Every miss spends a paid OpenRouter call on an interactive request, so the
  // hit path has to actually skip the provider — and a cache entry that no
  // longer matches the index contract has to be ignored rather than forwarded
  // to the store, which would reject it and surface as a false outage.
  const upstashGet = (key: string) =>
    `https://fake-upstash.upstash.io/get/${encodeURIComponent(key)}`;
  // The query text is hashed into the key, never stored verbatim — what an
  // analyst searches for must not be readable from a Redis key listing.
  const sha256Hex = async (text: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  };
  const cacheKeyFor = async (text: string) =>
    `intel-history:embed:v1:openai/text-embedding-3-small:${EMBED_DIMS}:${await sha256Hex(normalizeQueryText(text))}`;

  it('serves a cached vector without calling the embeddings provider', async () => {
    const query = 'artillery strikes near Kharkiv';
    stubFetch({
      [upstashGet(await cacheKeyFor(query))]: () =>
        jsonResponse({ result: JSON.stringify(vector(0.25)) }),
    });
    stubStore({ search: () => ({ records: [storeRecord], partial: false }) });

    const res = await searchIntelHistory(ctx, {
      query,
      domain: '',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, false);
    assert.equal(
      calls.filter((c) => c.url === OPENROUTER_EMBEDDINGS_URL).length,
      0,
      'a cache hit must not reach the embeddings provider',
    );
    assert.deepEqual(lastStoreCall('search')?.args.vector, vector(0.25));
  });

  it('writes the provider vector back to the cache on a miss', async () => {
    const query = 'port strike in Rotterdam';
    // setCachedJson issues an atomic `SET key value EX ttl` as a command array
    // POSTed to the Upstash base URL (not a /set/ path), so match on that.
    const writes: unknown[][] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://fake-upstash.upstash.io/get/')) {
        return jsonResponse({ result: null });
      }
      if (url === 'https://fake-upstash.upstash.io/' && init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)) as unknown[]);
        return jsonResponse({ result: 'OK' });
      }
      if (url === OPENROUTER_EMBEDDINGS_URL) return embeddingsOk();
      throw new Error(`unstubbed fetch: ${url}`);
    }) as typeof globalThis.fetch;
    stubStore({ search: () => ({ records: [], partial: false }) });

    const res = await searchIntelHistory(ctx, {
      query,
      domain: '',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, false);
    const embedWrites = writes.filter((write) => String(write[1]).startsWith('intel-history:embed:'));
    assert.equal(embedWrites.length, 1, 'a miss must populate the embedding cache');
    const [verb, key, value, ex, ttl] = embedWrites[0] as string[];
    assert.equal(verb, 'SET');
    assert.equal(key, await cacheKeyFor(query), 'key carries hashed query, model, dimension');
    assert.ok(!key.includes('rotterdam'), 'raw query text must never appear in the cache key');
    assert.deepEqual(JSON.parse(value), vector());
    assert.equal(ex, 'EX');
    assert.equal(Number(ttl), 6 * 60 * 60);
  });

  it('re-embeds when the cached entry has the wrong dimension', async () => {
    const query = 'cyber incident at a utility';
    stubFetch({
      [upstashGet(await cacheKeyFor(query))]: () =>
        jsonResponse({ result: JSON.stringify([0.1, 0.2, 0.3]) }),
      [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk,
    });
    stubStore({ search: () => ({ records: [], partial: false }) });

    const res = await searchIntelHistory(ctx, {
      query,
      domain: '',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, false);
    assert.equal(
      calls.filter((c) => c.url === OPENROUTER_EMBEDDINGS_URL).length,
      1,
      'an unusable cache entry must fall through to the provider',
    );
    assert.equal((lastStoreCall('search')?.args.vector as number[])?.length, EMBED_DIMS);
  });
});

// ── SearchIntelHistory ──────────────────────────────────────────────────────

describe('searchIntelHistory handler', () => {
  it('rejects missing or oversized query text before invoking paid upstreams', async () => {
    stubFetch({});
    await assert.rejects(searchIntelHistory(ctx, {
      query: '', domain: '', country: '', from: 0, to: 0, limit: 0,
    }), validationFailure('query', /must be between/i));
    await assert.rejects(searchIntelHistory(ctx, {
      query: 'x'.repeat(501), domain: '', country: '', from: 0, to: 0, limit: 0,
    }), validationFailure('query', /must be between/i));
    assert.equal(calls.length, 0);
    assert.equal(storeCalls.length, 0);
  });

  it('embeds the query and maps store records onto the proto shape', async () => {
    stubFetch({ [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk });
    stubStore({ search: () => ({ records: [storeRecord], partial: false }) });

    const res = await searchIntelHistory(ctx, {
      query: 'artillery strikes near Kharkiv',
      domain: 'conflict',
      country: 'UA',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, false);
    assert.equal(res.query, 'artillery strikes near Kharkiv');
    assert.equal(res.records.length, 1);
    assert.deepEqual(res.records[0], {
      id: '1',
      domain: 'conflict',
      resource: 'acled-events',
      country: 'UA',
      category: 'battle',
      title: 'Shelling near Kharkiv',
      summary: 'Sustained artillery fire reported overnight.',
      sourceUrl: 'https://example.test/a',
      occurredAt: 1_750_000_000_000,
      ingestedAt: 1_750_000_060_000,
      score: 0.83,
    });
  });

  it('passes the query vector and the resolved scope to the store search', async () => {
    stubFetch({ [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk });
    stubStore({ search: () => ({ records: [], partial: false }) });

    await searchIntelHistory(ctx, {
      query: 'grain corridor disruption',
      domain: 'conflict',
      country: 'UA',
      from: 1_700_000_000_000,
      to: 1_760_000_000_000,
      limit: 5,
    });

    assert.deepEqual(lastStoreCall('search')?.args, {
      vector: vector(),
      domain: 'conflict',
      country: 'UA',
      from: 1_700_000_000_000,
      to: 1_760_000_000_000,
      limit: 5,
    });
  });

  it('passes the store partial flag through', async () => {
    stubFetch({ [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk });
    stubStore({ search: () => ({ records: [storeRecord], partial: true }) });

    const res = await searchIntelHistory(ctx, { query: 'artillery', domain: '', country: '', from: 0, to: 0, limit: 0 });
    assert.equal(res.partial, true);
    assert.equal(res.upstreamUnavailable, false);
  });

  it('defaults limit to 20 and rejects values above 64', async () => {
    stubFetch({ [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk });
    stubStore({ search: () => ({ records: [], partial: false }) });

    await searchIntelHistory(ctx, { query: 'ab', domain: '', country: '', from: 0, to: 0, limit: 0 });
    assert.equal(lastStoreCall('search')?.args.limit, 20);

    calls = [];
    await assert.rejects(
      searchIntelHistory(ctx, { query: 'ab', domain: '', country: '', from: 0, to: 0, limit: 999 }),
      validationFailure('limit', /must be an integer/i),
    );
  });

  it('omits empty optional scope fields from the store arguments', async () => {
    stubFetch({ [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk });
    stubStore({ search: () => ({ records: [], partial: false }) });

    await searchIntelHistory(ctx, { query: 'anything', domain: '', country: '', from: 0, to: 0, limit: 3 });

    assert.deepEqual(Object.keys(lastStoreCall('search')?.args ?? {}).sort(), ['limit', 'vector']);
  });

  it('reports upstreamUnavailable when the embeddings provider fails', async () => {
    stubFetch({ [OPENROUTER_EMBEDDINGS_URL]: () => jsonResponse({ error: 'nope' }, 502) });
    stubStore({ search: () => ({ records: [storeRecord], partial: false }) });

    const res = await searchIntelHistory(ctx, {
      query: 'artillery strikes',
      domain: '',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, true);
    assert.deepEqual(res.records, []);
    // The store read must never run on an embedding failure — a zero vector
    // would return arbitrary "most similar" rows presented as real matches.
    assert.equal(storeCalls.length, 0);
  });

  it('reports upstreamUnavailable when the store read throws', async () => {
    stubFetch({ [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk });
    stubStore({ search: () => { throw new Error('database disk image is malformed'); } });

    const res = await searchIntelHistory(ctx, {
      query: 'artillery strikes',
      domain: '',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, true);
    assert.deepEqual(res.records, []);
  });

  it('reports upstreamUnavailable when the store returns a malformed body', async () => {
    stubFetch({ [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk });
    stubStore({ search: () => ({ partial: false }) });

    const res = await searchIntelHistory(ctx, { query: 'artillery', domain: '', country: '', from: 0, to: 0, limit: 0 });
    assert.equal(res.upstreamUnavailable, true);
  });

  it('rejects a wrong-dimension embedding rather than sending it to the store', async () => {
    stubFetch({
      [OPENROUTER_EMBEDDINGS_URL]: () => jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
    });
    stubStore({ search: () => ({ records: [storeRecord], partial: false }) });

    const res = await searchIntelHistory(ctx, {
      query: 'artillery strikes',
      domain: '',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, true);
    assert.equal(storeCalls.length, 0);
  });
});

// ── GetIntelTimeline ────────────────────────────────────────────────────────

describe('getIntelTimeline handler', () => {
  it('forwards continuation cursors and returns the next page cursor', async () => {
    stubFetch({});
    stubStore({ timeline: () => ({ records: [storeRecord], partial: true, nextCursor: 'next-page' }) });
    const res = await getIntelTimeline(ctx, {
      domain: 'conflict', country: '', from: 0, to: 0, limit: 2, cursor: 'previous-page',
    });
    assert.equal(lastStoreCall('timeline')?.args.cursor, 'previous-page');
    assert.equal(res.nextCursor, 'next-page');
    assert.equal(res.partial, true);
  });

  it('rejects oversized cursors before any store read', async () => {
    stubFetch({});
    await assert.rejects(getIntelTimeline(ctx, {
      domain: 'conflict', country: '', from: 0, to: 0, limit: 0, cursor: 'x'.repeat(4097),
    }), validationFailure('cursor', /4096/));
    assert.equal(calls.length, 0);
    assert.equal(storeCalls.length, 0);
  });

  it('reports an invalid store cursor as a request error', async () => {
    stubFetch({});
    stubStore({
      timeline: () => {
        throw Object.assign(new Error('Invalid cursor.'), { name: 'ValidationError', field: 'cursor' });
      },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(getIntelTimeline(ctx, {
        domain: 'conflict', country: '', from: 0, to: 0, limit: 0, cursor: 'invalid',
      }), validationFailure('cursor', /invalid/i));
    }
  });

  it('maps the final page (null cursor) to an empty nextCursor', async () => {
    stubFetch({});
    stubStore({ timeline: () => ({ records: [storeRecord], partial: false, nextCursor: null }) });
    const res = await getIntelTimeline(ctx, { domain: 'conflict', country: '', from: 0, to: 0, limit: 2 });
    assert.equal(res.upstreamUnavailable, false);
    assert.equal(res.nextCursor, '');
    assert.equal(res.records.length, 1);
  });

  it('keeps continuation pages in separate opaque cache keys', async () => {
    stubFetch({});
    stubStore({ timeline: () => ({ records: [], partial: false, nextCursor: null }) });
    const scope = { domain: 'conflict', country: 'UA', from: 0, to: 0, limit: 2 };
    await getIntelTimeline(ctx, scope);
    await getIntelTimeline(ctx, { ...scope, cursor: 'opaque-next' });
    const cacheKeys = calls.filter((call) => call.url.startsWith('https://fake-upstash.upstash.io/get/')).map((call) => call.url);
    assert.equal(cacheKeys.length, 2);
    assert.notEqual(cacheKeys[0], cacheKeys[1]);
    assert.ok(cacheKeys.every((key) => !key.includes('opaque-next')));
  });

  it('preserves continuation after an empty bounded page', async () => {
    stubFetch({});
    stubStore({ timeline: () => ({ records: [], partial: true, nextCursor: 'older-events' }) });
    const res = await getIntelTimeline(ctx, { domain: 'conflict', country: 'UA', from: 0, to: 0, limit: 1 });
    assert.equal(res.upstreamUnavailable, false);
    assert.deepEqual(res.records, []);
    assert.equal(res.nextCursor, 'older-events');
  });

  it('fails closed when a store omits continuation metadata', async () => {
    stubFetch({});
    stubStore({ timeline: () => ({ records: [storeRecord], partial: false }) });
    const res = await getIntelTimeline(ctx, { domain: 'conflict', country: '', from: 0, to: 0, limit: 2 });
    assert.deepEqual(res, { records: [], partial: false, upstreamUnavailable: true, nextCursor: '' });
  });

  it('reads the store chronologically without paying for an embedding', async () => {
    const { score: _score, ...timelineRecord } = storeRecord;
    stubFetch({});
    stubStore({ timeline: () => ({ records: [timelineRecord], partial: false, nextCursor: null }) });

    const res = await getIntelTimeline(ctx, {
      domain: 'conflict',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });

    assert.equal(res.upstreamUnavailable, false);
    assert.equal(res.records.length, 1);
    // No similarity applies to a chronological read.
    assert.equal(res.records[0]?.score, 0);
    assert.equal(calls.some((c) => c.url === OPENROUTER_EMBEDDINGS_URL), false);
    assert.deepEqual(lastStoreCall('timeline')?.args, { domain: 'conflict', limit: 50 });
  });

  it('rejects an unscoped read with a field-level validation error before any store read', async () => {
    stubFetch({});

    await assert.rejects(
      () => getIntelTimeline(ctx, { domain: '', country: '', from: 0, to: 0, limit: 0 }),
      validationFailure('domain', /domain or country/i),
    );
    assert.equal(calls.length, 0);
    assert.equal(storeCalls.length, 0);
  });

  it('accepts a country-only scope', async () => {
    stubFetch({});
    stubStore({ timeline: () => ({ records: [], partial: false, nextCursor: null }) });

    await getIntelTimeline(ctx, { domain: '', country: 'UA', from: 0, to: 0, limit: 0 });
    assert.deepEqual(lastStoreCall('timeline')?.args, { country: 'UA', limit: 50 });
  });

  it('defaults limit to 50 and rejects values above 200', async () => {
    stubFetch({});
    stubStore({ timeline: () => ({ records: [], partial: false, nextCursor: null }) });

    await getIntelTimeline(ctx, { domain: 'energy', country: '', from: 0, to: 0, limit: 0 });
    assert.equal(lastStoreCall('timeline')?.args.limit, 50);

    calls = [];
    await assert.rejects(
      getIntelTimeline(ctx, { domain: 'energy', country: '', from: 0, to: 0, limit: 5_000 }),
      validationFailure('limit', /must be an integer/i),
    );
  });

  it('reports upstreamUnavailable when the store read throws', async () => {
    stubFetch({});
    stubStore({ timeline: () => { throw new Error('unable to open database file'); } });

    const res = await getIntelTimeline(ctx, {
      domain: 'energy',
      country: '',
      from: 0,
      to: 0,
      limit: 0,
    });
    assert.equal(res.upstreamUnavailable, true);
    assert.deepEqual(res.records, []);
  });
});

// ── GetSimilarEvents ────────────────────────────────────────────────────────

describe('getSimilarEvents handler', () => {
  it('rejects missing or oversized situation text before invoking paid upstreams', async () => {
    stubFetch({});
    await assert.rejects(getSimilarEvents(ctx, {
      situation: 'short', domain: '', country: '', limit: 0,
    }), validationFailure('situation', /must be between/i));
    await assert.rejects(getSimilarEvents(ctx, {
      situation: 'x'.repeat(1001), domain: '', country: '', limit: 0,
    }), validationFailure('situation', /must be between/i));
    assert.equal(calls.length, 0);
    assert.equal(storeCalls.length, 0);
  });

  it('embeds the situation text and echoes it back with the matches', async () => {
    stubFetch({ [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk });
    stubStore({ search: () => ({ records: [storeRecord], partial: false }) });

    const situation = 'A naval blockade closes a major grain export corridor for several weeks.';
    const res = await getSimilarEvents(ctx, { situation, domain: '', country: '', limit: 0 });

    assert.equal(res.situation, situation);
    assert.equal(res.upstreamUnavailable, false);
    assert.equal(res.records.length, 1);
    assert.equal(res.records[0]?.score, 0.83);
    // Default limit is 10 — half of search's default, since precedent lookups
    // are read by a human or an LLM rather than scrolled.
    assert.equal(lastStoreCall('search')?.args.limit, 10);
    assert.equal(lastStoreCall('search')?.args.minScore, 0.55);
  });

  it('rejects limits above 32', async () => {
    stubFetch({ [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk });
    stubStore({ search: () => ({ records: [], partial: false }) });

    await assert.rejects(getSimilarEvents(ctx, {
      situation: 'A naval blockade closes a grain export corridor.',
      domain: '',
      country: '',
      limit: 512,
    }), validationFailure('limit', /must be an integer/i));
  });

  it('reports upstreamUnavailable when the embeddings provider fails', async () => {
    stubFetch({
      [OPENROUTER_EMBEDDINGS_URL]: () => {
        throw new TypeError('fetch failed');
      },
    });
    stubStore({ search: () => ({ records: [storeRecord], partial: false }) });

    const res = await getSimilarEvents(ctx, {
      situation: 'A naval blockade closes a grain export corridor.',
      domain: '',
      country: '',
      limit: 0,
    });
    assert.equal(res.upstreamUnavailable, true);
    assert.deepEqual(res.records, []);
  });
});

// ── Real SQLite store, end to end ───────────────────────────────────────────

describe('handlers over a real SQLite store', () => {
  const T = 1_780_000_000_000;
  let dir = '';

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function seededStore() {
    dir = mkdtempSync(join(tmpdir(), 'intel-history-endpoints-'));
    const file = join(dir, 'history.sqlite');
    const writer = openIntelHistoryStore(file, { now: () => T });
    const axis = (i: number) => { const v = new Array(INTEL_HISTORY_DIMS).fill(0); v[i] = 1; return v; };
    writer.append({
      domain: 'conflict',
      resource: 'acled',
      runId: 'run-1',
      records: [
        { dedupeKey: 'c:1', title: 'Missile strike on port', country: 'UA', occurredAt: T - 3, embedding: vector() },
        { dedupeKey: 'c:2', title: 'Ceasefire talks', country: 'UA', occurredAt: T - 2, embedding: axis(7) },
        { dedupeKey: 'c:3', title: 'Border clash', country: 'IN', occurredAt: T - 1, embedding: axis(9) },
      ],
    });
    writer.close();
    const reader = openIntelHistoryStore(file, { readOnly: true });
    setIntelHistoryStoreForTests(reader);
    return reader;
  }

  it('pages the timeline through opaque cursors to the end', async () => {
    const reader = seededStore();
    // A scope no other test uses: the read cache keeps process-local copies.
    const scope = { domain: 'conflict', country: '', from: T - 10, to: T, limit: 2 };
    try {
      stubFetch({});
      const first = await getIntelTimeline(ctx, scope);
      assert.deepEqual(first.records.map((r) => r.title), ['Border clash', 'Ceasefire talks']);
      assert.notEqual(first.nextCursor, '');
      const second = await getIntelTimeline(ctx, { ...scope, cursor: first.nextCursor });
      assert.deepEqual(second.records.map((r) => r.title), ['Missile strike on port']);
      assert.equal(second.nextCursor, '');
      await assert.rejects(
        getIntelTimeline(ctx, { ...scope, cursor: 'forged' }),
        validationFailure('cursor', /invalid/i),
      );
    } finally {
      reader.close();
    }
  });

  it('ranks search results by cosine similarity to the query vector', async () => {
    const reader = seededStore();
    try {
      stubFetch({ [OPENROUTER_EMBEDDINGS_URL]: embeddingsOk });
      const res = await searchIntelHistory(ctx, { query: 'missile strike', domain: 'conflict', country: 'UA', from: 0, to: 0, limit: 0 });
      assert.equal(res.upstreamUnavailable, false);
      assert.deepEqual(res.records.map((r) => r.title), ['Missile strike on port', 'Ceasefire talks']);
      assert.ok(Math.abs((res.records[0]?.score ?? 0) - 1) < 1e-6);
      assert.equal(res.partial, false);
    } finally {
      reader.close();
    }
  });
});

// ── Structural wiring ───────────────────────────────────────────────────────

const read = (rel: string): string => readFileSync(resolve(root, rel), 'utf-8');

const serviceProtoSrc = read('proto/worldmonitor/intelligence/v1/service.proto');
const recordProtoSrc = read('proto/worldmonitor/intelligence/v1/intel_history_record.proto');
const searchProtoSrc = read('proto/worldmonitor/intelligence/v1/search_intel_history.proto');
const timelineProtoSrc = read('proto/worldmonitor/intelligence/v1/get_intel_timeline.proto');
const similarProtoSrc = read('proto/worldmonitor/intelligence/v1/get_similar_events.proto');
const handlerIndexSrc = read('server/worldmonitor/intelligence/v1/handler.ts');
const gatewaySrc = read('server/gateway.ts');
const openApiJson = JSON.parse(read('docs/api/IntelligenceService.openapi.json')) as {
  paths: Record<string, Record<string, unknown>>;
};

const RPCS = [
  {
    rpc: 'SearchIntelHistory',
    file: 'search_intel_history',
    path: '/api/intelligence/v1/search-intel-history',
  },
  {
    rpc: 'GetIntelTimeline',
    file: 'get_intel_timeline',
    path: '/api/intelligence/v1/get-intel-timeline',
  },
  {
    rpc: 'GetSimilarEvents',
    file: 'get_similar_events',
    path: '/api/intelligence/v1/get-similar-events',
  },
] as const;

describe('proto definitions', () => {
  it('defines the shared IntelHistoryRecord once', () => {
    assert.match(recordProtoSrc, /message IntelHistoryRecord/);
    assert.match(recordProtoSrc, /int64 occurred_at = 9 \[\(sebuf\.http\.int64_encoding\) = INT64_ENCODING_NUMBER\]/);
    assert.match(recordProtoSrc, /int64 ingested_at = 10 \[\(sebuf\.http\.int64_encoding\) = INT64_ENCODING_NUMBER\]/);
    assert.match(recordProtoSrc, /double score = 11/);
    // Defined once, reused by all three request files (satellite.proto pattern).
    assert.equal(/message IntelHistoryRecord/.test(searchProtoSrc), false);
    for (const src of [searchProtoSrc, timelineProtoSrc, similarProtoSrc]) {
      assert.match(src, /import "worldmonitor\/intelligence\/v1\/intel_history_record\.proto"/);
    }
  });

  for (const { rpc, file } of RPCS) {
  it(`declares ${rpc} in service.proto`, () => {
      assert.match(
        serviceProtoSrc,
        new RegExp(`rpc ${rpc}\\(${rpc}Request\\) returns \\(${rpc}Response\\)`),
      );
      assert.match(serviceProtoSrc, new RegExp(`import "worldmonitor/intelligence/v1/${file}\\.proto"`));
    });
  }

  it('signals upstream failure with a declared proto field, not an out-of-band cast', () => {
    for (const src of [searchProtoSrc, timelineProtoSrc, similarProtoSrc]) {
      assert.match(src, /bool upstream_unavailable = \d+/);
    }
  });

  it('constrains the free-text inputs', () => {
    assert.match(searchProtoSrc, /\(buf\.validate\.field\)\.string\.min_len = 2/);
    assert.match(searchProtoSrc, /\(buf\.validate\.field\)\.string\.max_len = 500/);
    assert.match(similarProtoSrc, /\(buf\.validate\.field\)\.string\.min_len = 10/);
    assert.match(similarProtoSrc, /\(buf\.validate\.field\)\.string\.max_len = 1000/);
  });

  it('caps limit at the ceilings the history store enforces', () => {
    assert.match(searchProtoSrc, /\(buf\.validate\.field\)\.int32\.lte = 64/);
    assert.match(timelineProtoSrc, /\(buf\.validate\.field\)\.int32\.lte = 200/);
    assert.match(similarProtoSrc, /\(buf\.validate\.field\)\.int32\.lte = 32/);
  });
});

describe('handler registration', () => {
  it('registers all three handlers in handler.ts', () => {
    for (const name of ['searchIntelHistory', 'getIntelTimeline', 'getSimilarEvents']) {
      assert.match(handlerIndexSrc, new RegExp(`import \\{ ${name} \\} from`));
      assert.match(handlerIndexSrc, new RegExp(`\\s+${name},`));
    }
  });
});

describe('gateway wiring', () => {
  it('assigns the GET timeline route a slow gateway cache tier', () => {
    assert.match(
      gatewaySrc,
      /'\/api\/intelligence\/v1\/get-intel-timeline':\s*'slow'/,
    );
  });

  it('does not register POST semantic reads in the GET-only gateway cache tier map', () => {
    for (const path of [
      '/api/intelligence/v1/search-intel-history',
      '/api/intelligence/v1/get-similar-events',
    ]) {
      assert.doesNotMatch(gatewaySrc, new RegExp(`'${path}':\\s*'slow'`));
    }
  });

});

describe('generated OpenAPI', () => {
  for (const { path } of RPCS) {
  it(`publishes the expected method for ${path}`, () => {
      assert.ok(openApiJson.paths[path], `${path} missing from IntelligenceService.openapi.json`);
      const method = path.includes('search-intel-history') || path.includes('get-similar-events') ? 'post' : 'get';
      assert.ok(openApiJson.paths[path]?.[method], `${path} must be a ${method.toUpperCase()} operation`);
    });
  }
});

// captureSilentError is a no-op under NODE_TEST_CONTEXT, so pin the Sentry
// tagging in source the same way api/miit-news.test.mjs does.
describe('Sentry capture gates', () => {
  it('tags store read failures for Sentry', () => {
    const src = readFileSync(resolve(root, 'server/_shared/intel-history-client.ts'), 'utf8');
    assert.match(src, /captureSilentError\(err/);
    assert.match(src, /stage: 'store-read'/);
  });

  it('downgrades AbortSignal.timeout captures on the embeddings path', () => {
    const src = readFileSync(resolve(root, 'server/_shared/intel-history-embed.ts'), 'utf8');
    assert.match(src, /errName === 'AbortError' \|\| errName === 'TimeoutError'/);
    assert.match(src, /isTransientTimeout \? \{ level: 'warning' \} : \{\}/);
    assert.match(src, /stage: 'embed'/);
  });
});
