// Terminal dashboard pointed at the running personal server.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnvFile } from './_seed-utils.mjs';
import { personalOrigin } from './lib/classify-digest-request.cjs';

export async function startPersonalTui({ argv = process.argv.slice(2), env = process.env } = {}) {
  loadEnvFile(import.meta.url);
  const origin = personalOrigin(env);
  try {
    const probe = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
  } catch (error) {
    throw new Error(`개인용 서버(${origin})에 연결할 수 없습니다. 먼저 다른 터미널에서 npm run start:personal 을 실행하세요.`, { cause: error });
  }
  const { launchTui } = await import('../cli/src/tui/index.mjs');
  const options = { baseUrl: origin, webOrigin: origin, anonymousSession: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--theme') options.theme = argv[++i];
    else if (argv[i] === '--fps') options.fps = argv[++i];
    else if (argv[i] === '--no-anim') options.noAnim = true;
  }
  return launchTui({ options, env });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  startPersonalTui().then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(error.message); process.exitCode = 1; },
  );
}
