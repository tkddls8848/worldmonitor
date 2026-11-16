// These source checks pin CI build/test ordering and built-output guard wiring
// (#8690, section 2).
// The spawned probes exercise guard behavior, but cannot verify workflow ordering.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const workflowPath = resolve(repoRoot, '.github/workflows/test.yml');
const guardModuleUrl = pathToFileURL(resolve(repoRoot, 'tests/_lib/built-output-guard.mjs')).href;

const guardProbeSource = [
  "import { describe, it } from 'node:test';",
  "import { writeFileSync } from 'node:fs';",
  `import { guardBuiltOutput, shouldSkipBuiltOutput } from ${JSON.stringify(guardModuleUrl)};`,
  "const dashboardHtml = process.env.WM_DASHBOARD_GUARD_DASHBOARD;",
  "const expectBuiltOutput = process.env.WM_EXPECT_BUILT_OUTPUT === '1';",
  "writeFileSync(process.env.WM_DASHBOARD_GUARD_LOADED, 'loaded');",
  "describe('built-output guard probe', { skip: shouldSkipBuiltOutput(dashboardHtml, expectBuiltOutput) }, () => {",
  "  writeFileSync(process.env.WM_DASHBOARD_GUARD_SUITE, 'entered');",
  "  guardBuiltOutput(dashboardHtml, expectBuiltOutput);",
  "  it('executes the built-output assertion', () => {",
  "    writeFileSync(process.env.WM_DASHBOARD_GUARD_ASSERTION, 'ran');",
  "  });",
  "});",
].join('\n');

function runGuardProbe(expectBuiltOutput) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'worldmonitor-built-output-guard-'));
  const probePath = join(fixtureRoot, 'guard-probe.test.mjs');
  const dashboardHtml = join(fixtureRoot, 'dist', 'dashboard.html');
  const loadedMarker = join(fixtureRoot, 'loaded');
  const suiteMarker = join(fixtureRoot, 'suite');
  const assertionMarker = join(fixtureRoot, 'assertion');

  try {
    writeFileSync(probePath, guardProbeSource);
    const env = {
      ...process.env,
      WM_DASHBOARD_GUARD_DASHBOARD: dashboardHtml,
      WM_DASHBOARD_GUARD_LOADED: loadedMarker,
      WM_DASHBOARD_GUARD_SUITE: suiteMarker,
      WM_DASHBOARD_GUARD_ASSERTION: assertionMarker,
    };
    delete env.NODE_OPTIONS;
    delete env.NODE_TEST_CONTEXT;
    if (expectBuiltOutput) env.WM_EXPECT_BUILT_OUTPUT = '1';
    else delete env.WM_EXPECT_BUILT_OUTPUT;

    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', probePath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    });

    return {
      ...result,
      output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      loaded: existsSync(loadedMarker),
      suite: existsSync(suiteMarker),
      assertion: existsSync(assertionMarker),
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

describe('built-output guard contract', () => {

  it('wires the /pro guard to the shared primitive and the prerendered page', async () => {
    // The skip/fail behaviour itself is proven with teeth by the probe cases
    // below, which exercise the shared primitive. What that probe cannot reach
    // is the /pro wrapper, because it resolves its own path -- so pin the two
    // things the wrapper contributes: which file it watches, and that it
    // delegates rather than reimplementing the skip/fail decision.
    const proGuard = await import('./_lib/pro-built-output.mjs');
    assert.match(
      proGuard.PRO_BUILT_MARKER,
      /public\/pro\/welcome\.html$/,
      'the /pro marker must be the prerendered welcome page',
    );

    const source = readFileSync(resolve(repoRoot, 'tests/_lib/pro-built-output.mjs'), 'utf8');
    assert.match(
      source,
      /from '\.\/built-output-guard\.mjs'/,
      'the /pro helper must delegate to the shared built-output primitive, not fork it',
    );
    assert.match(
      source,
      /shouldSkipBuiltOutput\(PRO_BUILT_MARKER\)/,
      'shouldSkipProBuiltOutput must ask the shared primitive about the /pro marker',
    );
    assert.match(
      source,
      /guardBuiltOutput\(PRO_BUILT_MARKER/,
      'guardProBuiltOutput must ask the shared primitive about the /pro marker',
    );

    const sentrySource = readFileSync(resolve(repoRoot, 'tests/pro-sentry-chunk.test.mjs'), 'utf8');
    assert.match(
      sentrySource,
      /from '\.\/_lib\/built-output-guard\.mjs'/,
      'the pro Sentry chunk suite must use the shared built-output primitive',
    );
    assert.match(
      sentrySource,
      /skip: shouldSkipBuiltOutput\(ASSETS_DIR\)/,
      'the pro Sentry chunk suite must skip specifically when public/pro/assets is absent',
    );
    assert.match(
      sentrySource,
      /guardBuiltOutput\(ASSETS_DIR, undefined, REBUILD_HINT\)/,
      'the pro Sentry chunk suite must fail closed on the same assets path when CI expects built output',
    );
    assert.match(
      sentrySource,
      /Run `npm run build:pro` first/,
      'the pro Sentry chunk failure must name the /pro build command',
    );
  });

  it('skips the built-output suite when the marker is absent and output is missing', () => {
    const result = runGuardProbe(false);

    assert.equal(result.status, 0, result.output);
    assert.equal(result.loaded, true, 'the probe module should load');
    assert.equal(result.suite, false, 'node:test should skip the built-output suite');
    assert.equal(result.assertion, false, 'the built-output assertion must not run');
  });

  it('fails the built-output suite when CI expects output but it is missing', () => {
    const result = runGuardProbe(true);

    // CI uses Node 24: a guard failure must fail the process as well as the
    // suite. The probe selects TAP explicitly because Node 24 defaults to spec.
    assert.notEqual(result.status, 0, result.output);
    assert.match(
      result.output,
      /^not ok 1 - built-output guard probe$/m,
      `the probe suite must be reported as failed:\n${result.output}`,
    );
    assert.match(
      result.output,
      /missing but WM_EXPECT_BUILT_OUTPUT=1 indicates CI expected a build/,
      `the failure must come from the guard, not an unrelated crash:\n${result.output}`,
    );
    assert.notEqual(result.status, null, 'the probe process must not have been killed by a signal');
    assert.equal(result.loaded, true, 'the probe module should load');
    assert.equal(result.suite, true, 'the suite callback should run when CI expects built output');
    assert.equal(result.assertion, false, 'the assertion must not run after the guard fails');
  });
});
