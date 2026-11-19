// callLlm (server/_shared/llm.ts) used to POST per-attempt llm_call events to
// the Axiom ingest (server/_shared/usage.ts) when USAGE_TELEMETRY=1 and
// AXIOM_API_TOKEN were set. The personal fork removed that telemetry. These
// tests pin that the provider chain still answers and falls back, and that no
// request reaches Axiom even with the old switches set.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { callLlm } from '../server/_shared/llm.ts';

const ENV_KEYS = [
  'OPENROUTER_API_KEY', 'OLLAMA_API_URL', 'LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'USAGE_TELEMETRY', 'AXIOM_API_TOKEN',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k] as string;
  }
});

function installFetchMock(opts: {
  openrouterStatus?: number;
  openrouterFinishReason?: string;
  posts: string[];
}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if ((init?.method || 'GET') === 'GET') {
      return new Response('', { status: 200 });
    }
    opts.posts.push(url);
    if (url.includes('api.axiom.co')) {
      return new Response('{}', { status: 200 });
    }
    if (url.includes('llm.example.test')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'generic answer' } }],
        model: 'generic-test-model',
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      }), { status: 200 });
    }
    if (url.includes('openrouter.ai')) {
      if (opts.openrouterStatus && opts.openrouterStatus !== 200) {
        return new Response('openrouter down', { status: opts.openrouterStatus });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: { content: 'openrouter answer' },
          ...(opts.openrouterFinishReason ? { finish_reason: opts.openrouterFinishReason } : {}),
        }],
        model: 'deepseek/deepseek-v4-flash',
        usage: { prompt_tokens: 130, completion_tokens: 55, total_tokens: 185 },
      }), { status: 200 });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;
}

function baseEnv() {
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  process.env.LLM_API_URL = 'https://llm.example.test/v1/chat/completions';
  process.env.LLM_API_KEY = 'generic-test-key';
  process.env.LLM_MODEL = 'generic-test-model';
  // The removed telemetry's switches stay set: nothing may reach Axiom anyway.
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'axiom-test-token';
  delete process.env.OLLAMA_API_URL;
}

const axiomPosts = (posts: string[]) => posts.filter((url) => url.includes('api.axiom.co'));

describe('callLlm without usage telemetry', () => {
  it('answers from the first provider and sends nothing to Axiom', async () => {
    baseEnv();
    const posts: string[] = [];
    installFetchMock({ posts });

    const result = await callLlm({
      messages: [
        { role: 'system', content: 'sys prompt' },
        { role: 'user', content: 'user prompt' },
      ],
      stage: 'test-stage',
    });

    assert.equal(result?.content, 'openrouter answer');
    assert.equal(result?.tokens, 185);
    assert.deepEqual(axiomPosts(posts), []);
  });

  it('falls back past a failed provider and sends nothing to Axiom', async () => {
    baseEnv();
    const posts: string[] = [];
    installFetchMock({ openrouterStatus: 500, posts });

    const result = await callLlm({
      messages: [{ role: 'user', content: 'user prompt' }],
      stage: 'test-stage',
    });

    assert.equal(result?.content, 'generic answer');
    assert.equal(result?.provider, 'generic');
    assert.deepEqual(axiomPosts(posts), []);
  });

  it('falls back past an opted-in length rejection and sends nothing to Axiom', async () => {
    baseEnv();
    const posts: string[] = [];
    installFetchMock({ openrouterFinishReason: 'length', posts });

    const result = await callLlm({
      messages: [{ role: 'user', content: 'user prompt' }],
      stage: 'brief-why-matters-test',
      retryOnLengthLimit: true,
    });

    assert.equal(result?.content, 'generic answer');
    assert.deepEqual(axiomPosts(posts), []);
  });
});
