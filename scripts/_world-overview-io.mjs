import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';

export async function markActivated(key) {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) throw new Error('Upstash credentials unavailable');
    await upstashCommand(creds, ['SET', key, '1']);
  } catch (error) {
    console.warn(`[world-overview] could not write activation marker ${key}: ${error?.message || error}`);
  }
}
