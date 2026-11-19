// The forecast seeder's LLM chain (callForecastLLM) used to POST per-attempt
// llm_call events to the Axiom ingest when USAGE_TELEMETRY=1 and
// AXIOM_API_TOKEN were set. The personal fork removed that telemetry: these
// tests pin that retries and provider fallback still work and that no request
// reaches Axiom, even with the old switches set.

import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import {
  callForecastLLM,
  __setForecastLlmTransportForTests,
} from '../scripts/seed-forecasts.mjs';

const ENV_KEYS = ['USAGE_TELEMETRY', 'AXIOM_API_TOKEN', 'OPENROUTER_API_KEY'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  __setForecastLlmTransportForTests(null);
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

function baseEnv() {
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'axiom-test-token';
  process.env.OPENROUTER_API_KEY = 'or-test';
}

// Provider calls go through the transport hook; any global fetch (the old
// Axiom POST) is a failure.
function captureGlobalFetch() {
  const captured = [];
  global.fetch = async (url) => {
    captured.push(String(url));
    return { ok: true, json: async () => ({}) };
  };
  return captured;
}

function llmResponse(body, status = 200) {
  return {
    ok: status === 200,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('a retried attempt succeeds and sends nothing to Axiom', async () => {
  baseEnv();
  const captured = captureGlobalFetch();
  let calls = 0;
  __setForecastLlmTransportForTests({
    fetch: async () => {
      calls += 1;
      if (calls === 1) return llmResponse({ error: 'transient' }, 500);
      return llmResponse({
        choices: [{ message: { content: 'a forecast narrative that is long enough' } }],
        model: 'google/gemini-2.5-flash',
        usage: { total_tokens: 100 },
      });
    },
  });

  const result = await callForecastLLM('system', 'user prompt', {
    stage: 'combined', providerOrder: ['openrouter'], retryDelayMs: 0,
  });

  assert.ok(result?.text);
  assert.equal(calls, 2, 'the failed attempt was retried');
  assert.deepEqual(captured, [], 'no telemetry request');
});

test('provider fallback reaches the next provider and sends nothing to Axiom', async () => {
  baseEnv();
  const captured = captureGlobalFetch();
  const models = [];
  __setForecastLlmTransportForTests({
    fetch: async (_url, init) => {
      const model = JSON.parse(init.body).model;
      models.push(model);
      if (model.endsWith(':free')) return llmResponse({ error: 'down' }, 503);
      return llmResponse({
        choices: [{ message: { content: 'a forecast narrative that is long enough' } }],
        model: 'google/gemini-2.5-flash',
      });
    },
  });

  const result = await callForecastLLM('system', 'user prompt', {
    stage: 'scenario', providerOrder: ['openrouter-free', 'openrouter'], retryDelayMs: 0,
  });

  assert.ok(result?.text);
  assert.equal(result.provider, 'openrouter');
  assert.ok(models.some((model) => model.endsWith(':free')), 'the free rung was tried first');
  assert.deepEqual(captured, [], 'no telemetry request');
});
