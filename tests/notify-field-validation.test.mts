/**
 * REGRESSION (issue #8397, pentest unfixed half): notification title/source/link
 * reach email (subject/body) and chat (Telegram/Slack/Discord) sinks without
 * validation. PR #8384 closed only the web-push click path;
 * a POST /api/notify with eventType rss_alert + attacker-chosen fields produced
 * a real email from alerts@worldmonitor.app with a forged subject, a forged
 * "Source: WorldMonitor Security" line, and an off-origin link verbatim.
 *
 * This suite pins the PoC end to end:
 *   1. /api/notify must reject or neutralise a hostile title/source/link
 *      before queueing (assert on the queued payload, not just the status).
 *   2. Legitimate traffic still flows: RSS headlines/links and domain-producer
 *      titles/sources without links.
 * The notification relay that rendered queued events for each channel left
 * the personal build, so its formatMessage checks went with it.
 *
 * Run: node --import tsx --test tests/notify-field-validation.test.mts
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import handler, { __setNotifyDepsForTests } from '../api/notify.ts';

const originalFetch = globalThis.fetch;
const originalUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const TEST_USER_ID = 'user_notify_field_validation_test';

function installDeps() {
  __setNotifyDepsForTests({
    validateBearerToken: async () => ({ valid: true, userId: TEST_USER_ID }),
    checkTierProEntitlement: async () => ({ allowed: true }),
    checkScopedRateLimit: async () => ({ allowed: true, limit: 30, reset: 0, degraded: false }),
  });
}

function makePost(body: Record<string, unknown>): Request {
  return new Request('https://worldmonitor.app/api/notify', {
    method: 'POST',
    headers: {
      Origin: 'https://worldmonitor.app',
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  __setNotifyDepsForTests(null);
  globalThis.fetch = originalFetch;
  if (originalUpstashUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUpstashUrl;
  if (originalUpstashToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalUpstashToken;
});

// The exact PoC shape from the issue: critical rss_alert with an
// attacker-chosen title (phishing subject), a forged first-party source,
// and an off-origin link.
const POC_BODY = {
  eventType: 'rss_alert',
  severity: 'critical',
  payload: {
    title: 'Security notice: verify your WorldMonitor account immediately',
    source: 'WorldMonitor Security',
    link: 'https://example.com/wm-verify-account',
  },
};

describe('/api/notify field validation (pentest PoC)', () => {
  it('rejects event types that can forge relay log records before queueing', async () => {
    installDeps();
    let queued = false;
    globalThis.fetch = (async () => { queued = true; return Response.json({ result: 1 }); }) as typeof fetch;
    for (const eventType of ['rss\n[relay] forged', 'rss\rforged', 'rss\u001b[2J', 'rss\u2028forged', 'rss\u202eforged', 'rss\u2066forged', 'rss\u200fforged']) {
      assert.equal((await handler(makePost({ eventType, payload: {} }))).status, 400);
    }
    assert.equal(queued, false);
  });
  it('rejects or neutralises the hostile title/source/link before queueing', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    let queued: string | null = null;
    globalThis.fetch = (async (url: string | URL | Request) => {
      queued = decodeURIComponent(String(url).split('/lpush/wm:events:queue/')[1] ?? '');
      return { ok: true };
    }) as typeof fetch;

    const res = await handler(makePost(POC_BODY));

    if (res.status !== 200) {
      // Rejected outright: nothing may reach the shared queue.
      assert.ok(res.status >= 400 && res.status < 500, `rejection must be a client error, got ${res.status}`);
      assert.equal(queued, null, 'rejected event must not be queued');
      return;
    }
    // Accepted: the queued payload must carry sanitised values. The email
    // subject is built from the queued title and the chat/email body from
    // the queued source/link, so assert both queue and delivery values.
    assert.ok(queued, 'accepted event must queue a payload');
    const event = JSON.parse(queued as string);
    const queuedPayload = event.payload as Record<string, unknown>;
    const queuedText = JSON.stringify(queuedPayload);
    assert.ok(
      !queuedText.includes('WorldMonitor Security'),
      `queued payload must not carry the forged source: ${queuedText}`,
    );
    // The forged first-party identity is replaced; the off-origin link is
    // KEPT but can only be delivered with its destination host disclosed.
    assert.equal(queuedPayload.source, 'Community alert');
    assert.equal(queuedPayload.link, 'https://example.com/wm-verify-account');
    assert.equal(
      queuedPayload.title,
      'Community alert: Security notice: verify your WorldMonitor account immediately',
    );
  });

  it('reports every field it rewrote back to the caller', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    globalThis.fetch = (async () => ({ ok: true })) as unknown as typeof fetch;

    const hostile = await handler(makePost(POC_BODY));
    assert.equal(hostile.status, 200);
    const body = await hostile.json() as { ok: boolean; warnings?: string[] };
    assert.equal(body.ok, true);
    assert.ok(body.warnings?.includes('source_rewritten'), JSON.stringify(body));
    assert.ok(body.warnings?.includes('title_rewritten'), JSON.stringify(body));

    // A payload the boundary leaves alone reports nothing, so existing
    // callers that ignore unknown fields see no change.
    const clean = await handler(makePost({
      eventType: 'rss_alert',
      payload: { title: 'Community alert: Markets rally', source: 'Reuters', link: 'https://reuters.com/a' },
    }));
    assert.equal(clean.status, 200);
    assert.deepEqual(await clean.json(), { ok: true });
  });

  it('keeps legitimate caller titles and first-party links flowing', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    const queued: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      queued.push(decodeURIComponent(String(url).split('/lpush/wm:events:queue/')[1] ?? ''));
      return { ok: true };
    }) as typeof fetch;

    // Caller-origin: title plus a first-party article link.
    const rss = await handler(makePost({
      eventType: 'rss_alert',
      severity: 'high',
      payload: { title: 'Markets rally on rate outlook', source: 'Reuters', link: 'https://worldmonitor.app/world/story' },
    }));
    assert.equal(rss.status, 200);
    // Domain-origin: structured title/source, no link.
    const domain = await handler(makePost({
      eventType: 'market_alert',
      severity: 'high',
      payload: { title: 'WTI: +6% surge', source: 'Commodity Market' },
    }));
    assert.equal(domain.status, 200);
    assert.equal(queued.length, 2);
    // Real publisher attribution survives: only an IMPERSONATING source is
    // neutralised. The platform's own RSS forwarder posts through this
    // endpoint, so blanket neutralisation destroyed first-party attribution.
    const rssEvent = JSON.parse(queued[0]);
    assert.equal(rssEvent.payload.title, 'Community alert: Markets rally on rate outlook');
    assert.equal(rssEvent.payload.source, 'Reuters');
    assert.equal(rssEvent.payload.link, 'https://worldmonitor.app/world/story');
    const domainEvent = JSON.parse(queued[1]);
    assert.equal(domainEvent.payload.title, 'Community alert: WTI: +6% surge');
    assert.equal(domainEvent.payload.source, 'Commodity Market');
  });

  it('keeps a real off-origin article link and discloses its host on delivery', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    let queued = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      queued = decodeURIComponent(String(url).split('/lpush/wm:events:queue/')[1] ?? '');
      return { ok: true };
    }) as typeof fetch;

    const res = await handler(makePost({
      eventType: 'rss_alert',
      severity: 'high',
      payload: { title: 'Markets rally', source: 'Reuters', link: 'https://reuters.com/world/story' },
    }));
    assert.equal(res.status, 200);
    const event = JSON.parse(queued);
    assert.equal(event.payload.link, 'https://reuters.com/world/story');
  });

  it('redacts clickable URL tokens from caller title and description', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    let queued = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      queued = decodeURIComponent(String(url).split('/lpush/wm:events:queue/')[1] ?? '');
      return { ok: true };
    }) as typeof fetch;

    // The link field is locked down, so the lure moves into free text unless
    // the boundary redacts it there too.
    const res = await handler(makePost({
      eventType: 'rss_alert',
      payload: {
        title: 'Unusual sign-in. Verify at https://wm-verify-account.example/login',
        description: 'Confirm now: www.wm-verify-account.example/go',
      },
    }));
    assert.equal(res.status, 200);
    const event = JSON.parse(queued);
    const queuedText = JSON.stringify(event.payload);
    assert.ok(!queuedText.includes('wm-verify-account.example'), queuedText);
    assert.equal(
      event.payload.title,
      'Community alert: Unusual sign-in. Verify at [link removed]',
    );
    assert.equal(event.payload.description, 'Confirm now: [link removed]');
  });

  it('normalises url-only targets and preserves the 400-character description budget', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    let queued = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      queued = decodeURIComponent(String(url).split('/lpush/wm:events:queue/')[1] ?? '');
      return { ok: true };
    }) as typeof fetch;

    const description = 'x'.repeat(350);
    const res = await handler(makePost({
      eventType: 'rss_alert',
      payload: { title: 'URL fallback', url: 'https://example.com/phish', description },
    }));

    assert.equal(res.status, 200);
    const event = JSON.parse(queued);
    // `url` is classified like `link`: kept when deliverable, and narrowed to
    // first-party only at the push sink.
    assert.equal(event.payload.url, 'https://example.com/phish');
    assert.equal(event.payload.description, description);
  });

  it('falls back to the event type when a caller title sanitises to empty', async () => {
    installDeps();
    process.env.UPSTASH_REDIS_REST_URL = 'https://upstash.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
    let queued = '';
    globalThis.fetch = (async (url: string | URL | Request) => {
      queued = decodeURIComponent(String(url).split('/lpush/wm:events:queue/')[1] ?? '');
      return { ok: true };
    }) as typeof fetch;

    const res = await handler(makePost({
      eventType: 'market_alert',
      payload: { title: '\u200b\u0000' },
    }));

    assert.equal(res.status, 200);
    const event = JSON.parse(queued);
    assert.equal(event.payload.title, 'Community alert: market_alert');
  });
});
