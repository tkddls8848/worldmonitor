/**
 * New jobs use a 128-bit hex suffix. The 8-character form stays valid so
 * in-flight jobs and published examples still parse.
 */
export const JOB_ID_RE = /^scenario:\d{13}:(?:[a-f0-9]{32}|[a-z0-9]{8})$/;

/** SHA-256 hex. Keep in lockstep with OWNER_TOKEN_RE in scripts/scenario-worker.mjs. */
export const OWNER_TOKEN_RE = /^[a-f0-9]{64}$/;

export const SCENARIO_RESULT_TTL_SECONDS = 86400;

export function generateScenarioJobId(now = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (const byte of bytes) suffix += byte.toString(16).padStart(2, '0');
  return `scenario:${now}:${suffix}`;
}

export function scenarioOwnerKey(jobId: string): string {
  return `scenario-owner:${jobId}`;
}

export function scenarioResultKey(owner: string, jobId: string): string {
  return `scenario-result:${owner}:${jobId}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Principal token stored beside the job. The personal server has a single
 * owner behind HTTP Basic auth, so the token hashes that owner id. The
 * user: prefix keeps the token identical to the one written for a user id.
 */
export async function scenarioOwnerToken(ownerId: string): Promise<string> {
  return sha256Hex(`user:${ownerId}`);
}
