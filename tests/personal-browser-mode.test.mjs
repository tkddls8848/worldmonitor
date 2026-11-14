import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('personal browser build suppresses Clerk even with a configured hosted key', async () => {
  const result = await build({
    stdin: { contents: "import { isClerkAuthEnabled, initClerk } from './src/services/clerk'; export { isClerkAuthEnabled, initClerk };", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', treeShaking: true,
    define: { 'import.meta.env': JSON.stringify({ VITE_PERSONAL_MODE: 'true', VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_should_never_load' }) },
    plugins: [{ name: 'isolate-clerk-dependencies', setup(builder) {
      builder.onResolve({ filter: /^@\// }, args => {
        if (args.path === '@/config/personal-mode') return { path: `${process.cwd()}/src/config/personal-mode.ts` };
        return { path: args.path, namespace: 'stub' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const WEB_APP_ORIGIN = "https://example.test"; export const showToast = () => {}; export const isDesktopRuntime = () => false; export const trackSignIn = () => {}; export const trackSignUp = () => {}; export const trackSignUpStarted = () => {}; export const trackSignUpResumed = () => {}; export const trackSignUpExpired = () => {}; export const enqueueSentryCall = () => {};', loader: 'js' }));
    } }],
  });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  assert.equal(mod.isClerkAuthEnabled(), false);
  await mod.initClerk();
});
