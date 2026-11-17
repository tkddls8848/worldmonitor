// The personal build keeps the daily brief assembly in
// scripts/seed-digest-notifications.mjs for one owner and drops every
// delivery channel. This drives composeAndStoreBriefForUser end to end with
// three fixed stories, an in-memory Upstash and a mocked LLM, then checks the
// owner's brief landed and nothing reached a mail or chat provider.
//
// Run: node --test tests/seed-digest-notifications-owner-brief.test.mjs
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const UPSTASH_URL = 'https://upstash.test';
const SEND_HOSTS = /(^|\.)(resend\.com|api\.telegram\.org|hooks\.slack\.com|slack\.com|discord\.com|discordapp\.com)$/;

const ENV_KEYS = [
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'OLLAMA_API_URL',
  'RESEND_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'BRIEF_LLM_ENABLED',
  'BRIEF_COMPOSE_ENABLED',
  'RELAY_SHARED_SECRET',
  'BRIEF_WHY_MATTERS_ENDPOINT_URL',
];

function story(i, overrides = {}) {
  return {
    hash: `owner-story-${i}`,
    title: [
      'Iran threatens to close Strait of Hormuz',
      'Earthquake of magnitude 7.1 strikes off northern Japan',
      'Central bank raises rates to curb inflation',
    ][i],
    link: `https://example.com/owner-story-${i}`,
    severity: i === 0 ? 'critical' : 'high',
    currentScore: 100 - i * 10,
    mentionCount: 4,
    phase: 'developing',
    sources: [['Reuters', 'AP News'], ['NHK World', 'BBC World'], ['Financial Times', 'Bloomberg']][i],
    description: '',
    category: ['Conflict', 'Disaster', 'Economy'][i],
    entityCorroborationCount: 0,
    corroboration: null,
    ...overrides,
  };
}

describe('seed-digest-notifications composes the owner brief', () => {
  const savedEnv = {};
  const savedFetch = globalThis.fetch;
  const store = new Map();
  const hosts = [];
  const relaySecretSentTo = [];
  let llmCalls = 0;
  let mod;
  let PERSONAL_OWNER_ID;

  function runCommand([cmd, ...args]) {
    const name = String(cmd).toUpperCase();
    if (name === 'GET') return store.has(args[0]) ? store.get(args[0]) : null;
    if (name === 'SET' || name === 'SETEX') {
      const value = name === 'SETEX' ? args[2] : args[1];
      store.set(args[0], String(value));
      return 'OK';
    }
    return null;
  }

  function json(body) {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  before(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.UPSTASH_REDIS_REST_URL = UPSTASH_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    // A relay secret is set but no why-matters endpoint is configured: the
    // secret must not be sent anywhere (it used to default to the upstream
    // operator's worldmonitor.app endpoint).
    process.env.RELAY_SHARED_SECRET = 'relay-secret-for-test';
    for (const key of ['ANTHROPIC_API_KEY', 'OLLAMA_API_URL', 'RESEND_API_KEY', 'TELEGRAM_BOT_TOKEN', 'BRIEF_LLM_ENABLED', 'BRIEF_COMPOSE_ENABLED', 'BRIEF_WHY_MATTERS_ENDPOINT_URL']) {
      delete process.env[key];
    }

    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      hosts.push(url.hostname);
      const headers = new Headers(init.headers ?? {});
      if ((headers.get('authorization') ?? '').includes('relay-secret-for-test')) relaySecretSentTo.push(url.href);
      if (url.origin === UPSTASH_URL) {
        if (url.pathname === '/pipeline') {
          const commands = JSON.parse(String(init.body ?? '[]'));
          return json(commands.map((command) => ({ result: runCommand(command) })));
        }
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        return json({ result: runCommand(parts) });
      }
      if (url.hostname === 'openrouter.ai') {
        llmCalls++;
        return json({
          choices: [{ message: { content: 'Tensions around the Strait of Hormuz lead the day.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        });
      }
      return new Response('not mocked', { status: 404 });
    };

    ({ PERSONAL_OWNER_ID } = await import('../shared/personal-owner.js'));
    mod = await import('../scripts/seed-digest-notifications.mjs');
  });

  after(() => {
    globalThis.fetch = savedFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('composes the owner brief without any send channel', async () => {
    assert.equal(PERSONAL_OWNER_ID, 'owner');
    assert.equal(typeof mod.composeAndStoreBriefForUser, 'function');

    const rule = {
      userId: PERSONAL_OWNER_ID,
      variant: 'full',
      enabled: true,
      digestMode: 'daily',
      sensitivity: 'high',
      aiDigestEnabled: true,
      channels: [],
      eventTypes: [],
      updatedAt: 0,
      briefOnly: true,
    };
    const stories = [story(0), story(1), story(2)];
    const digestFor = async () => stories;
    const nowMs = Date.now();

    const result = await mod.composeAndStoreBriefForUser(
      PERSONAL_OWNER_ID,
      [{ rule, lastSentAt: null, due: false }],
      { clusters: 3, multiSource: 2 },
      digestFor,
      nowMs,
    );

    assert.ok(result, 'expected a composed brief');
    assert.ok(llmCalls > 0, 'the brief must go through the (mocked) LLM');

    const pointer = JSON.parse(store.get('brief:latest:owner') ?? 'null');
    assert.ok(pointer, 'brief:latest:owner must be written');
    assert.equal(typeof pointer.issueSlot, 'string');
    assert.equal(pointer.composedAt, nowMs);

    const envelope = JSON.parse(store.get(`brief:owner:${pointer.issueSlot}`) ?? 'null');
    assert.ok(envelope, 'brief:owner:{slot} must hold the envelope');
    assert.equal(envelope.data.stories.length, 3);
    assert.deepEqual(result.envelope, envelope);

    const sendHosts = hosts.filter((host) => SEND_HOSTS.test(host));
    assert.deepEqual(sendHosts, [], 'no mail or chat provider may be called');
  });

  it('sends the relay secret nowhere when no why-matters endpoint is configured', () => {
    // Runs after the compose above, which enriched every story.
    assert.ok(hosts.length > 0);
    assert.deepEqual(relaySecretSentTo, []);
    assert.ok(!hosts.some((host) => /(^|\.)worldmonitor\.app$/.test(host)), hosts.join(','));
  });
});
