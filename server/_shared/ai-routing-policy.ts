import type { LlmRoutingPolicy } from './llm';

// AI routing decision for LLM calls that carry the caller's own input.
//
// Personal fork: the single owner has no per-customer routing policy (the
// policies lived in Convex, keyed by a Clerk user id), so every call takes the
// default provider chain. No request header is read: a caller-supplied
// `x-user-id` or bearer token cannot change the decision. The decision type
// and the helpers below stay so llm.ts and the handlers keep one contract.

export type AiRoutingDecision =
  | { kind: 'default' }
  | { kind: 'restricted'; allowedProviders: string[] }
  | { kind: 'unavailable' };

const DEFAULT_DECISION: AiRoutingDecision = { kind: 'default' };

export async function getAiRoutingDecisionForUser(_userId?: string | null): Promise<AiRoutingDecision> {
  return DEFAULT_DECISION;
}

/** Decision for a gateway-routed request: always the default chain. */
export async function resolveAiRouting(
  _request?: Request,
  _fallbackUserId?: string | null,
): Promise<AiRoutingDecision> {
  return DEFAULT_DECISION;
}

/** The `routingPolicy` to pass to llm.ts. */
export function toLlmRoutingPolicy(decision: AiRoutingDecision): LlmRoutingPolicy | null {
  if (decision.kind === 'default') return null;
  if (decision.kind === 'unavailable') return { allowedProviders: [] };
  return { allowedProviders: decision.allowedProviders };
}

/**
 * Cache-key suffix for LLM-backed responses. Unrestricted callers keep the
 * existing shared keys (empty suffix); restricted callers get their own
 * namespace so they are never served text another provider wrote.
 */
export function aiRoutingCacheSuffix(decision: AiRoutingDecision): string {
  if (decision.kind === 'default') return '';
  if (decision.kind === 'unavailable') return ':ai=none';
  return `:ai=${decision.allowedProviders.join('+')}`;
}

/** True when the caller may use features that only exist on the default chain (e.g. OpenRouter embeddings). */
export function allowsProvider(decision: AiRoutingDecision, provider: string): boolean {
  if (decision.kind === 'default') return true;
  if (decision.kind === 'unavailable') return false;
  return decision.allowedProviders.includes(provider);
}
