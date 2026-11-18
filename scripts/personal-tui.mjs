// Terminal dashboard for the personal server: the same TUI the `worldmonitor`
// CLI ships, pointed at the local ingress and signed in with the owner's
// password from .env.local. Start `npm run start:personal` first.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnvFile } from './_seed-utils.mjs';

export function personalOrigin(env = process.env) {
  return `http://${env.WM_PERSONAL_HOST || '127.0.0.1'}:${Number(env.WM_PERSONAL_PORT || 3000)}`;
}

// Adds the owner's Basic credential to requests for the personal server only.
// Imagery and other third-party hosts the TUI calls must never receive it.
export function createPersonalFetch({ origin, username = 'owner', password, fetchImpl = globalThis.fetch }) {
  if (!password) throw new Error('Set WM_PERSONAL_PASSWORD in .env.local');
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  return (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== origin) return fetchImpl(input, init);
    // Headers accepts a plain object, a Headers instance or [name, value]
    // tuples; spreading only kept the first. A Request keeps its own headers.
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('authorization', authorization);
    return fetchImpl(input, { ...init, headers });
  };
}

export async function startPersonalTui({ argv = process.argv.slice(2), env = process.env } = {}) {
  loadEnvFile(import.meta.url);
  const origin = personalOrigin(env);
  const fetchImpl = createPersonalFetch({ origin, username: env.WM_PERSONAL_USERNAME || 'owner', password: env.WM_PERSONAL_PASSWORD });
  try {
    const probe = await fetchImpl(`${origin}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (probe.status === 401) throw new Error('개인용 서버가 비밀번호를 거부했습니다. .env.local의 WM_PERSONAL_PASSWORD를 확인하세요.');
  } catch (error) {
    if (error.message.startsWith('개인용 서버가')) throw error;
    throw new Error(`개인용 서버(${origin})에 연결할 수 없습니다. 먼저 다른 터미널에서 npm run start:personal 을 실행하세요.`);
  }
  const { launchTui } = await import('../cli/src/tui/index.mjs');
  // The personal server has no session endpoint; its Basic login is the credential.
  const options = { baseUrl: origin, anonymousSession: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--theme') options.theme = argv[++i];
    else if (argv[i] === '--fps') options.fps = argv[++i];
    else if (argv[i] === '--no-anim') options.noAnim = true;
  }
  return launchTui({ options, env, fetchImpl });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  startPersonalTui().then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(error.message); process.exitCode = 1; },
  );
}
