import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';

export async function markActivated(key) {
  try {
    const creds = getOptionalUpstashCreds();
    if (creds) await upstashCommand(creds, ['SET', key, '1']);
  } catch (error) {
    console.warn(`  WARN: activation marker write failed: ${error?.message || error}`);
  }
}
