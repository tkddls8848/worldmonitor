// Seeders use the personal ingress by default. API_BASE_URL can name another server.
import { personalOrigin } from './classify-digest-request.cjs';

export function wmApiBase(env = process.env) {
  const configured = typeof env.API_BASE_URL === 'string' ? env.API_BASE_URL.trim() : '';
  return (configured || personalOrigin(env)).replace(/\/+$/, '');
}

export function isPersonalApi(url, env = process.env) {
  return new URL(url).origin === new URL(personalOrigin(env)).origin;
}

// Some warm-ping seeders send the upstream site's Origin. Drop it only
// for the personal ingress, where it would fail the same-origin check.
export function wmApiFetch(env = process.env, fetchImpl = (...args) => globalThis.fetch(...args)) {
  return (input, init) => {
    const url = typeof input === 'string' || input instanceof URL ? input : input.url;
    const original = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    if (!original || !isPersonalApi(url, env)) return fetchImpl(input, init);
    const headers = new Headers(original);
    headers.delete('origin');
    return fetchImpl(input, { ...init, headers });
  };
}
