import { CHROME_UA } from './constants';

export function getRelayBaseUrl(): string | null {
  const origin = process.env.LOCAL_API_ORIGIN;
  return origin ? `${origin.replace(/\/$/, '')}/api/local-providers` : null;
}

export function getRelayHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': CHROME_UA,
    ...extra,
  };
  if (process.env.LOCAL_API_TOKEN) headers['x-worldmonitor-local-token'] = process.env.LOCAL_API_TOKEN;
  return headers;
}

/** Error message for a non-OK relay response, carrying the relay's own `error` reason when it sent one. */
export async function relayFailureMessage(resp: Response): Promise<string> {
  const reason = await resp.json().then(
    (body: { error?: unknown } | null) => (typeof body?.error === 'string' ? body.error.slice(0, 200) : ''),
    () => '',
  );
  return reason ? `relay returned ${resp.status}: ${reason}` : `relay returned ${resp.status}`;
}
