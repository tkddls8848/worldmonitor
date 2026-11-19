// Seeder-side LLM provider chains: scripts/lib/llm-chain.cjs (the brief-llm
// injected chain) and the regional-snapshot narrative transport.
//
// The personal fork removed the llm_call usage telemetry these chains used
// to ship to Axiom (scripts/lib/llm-telemetry.cjs). These tests pin the
// fallback behaviour that remains, and that no call reaches the Axiom ingest
// even with the old USAGE_TELEMETRY/AXIOM_API_TOKEN switches set.

import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

import { callLLM } from '../scripts/lib/llm-chain.cjs';
import { callLlmDefault as callNarrativeLlm, __setNarrativeTransportForTests } from '../scripts/regional-snapshot/narrative.mjs';

const ENV_KEYS = ['USAGE_TELEMETRY', 'AXIOM_API_TOKEN', 'OPENROUTER_API_KEY', 'OLLAMA_API_URL'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  __setNarrativeTransportForTests(null);
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

function baseEnv() {
  // The removed telemetry's switches stay set: nothing may reach Axiom anyway.
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'axiom-test-token';
  process.env.OPENROUTER_API_KEY = 'or-test';
  delete process.env.OLLAMA_API_URL;
}

function llmJson(
  content,
  usage = { total_tokens: 30, prompt_tokens: 20, completion_tokens: 10 },
  finishReason = 'stop',
) {
  return { choices: [{ message: { content }, finish_reason: finishReason }], usage };
}

const CHAIN_PAID_MODEL = 'google/gemini-2.5-flash';

function isPaidOpenRouter(init) {
  return JSON.parse(String(init.body || '{}')).model === CHAIN_PAID_MODEL;
}

// A fetch stub that fails the test on any request to the Axiom ingest.
function noAxiom(handler) {
  return async (url, init = {}) => {
    if (String(url).includes('api.axiom.co')) throw new Error(`telemetry request to ${url}`);
    return handler(String(url), init);
  };
}

test('llm-chain: falls back from a failed paid attempt to the free model', async () => {
  baseEnv();
  const attempted = [];
  global.fetch = noAxiom(async (raw, init) => {
    if (raw.includes('openrouter.ai')) attempted.push(JSON.parse(String(init.body || '{}')).model);
    if (raw.includes('openrouter.ai') && isPaidOpenRouter(init)) {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    if (raw.includes('openrouter.ai')) {
      return { ok: true, json: async () => llmJson('brief prose output') };
    }
    throw new Error(`unexpected fetch: ${raw}`);
  });

  const text = await callLLM('system', 'user prompt', { stage: 'brief-digest-cron' });
  assert.equal(text, 'brief prose output');
  assert.deepEqual(attempted, ['google/gemini-2.5-flash', 'google/gemma-4-26b-a4b-it:free']);
});

test('llm-chain: reaches both fixed OpenRouter free models with routing intact', async () => {
  baseEnv();
  const attempted = [];
  global.fetch = noAxiom(async (raw, init) => {
    if (raw.includes('openrouter.ai')) {
      const body = JSON.parse(String(init.body || '{}'));
      attempted.push(body);
      const content = body.model === 'nvidia/nemotron-3.5-super-vl:free' ? 'backup free answer' : '';
      return { ok: true, json: async () => llmJson(content) };
    }
    throw new Error(`unexpected fetch: ${raw}`);
  });

  const text = await callLLM('system', 'user prompt', { stage: 'brief-digest-cron' });

  assert.equal(text, 'backup free answer');
  assert.deepEqual(attempted.map(body => body.model), [
    'google/gemini-2.5-flash',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3.5-super-vl:free',
  ]);
  for (const body of attempted.slice(1)) {
    assert.deepEqual(body.reasoning, { enabled: false });
    assert.equal(body.provider?.sort, 'throughput');
    assert.ok(body.provider?.ignore?.includes('deepseek'));
  }
});

test('llm-chain: an exact allowlist prevents fallback models from changing a pinned surface', async () => {
  baseEnv();
  const attempted = [];
  global.fetch = noAxiom(async (raw, init) => {
    if (!raw.includes('openrouter.ai')) throw new Error(`unexpected provider: ${raw}`);
    const body = JSON.parse(String(init.body || '{}'));
    attempted.push(body.model);
    return { ok: false, status: 503, json: async () => ({}) };
  });

  const text = await callLLM('system', 'user prompt', {
    allowedProviders: ['openrouter'],
    stage: 'brief-digest-cron',
  });

  assert.equal(text, null);
  assert.deepEqual(attempted, ['google/gemini-2.5-flash']);
});

test('llm-chain: a per-call model override moves the request off the chain default', async () => {
  baseEnv();
  const attempted = [];
  global.fetch = noAxiom(async (raw, init) => {
    if (!raw.includes('openrouter.ai')) throw new Error(`unexpected provider: ${raw}`);
    attempted.push(JSON.parse(String(init.body || '{}')).model);
    return { ok: true, json: async () => llmJson('overridden brief prose') };
  });

  const overridden = await callLLM('system', 'user prompt', {
    allowedProviders: ['openrouter'],
    modelOverrides: { openrouter: 'google/gemini-3.5-flash-lite' },
    stage: 'brief-digest-cron',
  });

  assert.equal(overridden, 'overridden brief prose');
  assert.deepEqual(attempted, ['google/gemini-3.5-flash-lite']);

  const unoverridden = await callLLM('system', 'user prompt', {
    allowedProviders: ['openrouter'],
    stage: 'brief-digest-cron',
  });

  assert.equal(unoverridden, 'overridden brief prose');
  assert.deepEqual(attempted, ['google/gemini-3.5-flash-lite', 'google/gemini-2.5-flash']);
});

for (const [label, paidContent] of [
  ['length-limited prose', 'The response looks complete because it ends with the abbreviation U.S.'],
  ['an empty length-limited response', ''],
]) {
  test(`llm-chain: rejects ${label} and falls through to the next provider`, async () => {
    baseEnv();
    const attempted = [];
    global.fetch = noAxiom(async (raw, init) => {
      if (raw.includes('openrouter.ai')) attempted.push(JSON.parse(String(init.body || '{}')).model);
      if (raw.includes('openrouter.ai') && isPaidOpenRouter(init)) {
        return { ok: true, json: async () => llmJson(paidContent, undefined, 'length') };
      }
      if (raw.includes('openrouter.ai')) {
        return { ok: true, json: async () => llmJson('Complete fallback prose.') };
      }
      throw new Error(`unexpected fetch: ${raw}`);
    });

    const text = await callLLM('system', 'user prompt', { stage: 'brief-whymatters-cron' });

    assert.equal(text, 'Complete fallback prose.');
    assert.deepEqual(attempted, ['google/gemini-2.5-flash', 'google/gemma-4-26b-a4b-it:free']);
  });
}

test('narrative: validate_reject falls through to the provider whose answer validates', async () => {
  baseEnv();
  global.fetch = noAxiom(async (raw) => {
    throw new Error(`unexpected global fetch: ${raw}`);
  });
  const attempted = [];
  // Provider transport is injected: the paid and primary free OpenRouter models
  // fail validation, then the backup free model answers with the accepted payload.
  __setNarrativeTransportForTests({
    fetch: async (_url, init) => {
      const model = JSON.parse(String(init.body)).model;
      attempted.push(model);
      if (model !== 'nvidia/nemotron-3.5-super-vl:free') {
        return { ok: true, json: async () => llmJson('not-json narrative') };
      }
      return { ok: true, json: async () => llmJson('{"ok":true}') };
    },
  });

  const res = await callNarrativeLlm(
    { systemPrompt: 'sys', userPrompt: 'user' },
    { validate: (text) => text.startsWith('{') },
  );
  assert.ok(res);
  assert.equal(res.provider, 'openrouter-free-backup');
  assert.equal(attempted.length, 3);
  assert.equal(attempted[2], 'nvidia/nemotron-3.5-super-vl:free');
});
