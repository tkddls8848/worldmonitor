import { afterEach, beforeEach, describe, test } from 'node:test';
import { expect, vi } from './helpers/vitest-compat.mts';

import { summarizeArticle } from "../server/worldmonitor/news/v1/summarize-article";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function makeContext(headers: Record<string, string> = {}) {
  return {
    request: new Request("https://www.worldmonitor.app/api/news/v1/summarize-article", { headers }),
    pathParams: {},
    headers,
  };
}

function request(mode = "brief", provider = "openrouter") {
  return {
    provider,
    headlines: ["Headline one", "Headline two"],
    mode,
    geoContext: "",
    // Translate mode carries its target language in `variant`.
    variant: mode === "translate" ? "fr" : "full",
    lang: "en",
    systemAppend: "",
    bodies: [],
  };
}

beforeEach(() => {
  restoreEnv();
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  globalThis.fetch = vi.fn(async () => {
    throw new Error("non-premium summarize should not call providers");
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

describe("summarizeArticle handler premium mode gate", () => {


  test("translation mode remains outside the premium summary gate", async () => {
    delete process.env.OPENROUTER_API_KEY;

    const result = await summarizeArticle(makeContext(), request("translate"));

    expect(result).toMatchObject({
      fallback: true,
      status: "SUMMARIZE_STATUS_SKIPPED",
      statusDetail: "OPENROUTER_API_KEY not configured",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("premium callers pass the summary gate", async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.WORLDMONITOR_VALID_KEYS = "enterprise-test-key";

    const result = await summarizeArticle(
      makeContext({ "X-WorldMonitor-Key": "enterprise-test-key" }),
      request("brief"),
    );

    expect(result).toMatchObject({
      fallback: true,
      status: "SUMMARIZE_STATUS_SKIPPED",
      statusDetail: "OPENROUTER_API_KEY not configured",
    });
    expect(result.error).not.toBe("Pro subscription required");
  });

  test("a stale client naming groq is skipped without a provider fetch (#8885)", async () => {
    process.env.GROQ_API_KEY = "stale-groq-key";

    const result = await summarizeArticle(makeContext(), request("translate", "groq"));

    expect(result).toMatchObject({
      summary: "",
      provider: "groq",
      fallback: true,
      status: "SUMMARIZE_STATUS_SKIPPED",
      statusDetail: "Unknown provider: groq",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
