import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, delimiter } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = resolve(root, '.github/workflows');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const packageScripts = packageJson.scripts ?? {};
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const securityAuditScript = read(resolve(root, '.github/scripts/audit-production-dependencies.mjs'));
const testWorkflow = read(resolve(workflowsDir, 'test.yml'));
const lintCodeWorkflow = read(resolve(workflowsDir, 'lint-code.yml'));
const protoCheckWorkflow = read(resolve(workflowsDir, 'proto-check.yml'));
const playwrightConfig = read(resolve(root, 'playwright.config.ts'));

describe('unit-shard nested dependency cache', () => {
  // Each shard installed blog-site/ and scripts/ from setup-node's npm
  // download cache (4-9s to restore four lockfiles' downloads), then ran both
  // installs (7-10s). The installed trees are restored instead, keyed on
  // every file that decides their contents, and installed only on a miss.
  const steps = YAML.parse(testWorkflow).jobs['unit-shards'].steps
    .flatMap((step: { parallel?: unknown[] }) => step.parallel ?? [step]);
  const restore = steps.find((step) => step.id === 'nested-deps');
  const blogInstall = steps.find((step) => step.run === 'npm run ci:blog-site');
  const scriptsInstall = steps.find((step) => step.run === 'npm ci --prefix scripts --ignore-scripts --no-audit --no-fund');
  const save = steps.find((step) => step.uses?.startsWith('actions/cache/save@') && step.with?.key === '${{ steps.nested-deps.outputs.cache-primary-key }}');
  const tests = steps.find((step) => step.run?.includes('npm run test:data'));
  const miss = "steps.nested-deps.outputs.cache-hit != 'true'";

  it('restores both installed trees before the tests', () => {
    assert.ok(restore?.uses?.startsWith('actions/cache/restore@'));
    assert.deepEqual(restore.with.path.trim().split('\n'), ['blog-site/node_modules', 'scripts/node_modules']);
    assert.ok(steps.indexOf(restore) < steps.indexOf(tests));
  });

  it('installs and saves only on a miss, after the restore', () => {
    for (const step of [blogInstall, scriptsInstall, save]) {
      assert.ok(step, 'nested install and save steps must exist');
      assert.equal(step.if, miss);
      assert.ok(steps.indexOf(restore) < steps.indexOf(step));
    }
    assert.ok(steps.indexOf(blogInstall) < steps.indexOf(save));
    assert.ok(steps.indexOf(scriptsInstall) < steps.indexOf(save));
    assert.equal(save.with.path, restore.with.path);
  });

  // A restored tree skips both installs, so the tests must still notice a
  // tree that lacks what they need, and a changed install command must
  // change the key.
  it('keeps the scripts/ presence guard on the test step', () => {
    assert.equal(tests.env?.WM_EXPECT_SCRIPTS_DEPS, '1');
  });

  it('versions the key with the blog-site install command', () => {
    const scripts = JSON.parse(read(resolve(root, 'package.json'))).scripts;
    assert.equal(
      scripts['ci:blog-site'],
      'cross-env npm_config_allow_scripts= npm --prefix blog-site ci --prefer-offline',
      'ci:blog-site changed: bump nested-deps-vN in the unit-shards cache key, then update this string',
    );
    assert.match(restore.with.key, /^nested-deps-v1-/);
  });
});

describe('browser-loss artifact capture (#6501, #7880)', () => {
  for (const exitCode of [0, 17]) {
    it(`retains logs after output cleanup and preserves smoke exit ${exitCode}`, () => {
      const workflow = YAML.parse(testWorkflow);
      const step = workflow.jobs['variant-smoke-shards'].steps.find(
        (candidate: { name?: string }) => candidate.name === 'Run ci-smoke with browser-loss diagnostics',
      );
      assert.ok(step, 'both current smoke shards must run the diagnostic capture');
      const dir = mkdtempSync(resolve(tmpdir(), 'wm-browser-loss-capture-'));
      try {
        mkdirSync(resolve(dir, 'bin'));
        // Model Playwright opening its debug file before clearing outputDir.
        // Two workers then emit evidence that must survive the same invocation.
        writeFileSync(resolve(dir, 'bin/npm'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.DEBUG !== 'pw:browser') process.exit(98);
const fd = process.env.DEBUG_FILE ? fs.openSync(process.env.DEBUG_FILE, 'w') : 2;
fs.rmSync('test-results', { recursive: true, force: true });
fs.mkdirSync('test-results');
fs.writeFileSync('test-results/trace.zip', 'retained trace');
fs.writeSync(fd, 'pw:browser [pid=101] <process did exit: exitCode=null, signal=SIGKILL>\\n');
fs.writeSync(fd, 'pw:browser [pid=102] <process did exit: exitCode=0, signal=null>\\n');
console.log('smoke completed');
process.exit(${exitCode});
`, { mode: 0o755 });
        writeFileSync(resolve(dir, 'bin/free'), '#!/bin/sh\nprintf "Mem: 16384 2048 14336\\n"\n', { mode: 0o755 });
        const result = spawnSync('bash', ['-c', step.run.replaceAll('${{ matrix.shard }}', '1')], {
          cwd: dir,
          env: { ...process.env, ...step.env, PATH: `${resolve(dir, "bin")}${delimiter}${process.env.PATH}` },
          encoding: 'utf8',
          timeout: 15_000,
        });
        assert.equal(result.status, exitCode, result.stderr);
        const log = read(resolve(dir, 'test-results/browser-loss/playwright.log'));
        assert.match(log, /pid=101.*signal=SIGKILL/);
        assert.match(log, /pid=102.*exitCode=0/);
        assert.match(log, /smoke completed/);
        assert.match(read(resolve(dir, 'test-results/browser-loss/memory-samples.log')), /Mem: 16384 2048 14336/);
        assert.equal(read(resolve(dir, 'test-results/trace.zip')), 'retained trace');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
const workflowText = readdirSync(workflowsDir)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => read(resolve(workflowsDir, name)))
  .join('\n');

const REQUIRED_PR_SCRIPTS = [
  'test:data',
  'test:api',
] as const;

// Every regression guard the combined ci-smoke invocation must keep exercising.
// Dropping a spec from its command line is how a guard can stop being invoked
// while CI stays green, so the required spec list is pinned here.
const REQUIRED_CI_SMOKE_SPECS = [
  'e2e/variant-live-smoke.spec.ts',
  'e2e/country-brief.spec.ts',
  'e2e/country-brief-reports.spec.ts',
  'e2e/dashboard-news-request-budget.spec.ts',
  'e2e/bootstrap-request-budget.spec.ts',
  'e2e/bootstrap-hydration-request-budget.spec.ts',
  'e2e/settings-panel-live-apply.spec.ts',
  'e2e/settings-source-live-apply.spec.ts',
  'e2e/dashboard-lcp-attribution.spec.ts',
  'e2e/keyword-spike-flow.spec.ts',
  'e2e/breaking-news-banner-provenance.spec.ts',
  'e2e/dompurify-regression.spec.ts',
  'e2e/a11y-axe-scan.spec.ts',
  'e2e/map-overlay-marker-budget.spec.ts',
  'e2e/mobile-displacement.spec.ts',
  'e2e/map-distance.spec.ts',
  'e2e/live-panel-layout-8276.spec.ts',
  'e2e/panel-grid-no-overlap.spec.ts',
  'e2e/panel-table-overflow.spec.ts',
  'e2e/panel-header-fits.spec.ts',
  'e2e/procurement-filters-fit.spec.ts',
  'e2e/news-source-row-fits.spec.ts',
  'e2e/energy-table-values-whole.spec.ts',
  'e2e/panel-text-unclipped.spec.ts',
  'e2e/regional-intelligence-region-select.spec.ts',
  'e2e/settings-home-list.spec.ts',
  'e2e/panel-grid-column-clamp.spec.ts',
  'e2e/narrow-panel-overflow.spec.ts',
  'e2e/hormuz-chart-width.spec.ts',
  'e2e/population-exposure-legacy.spec.ts',
] as const;

const REQUIRED_TEST_JOBS = [
  'unit',
  'api-tests',
  'variant-smoke-full',
  'desktop-config',
  'desktop-node-windows',
  'desktop-rust',
] as const;

const TIMEOUT_CAPPED_TEST_JOBS = [
  'consumer-prices',
  'api-tests',
  'variant-smoke-shards',
  'variant-smoke-pro-webmcp',
  'variant-smoke-full',
  'desktop-config',
  'desktop-node-windows',
  'desktop-rust',
] as const;

const REQUIRED_GATE_WORKFLOWS = [
  'Test',
  'Typecheck',
  'Lint Code',
  'Security Audit',
  'Stacked Merge Guard',
  'Proto Generation Check',
] as const;

const REQUIRED_NON_TEST_GATE_CHECKS = [
  'typecheck',
  'biome',
  'markdown',
  'public-docs',
  'security-audit',
  'stacked-merge-guard',
  'proto-freshness',
] as const;

// Jobs covered by an aggregate check rather than required under their own
// names. Matrix jobs publish one check run per entry and have no single name
// for the gate to match. A companion non-matrix job can share the same
// aggregate so branch protection retains one stable public contract. Each
// exemption is valid only while the required aggregate directly needs it.
const GATE_CHECK_EXEMPTIONS: Record<string, { workflow: string; coveredBy: string }> = {
  'audit-lockfile': { workflow: 'Security Audit', coveredBy: 'security-audit' },
  'audit-rust': { workflow: 'Security Audit', coveredBy: 'security-audit' },
  'unit-shards': { workflow: 'Test', coveredBy: 'unit' },
  'unit-built-output': { workflow: 'Test', coveredBy: 'unit' },
  'variant-smoke-shards': { workflow: 'Test', coveredBy: 'variant-smoke-full' },
  'variant-smoke-pro-webmcp': { workflow: 'Test', coveredBy: 'variant-smoke-full' },
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function workflowRegexNeedle(path: string): string {
  return path.replaceAll('/', '\\/').replaceAll('.', '\\.');
}

function shellAwkAssignmentBlock(variable: string): string {
  const start = `${variable}=$(printf '%s\\n' "$FILES" | awk '`;
  const startIndex = testWorkflow.indexOf(start);
  assert.notEqual(startIndex, -1, `test.yml must define ${variable}`);
  const end = "\n          ')";
  const endIndex = testWorkflow.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `test.yml must terminate ${variable}`);
  return testWorkflow.slice(startIndex, endIndex + end.length);
}

function evaluateAwkAssignmentBlock(block: string, files: string[]): number {
  const program = block.slice(block.indexOf("awk '") + 5, block.lastIndexOf("'"));
  const output = execFileSync('awk', [program], {
    input: `${files.join('\n')}\n`,
    encoding: 'utf8',
  });
  return Number(output.trim());
}

function testJobBlock(job: string): string {
  const match = testWorkflow.match(new RegExp(`\\n  ${escapeRegExp(job)}:\\n[\\s\\S]*?(?=\\n  [\\w-]+:\\n|\\n$)`));
  assert.ok(match, `test.yml must define ${job}`);
  return match[0];
}

function workflowJobBlock(workflow: string, job: string): string {
  const match = workflow.match(new RegExp(`\\n  ${escapeRegExp(job)}:\\n[\\s\\S]*?(?=\\n  [\\w-]+:\\n|\\n$)`));
  assert.ok(match, `workflow must define ${job}`);
  return match[0];
}

// On push, schedule, and workflow_dispatch, github.event.pull_request.number is
// empty. A group that interpolates only that field collapses to a shared prefix
// (`proto-freshness-`), and cancel-in-progress: true then evicts sibling
// mainline runs that still owe the deploy gate a verdict (#8445).
// The empty-on-non-PR operand must sit immediately before the unique fallback:
// `github.ref || github.sha` still matches a bare `|| github.sha` and still
// collapses every push to main onto one group.
const NON_PR_CONCURRENCY_FALLBACK =
  /github\.event\.pull_request\.number\s*\|\|\s*github\.(?:sha|run_id)\b/;
const PR_ONLY_CANCEL_IN_PROGRESS = "${{ github.event_name == 'pull_request' }}";

function workflowLevelConcurrency(source: string): {
  group?: unknown;
  'cancel-in-progress'?: unknown;
} | null {
  const concurrency = (YAML.parse(source) as { concurrency?: unknown }).concurrency;
  if (typeof concurrency !== 'object' || concurrency === null) return null;
  return concurrency as { group?: unknown; 'cancel-in-progress'?: unknown };
}

function cancelsUnconditionallyWithoutNonPrFallback(source: string): boolean {
  const concurrency = workflowLevelConcurrency(source);
  if (!concurrency) return false;
  const cancel = concurrency['cancel-in-progress'];
  // Boolean true always evicts. Any other expression does too, unless it is
  // exactly the #8443 PR-only form. `${{ true }}` used to skip this helper.
  const isUnconditionalCancel =
    cancel === true || (typeof cancel === 'string' && cancel !== PR_ONLY_CANCEL_IN_PROGRESS);
  if (!isUnconditionalCancel) return false;
  return typeof concurrency.group !== 'string' || !NON_PR_CONCURRENCY_FALLBACK.test(concurrency.group);
}

function workflowStepBlock(workflow: string, stepName: string): string {
  const marker = `\n      - name: ${stepName}\n`;
  const startIndex = workflow.indexOf(marker);
  assert.notEqual(startIndex, -1, `workflow must define step ${stepName}`);
  const nextStepIndex = workflow.indexOf('\n      - ', startIndex + marker.length);
  return workflow.slice(startIndex, nextStepIndex === -1 ? workflow.length : nextStepIndex);
}

function workflowStepBlocksByUses(workflow: string, action: string): string[] {
  const marker = new RegExp(`\\n      - uses: ${escapeRegExp(action)}@[^\\n]+\\n`, 'g');
  const blocks: string[] = [];
  for (const match of workflow.matchAll(marker)) {
    const startIndex = match.index ?? -1;
    assert.notEqual(startIndex, -1, `workflow must define ${action}`);
    const nextStepIndex = workflow.indexOf('\n      - ', startIndex + match[0].length);
    blocks.push(workflow.slice(startIndex, nextStepIndex === -1 ? workflow.length : nextStepIndex));
  }
  assert.ok(blocks.length > 0, `workflow must define ${action}`);
  return blocks;
}

// Every step of a job block, with the offset it starts at so a caller can ask
// where a step sits relative to another (step ORDER decides whether an
// `if: failure()` step can see what an earlier step produced).
function jobSteps(jobBlock: string): { block: string; offset: number }[] {
  // Anchored with `m` rather than a leading `\n`: consuming the newline that
  // separates two steps would leave the next step with no `\n` to match on,
  // and matchAll would silently return every OTHER step.
  const steps: { block: string; offset: number }[] = [];
  for (const match of jobBlock.matchAll(/^ {6}- [^\n]*\n(?:(?! {6}- )[^\n]*\n)*/gm)) {
    steps.push({ block: `\n${match[0]}`, offset: match.index ?? 0 });
  }
  return steps;
}

// The `path:` of an upload step, normalized, as a list — the input accepts a
// single path or a block scalar of several, and a guard that only understood
// the single-path form would redden the day someone adds a second path.
function stepPaths(stepBlock: string): string[] {
  const inline = stepBlock.match(/\n {10}path: (?!\|)([^\n]+)/);
  if (inline) return [inline[1].trim().replace(/\/$/, '')];
  const block = stepBlock.match(/\n {10}path: \|[-+]?\n((?: {12}[^\n]*\n)+)/);
  if (!block) return [];
  return block[1]
    .split('\n')
    .map((line) => line.trim().replace(/\/$/, ''))
    .filter((line) => line.length > 0);
}

function shellArgvTokens(command: string): string[] {
  const tokens: string[] = [];
  for (const token of command.trim().split(/\s+/)) {
    if (token.startsWith('#')) break;
    tokens.push(token);
  }
  return tokens;
}

function workflowRunScript(stepBlock: string): string {
  const marker = '\n        run: |\n';
  const startIndex = stepBlock.indexOf(marker);
  assert.notEqual(startIndex, -1, 'workflow step must have a block run script');
  return stepBlock
    .slice(startIndex + marker.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
}

function runReleasePreflight(stepBlock: string, eventName: string, draft: string, value: string): void {
  const script = workflowRunScript(stepBlock)
    .replaceAll('${{ github.event_name }}', eventName)
    .replaceAll('${{ github.event.inputs.draft }}', draft);
  const names = [
    'VITE_CLERK_PUBLISHABLE_KEY',
    'VITE_WS_RELAY_URL',
    'VITE_PMTILES_URL_PUBLIC',
    'CONVEX_URL',
  ];
  const env = Object.fromEntries(names.map((name) => [name, value]));
  execFileSync('bash', ['-e', '-o', 'pipefail', '-c', script], { env, encoding: 'utf8' });
}

function evaluateDesktopConfigFilter(filter: string, files: string[]): string {
  const fileArgs = files.map((file) => JSON.stringify(file)).join(' ');
  const script = `FILES=$(printf '%s\\n' ${fileArgs}); ${filter}; printf '%s' "$DESKTOP_CONFIG"`;
  return execFileSync('bash', ['-euo', 'pipefail', '-c', script], { encoding: 'utf8' }).trim();
}

function workflowJobNames(workflow: string, label: string): string[] {
  const jobs: string[] = [];
  let inJobs = false;

  for (const line of workflow.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (inJobs && /^\S[^:]*:\s*$/.test(line)) {
      break;
    }
    const match = inJobs ? line.match(/^ {2}([A-Za-z0-9_-]+):(?:\s|$)/) : null;
    if (match?.[1]) {
      jobs.push(match[1]);
    }
  }

  assert.ok(jobs.length > 0, `${label} must define at least one job under jobs:`);
  return jobs;
}

// Maps a workflow's display name (`name:` at column 0) to its source, so the
// gate checks below key off the same names deploy-gate.yml's `workflow_run`
// trigger uses rather than a hand-maintained name-to-filename table.
//
// Two workflows sharing a display name would make this map silently keep one
// and drop the other, so the checks below could pass while the dropped
// workflow's jobs gate nothing. `workflow_run` matches by name too, so the
// ambiguity is real for the gate, not just for this test — fail on it here.
function gatedWorkflowSources(): Map<string, string> {
  const byName = new Map<string, string>();
  const filesByName = new Map<string, string>();

  for (const file of readdirSync(workflowsDir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))) {
    const source = read(resolve(workflowsDir, file));
    const name = source.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
    if (!name) continue;

    assert.ok(
      !filesByName.has(name),
      `workflows must have unique names; ${filesByName.get(name)} and ${file} are both named "${name}", so workflow_run and the deploy gate cannot tell them apart`,
    );
    filesByName.set(name, file);
    byName.set(name, source);
  }

  return byName;
}

// The check-run name GitHub publishes for a job: its `name:` override when it
// has one, otherwise the job id. A `name:` containing a `${{ … }}` expression
// (matrix fan-out) resolves per matrix entry, so no single literal name exists
// for the gate to match.
function effectiveCheckName(workflow: string, job: string): { name: string; templated: boolean } {
  const nameOverride = workflowJobBlock(workflow, job).match(/^ {4}name:\s*(.+)$/m)?.[1];
  if (!nameOverride) {
    return { name: job, templated: false };
  }

  const value = nameOverride.trim().replace(/^['"]|['"]$/g, '');
  return { name: value, templated: value.includes('${{') };
}

function parseJsonArrayLiteral(source: string, regex: RegExp, label: string): string[] {
  const match = source.match(regex);
  assert.ok(match?.[1], `deploy-gate.yml must define ${label}`);
  const parsed = JSON.parse(match[1]);
  assert.ok(Array.isArray(parsed), `${label} must be a JSON array`);
  for (const value of parsed) {
    assert.equal(typeof value, 'string', `${label} entries must be strings`);
  }
  return parsed;
}

function collectPackageLockfiles(): string[] {
  return execFileSync('git', ['ls-files', '*package-lock.json'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort();
}

function collectDockerfiles(): string[] {
  return execFileSync('git', ['ls-files', '*Dockerfile*'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /(^|\/)Dockerfile(\.|$)/.test(file))
    .sort();
}

function collectActionFiles(repoRoot: string): string[] {
  const workflows = readdirSync(resolve(repoRoot, '.github/workflows'))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`);
  const collectDefinitions = (dir: string): string[] => {
    if (!existsSync(resolve(repoRoot, dir))) return [];
    return readdirSync(resolve(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return collectDefinitions(path);
      return /^action\.ya?ml$/.test(entry.name) ? [path] : [];
    });
  };
  return [...workflows, ...collectDefinitions('.github/actions')].sort();
}

function unpinnedActionUses(source: string): string[] {
  type Step = { uses?: unknown; steps?: Step[]; parallel?: Step[] };
  const document = YAML.parse(source) as {
    jobs?: Record<string, Step>;
    runs?: { steps?: Step[] };
  } | null;
  const steps = [
    ...Object.values(document?.jobs ?? {}).flatMap((job) => [job, ...(job.steps ?? [])]),
    ...(document?.runs?.steps ?? []),
  ];
  const expandGroups = (entries: Step[]): Step[] => entries.flatMap((step) => [step, ...expandGroups(step.parallel ?? [])]);
  return expandGroups(steps).flatMap(({ uses }) => {
    if (uses === undefined) return [];
    if (typeof uses !== 'string') return [String(uses)];
    if (uses.startsWith('./')) return [];
    const pinned = uses.startsWith('docker://')
      ? /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/i.test(uses)
      : /^[^@\s]+@[0-9a-f]{40}$/i.test(uses);
    return pinned ? [] : [uses];
  });
}

describe('GitHub Actions pinning guard', () => {
  const sha = 'a'.repeat(40);
  const workflow = (uses: string) => `jobs:\n  check:\n    steps:\n      - uses: ${uses}\n`;

  it('rejects mutable actions in list entries, quoted values and flow mappings', () => {
    for (const source of [
      workflow('example/action@v1'),
      workflow('"example/action@main"'),
      'jobs: { check: { steps: [{ uses: example/action@v1 }] } }',
      workflow('example/action@abcdef0'),
      workflow('example/action'),
    ]) {
      assert.equal(unpinnedActionUses(source).length, 1, source);
    }
  });

  it('checks reusable workflow jobs and composite action steps', () => {
    assert.equal(unpinnedActionUses('jobs:\n  call:\n    uses: example/repo/.github/workflows/check.yml@main\n').length, 1);
    assert.equal(unpinnedActionUses('runs:\n  using: composite\n  steps:\n    - uses: example/action@v1\n').length, 1);
  });

  it('checks actions inside parallel groups in workflows and composites', () => {
    const steps = [{ parallel: [
      { name: 'Mutable action', uses: 'example/action@v1' },
      { parallel: [{ uses: 'example/action@main' }, { uses: `example/action@${sha}` }] },
    ] }];
    for (const document of [{ jobs: { check: { steps } } }, { runs: { using: 'composite', steps } }]) {
      assert.deepEqual(unpinnedActionUses(YAML.stringify(document)), ['example/action@v1', 'example/action@main']);
    }
  });

  it('allows full commit SHAs, local actions and immutable Docker actions', () => {
    for (const uses of [`example/action@${sha}`, `"example/action@${sha}"`, './.github/actions/local', `docker://alpine@sha256:${'b'.repeat(64)}`]) {
      assert.deepEqual(unpinnedActionUses(workflow(uses)), [], uses);
    }
    assert.deepEqual(unpinnedActionUses(`jobs:\n  call:\n    uses: example/repo/.github/workflows/check.yml@${sha}\n`), []);
  });

  it('rejects mutable Docker actions and malformed YAML', () => {
    assert.equal(unpinnedActionUses(workflow('docker://alpine:latest')).length, 1);
    assert.throws(() => unpinnedActionUses('jobs: [invalid'));
  });

  it('flags non-string uses values instead of skipping them', () => {
    assert.deepEqual(unpinnedActionUses('jobs:\n  check:\n    steps:\n      - uses:\n'), ['null']);
    assert.deepEqual(unpinnedActionUses(workflow('123')), ['123']);
  });

  it('ignores uses text inside shell scripts and action inputs', () => {
    assert.deepEqual(unpinnedActionUses('jobs:\n  check:\n    steps:\n      - run: |\n          uses: example/action@v1\n      - uses: ./.github/actions/local\n        with:\n          uses: example/input@v1\n'), []);
  });

  it('discovers workflows and nested composite definitions with either YAML extension', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'wm-action-pins-'));
    try {
      const files = ['.github/workflows/check.yml', '.github/workflows/release.yaml', '.github/actions/local/action.yml', '.github/actions/nested/local/action.yaml'];
      for (const file of [...files, '.github/actions/local/README.md']) {
        mkdirSync(dirname(resolve(dir, file)), { recursive: true });
        writeFileSync(resolve(dir, file), '');
      }
      assert.deepEqual(collectActionFiles(dir), files.sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('live cache sweep deployment timing', () => {
});

// #7593: a `deployment_status` trigger is privileged — repo secrets and a
// write-capable GITHUB_TOKEN are in scope — and these workflows check out
// `github.event.deployment.sha`, so a dependency install there would resolve
// THAT commit's lockfile and could write its package cache into the shared
// Actions cache scope that main-branch runs restore from. PR #7591 shipped
// exactly that shape (`cache: 'npm'` + `npm ci --ignore-scripts`) and the
// #7605 emergency revert removed it; this guard keeps it from coming back.
// Deliberately file-level and fail-closed: if a deployment_status workflow
// ever genuinely needs npm, extend this guard consciously with the
// event-scoping argument rather than special-casing around it.
describe('deployment_status triggers — npm cache scope hygiene (#7593)', () => {
  // Comment lines are not executable: the workflows themselves explain the
  // absence ("no npm ci", #7593) and must not self-trip the guard. Round-trip
  // through the YAML parser, which drops comments AND normalizes flow-map
  // inputs (with: {cache: 'npm'}) into the same block form the ban patterns
  // match, so neither spelling can hide behind syntax. If a future workflow
  // carries YAML this parser rejects, fall back to the plain comment-line
  // filter: weaker (comments survive), but the ban patterns themselves stay
  // fail-closed on whatever text remains.
  const executableText = (source: string): string =>
  {
    try {
      const doc = YAML.parse(source);
      return doc == null ? '' : YAML.stringify(doc);
    } catch {
      return source
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
    }
  }

  // Block-style (`on:\n  deployment_status:`) and flow-style (`on: [ … ]`)
  // triggers; the block is the `on:` value up to the next column-0 key. Both
  // forms tolerate a trailing YAML comment (`on: # ...`,
  // `deployment_status: # ...`) — the guard is fail-closed, so a comment must
  // never silently exclude a workflow from the sweep.
  const triggersOnDeploymentStatus = (source: string): boolean => {
    const flow = source.match(/^on:[ \t]*(?:#[^\n]*)?\s*\[([^\]]*)\]/m);
    if (flow) return /['"]?deployment_status['"]?/.test(flow[1]);
    const onIndex = source.search(/^on:(?:[ \t]*#[^\n]*)?\s*$/m);
    if (onIndex === -1) return false;
    const block = source.slice(onIndex).split(/\n(?=\S)/)[0];
    return /^ {2}deployment_status:(?:[ \t]*#[^\n]*)?\s*$/m.test(block);
  };

  // The two ban patterns and the single detection path both tests below read.
  // The sweep asserts real workflows stay clean; the self-test asserts the
  // patterns can still fire, so a corrupted pattern reddens this suite
  // instead of silently covering nothing.
  // After the YAML round-trip a truthy cache input always appears as a
  // block-mapping key, so the line-start anchor no longer depends on the
  // author's block vs flow-map spelling. Only falsy scalars (false, null, ~)
  // are exempt.
  const CACHE_BAN_PATTERN = /^[ \t]*cache:[ \t]*(?!false\b)(?!null\b)(?!~)[^\s#]/m;
  // `npm i` resolves the deployed SHA's lockfile exactly like `npm install`,
  // so the alias spelling is banned too, under any shell whitespace
  // (double space or a tab before the verb is the same command). The word
  // boundaries keep npm info, npm init and pnpm i out of the ban.
  const NPM_INSTALL_BAN_PATTERN = /\bnpm[ \t]+(?:ci|install|i)\b/;

  const deploymentCacheProblems = (executable: string): string[] => {
    const problems: string[] = [];
    if (CACHE_BAN_PATTERN.test(executable)) {
      problems.push(
        'a step carries a truthy `cache:` input, so a privileged deployment_status run could save a package cache resolved from github.event.deployment.sha',
      );
    }
    if (NPM_INSTALL_BAN_PATTERN.test(executable)) {
      problems.push("the job runs npm ci/install, resolving the deployed SHA's lockfile instead of main's");
    }
    return problems;
  };

  // The sweep only asserts the absence of offenders, so a ban pattern that
  // stopped matching (lost indentation anchor, dropped alternation branch)
  // would keep this suite green while the guard detects nothing. This
  // self-test feeds inline sources through the same deploymentCacheProblems
  // path the sweep uses and pins the firing half of the guard.
  it('keeps the ban patterns load-bearing: offenders fire and safe look-alikes stay silent (#7593)', () => {
    const cacheProblem =
      'a step carries a truthy `cache:` input, so a privileged deployment_status run could save a package cache resolved from github.event.deployment.sha';
    const npmProblem = "the job runs npm ci/install, resolving the deployed SHA's lockfile instead of main's";

    const offender = [
      'name: offender',
      'on:',
      '  deployment_status:',
      'jobs:',
      '  smoke:',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with:',
      "          cache: 'npm'",
      '      - run: npm ci --ignore-scripts --omit=optional',
    ].join('\n');
    assert.deepEqual(deploymentCacheProblems(executableText(offender)), [cacheProblem, npmProblem]);

    // Flow-map syntax must trip the same bans: the parser normalizes the
    // mapping, so the block-style fixture reshaped into a flow map detects
    // identically (review finding: line-anchored pattern missed
    // with: {node-version: '24', cache: 'npm'}).
    const flowMapOffender = [
      "name: flow-map-offender",
      'on:',
      '  deployment_status:',
      'jobs:',
      '  smoke:',
      '    steps:',
      "      - uses: actions/setup-node@v4",
      "        with: { node-version: '24', cache: 'npm' }",
      "      - run: npm ci --ignore-scripts --omit=optional",
    ].join('\n');
    assert.deepEqual(deploymentCacheProblems(executableText(flowMapOffender)), [cacheProblem, npmProblem]);

    const aliasOffender = offender.replace(
      'npm ci --ignore-scripts --omit=optional',
      'npm i --omit=optional',
    );
    assert.ok(
      deploymentCacheProblems(executableText(aliasOffender)).includes(npmProblem),
      'npm i must be flagged the same as npm install',
    );

    // Shell whitespace between npm and the verb is legal and equally
    // dangerous: double space and tab must fire like the single-space form
    // (review finding: literal single space escaped detection).
    for (const spaced of ['npm  ci --ignore-scripts', 'npm\tinstall --no-audit', 'npm\ti']) {
      assert.ok(
        deploymentCacheProblems(executableText(offender.replace('npm ci --ignore-scripts --omit=optional', spaced)))
          .includes(npmProblem),
        'irregular shell whitespace before the npm verb must not escape the ban: ' + spaced,
      );
    }

    for (const safe of [
      '        with:\n          cache: false',
      "      # cache: 'npm'",
      '        with:\n          cache-dependency-path: package-lock.json',
      '      - run: npm run build',
      "      - run: pnpm i --frozen-lockfile",
      "      - run: npm info webpack",
    ]) {
      assert.deepEqual(deploymentCacheProblems(executableText(safe)), [], `must not flag safe input:\n${safe}`);
    }

    // Both trigger spellings must stay recognized through a trailing YAML
    // comment, and a flow list without deployment_status must not be swept.
    assert.equal(
      triggersOnDeploymentStatus('on: # deploy hook\n  deployment_status: # success only'),
      true,
      'a trailing comment on either trigger line must not hide a deployment_status trigger',
    );
    assert.equal(triggersOnDeploymentStatus('on: [push, deployment_status]'), true);
    assert.equal(triggersOnDeploymentStatus('on: [push, workflow_dispatch]'), false);
  });
});

describe('CI workflow coverage', () => {

  it('runs the proto breaking check against the full main history (#6114)', () => {
    const breakingJob = workflowJobBlock(protoCheckWorkflow, 'proto-breaking');
    assert.match(breakingJob, /^\s+needs: changes\s*$/m);
    assert.match(
      breakingJob,
      /^\s+if: needs\.changes\.outputs\.breaking == 'true'\s*$/m,
      'proto-breaking must run for schema changes from both internal and fork pull requests',
    );
    const [checkoutStep] = workflowStepBlocksByUses(breakingJob, 'actions/checkout');
    assert.match(
      checkoutStep,
      /\n\s+with:\n\s+fetch-depth: 0\n/,
      'proto-breaking must fetch full history so the main baseline is available',
    );
    const breakingStep = workflowStepBlock(protoCheckWorkflow, 'Check for breaking proto changes');
    assert.match(
      breakingStep,
      /^\s+run: make breaking\s*$/m,
      'proto-check.yml must run the canonical buf breaking target against the fetched origin/main proto baseline',
    );
    assert.doesNotMatch(breakingStep, /^\s+continue-on-error:/m);

    // Pin the shared Makefile baseline. `run: make breaking` alone stays green if the
    // recipe regresses to proto/.git#branch=main (no repo) or loses origin/main.
    const makefile = read(resolve(root, 'Makefile'));
    assert.match(
      makefile,
      /^breaking:[^\n]*\n\tcd \$\(PROTO_DIR\) && buf breaking --against '\.\.\/\.git#branch=origin\/main,subdir=proto'\s*$/m,
      "make breaking must use '../.git#branch=origin/main,subdir=proto' from PROTO_DIR",
    );

    // Pin the documented FILE/PACKAGE/WIRE_JSON policy (binary WIRE intentionally off).
    const bufYaml = read(resolve(root, 'proto/buf.yaml'));
    const breakingUse = bufYaml.match(/\nbreaking:\n(?:[^\n]*\n)*?[ \t]+use:\n((?:[ \t]+-[^\n]*\n)+)/);
    assert.ok(breakingUse, 'proto/buf.yaml must declare breaking.use');
    const rules = [...breakingUse[1].matchAll(/^[ \t]+-[ \t]+(\S+)\s*$/gm)].map((m) => m[1]).sort();
    assert.deepEqual(
      rules,
      ['FILE', 'PACKAGE', 'WIRE_JSON'].sort(),
      'breaking.use must be exactly FILE, PACKAGE, WIRE_JSON (binary WIRE intentionally omitted)',
    );
  });

  it('keeps every smoke spec on the combined command and exactly one shard', () => {
    const ciSmoke = packageScripts['test:e2e:ci-smoke'] ?? '';
    // Tokenize as the shell would, and stop at the first comment token: npm
    // scripts run under `sh -c`, where a word-initial `#` comments out the
    // rest of the line. A substring check would stay green with the spec
    // paths sitting in the commented-out tail while playwright never runs
    // them — the argv-token check is what gives this guard teeth.
    const argvTokens = shellArgvTokens(ciSmoke);
    for (const spec of REQUIRED_CI_SMOKE_SPECS) {
      assert.ok(
        argvTokens.includes(spec),
        `test:e2e:ci-smoke must pass ${spec} as a live argv token — a spec dropped ` +
          '(or commented out) from this command has no other CI invocation',
      );
      assert.ok(
        existsSync(resolve(root, spec)),
        `${spec} must exist on disk — a missing file would only fail once Playwright starts`,
      );
    }
    assert.ok(
      argvTokens.includes('VITE_VARIANT=full'),
      'test:e2e:ci-smoke must pin VITE_VARIANT=full — variant-live-smoke asserts the full-variant panel set',
    );

    const smokeSpecs = argvTokens.filter((token) => token.startsWith('e2e/') && token.endsWith('.spec.ts'));
    assert.equal(new Set(smokeSpecs).size, smokeSpecs.length, 'test:e2e:ci-smoke must not repeat a spec');
    assert.deepEqual(
      [...smokeSpecs].sort(),
      [...REQUIRED_CI_SMOKE_SPECS].sort(),
      'test:e2e:ci-smoke must contain exactly the pinned smoke-spec inventory',
    );
    // One script per CI shard, read from the matrix so adding a shard without
    // its spec list (or the reverse) fails here.
    const smokeShards: number[] = YAML.parse(testWorkflow).jobs['variant-smoke-shards'].strategy.matrix.shard;
    assert.deepEqual(smokeShards, smokeShards.map((_, i) => i + 1), 'smoke shard indices must be 1..N');
    const shardScripts = Object.keys(packageScripts).filter((name) => /^test:e2e:ci-smoke:\d+$/.test(name));
    assert.deepEqual(
      shardScripts.sort(),
      smokeShards.map((n) => `test:e2e:ci-smoke:${n}`).sort(),
      'package.json must define exactly one test:e2e:ci-smoke:<n> script per CI smoke shard',
    );
    const shardSpecs = smokeShards.map((n) => `test:e2e:ci-smoke:${n}`).map((script) => {
      const command = packageScripts[script] ?? '';
      const tokens = shellArgvTokens(command);
      assert.deepEqual(
        tokens.slice(0, 4),
        ['cross-env', 'VITE_VARIANT=full', 'playwright', 'test'],
        `${script} must invoke the full-variant Playwright command before its smoke specs`,
      );
      const specs = tokens.filter((token) => token.startsWith('e2e/') && token.endsWith('.spec.ts'));
      assert.ok(specs.length > 0, `${script} must pass smoke specs as live argv tokens`);
      assert.equal(new Set(specs).size, specs.length, `${script} must not repeat a spec`);
      return specs;
    });
    const allShardSpecs = shardSpecs.flat();
    assert.equal(new Set(allShardSpecs).size, allShardSpecs.length, 'ci-smoke shards must be disjoint');
    assert.ok(shardSpecs.every((specs) => specs.length > 0), 'no ci-smoke shard may be empty');
    assert.deepEqual(
      [...allShardSpecs].sort(),
      [...REQUIRED_CI_SMOKE_SPECS].sort(),
      'the ci-smoke shard union must equal the pinned smoke-spec inventory',
    );
  });

  // The Redis-backed suites self-skip without the binaries, so the install must
  // fail loudly, and it must not wait on the Ubuntu mirror: a slow mirror put
  // 24-58s on the slowest unit shard in 9 of 12 runs (run 39922207309: 29s for
  // 1.5 MB at 51 kB/s).
  it('installs Redis in every unit shard from a package cache with dpkg, and fails without the binaries', () => {
    const unitSteps = YAML.parse(testWorkflow).jobs['unit-shards'].steps
      .flatMap((step: { parallel?: unknown[] }) => step.parallel ?? [step]);
    const redis = unitSteps.find((step: { uses?: string }) => step.uses === './.github/actions/install-redis');
    assert.ok(redis, 'unit shards must install Redis through the cached action');
    assert.equal(redis['continue-on-error'], undefined, 'a failed Redis install must fail the shard');
    assert.equal(unitSteps.some((step: { run?: string }) => /apt-get install[^\n]*redis-server/.test(step.run ?? '')), false,
      'unit shards must not install Redis from the mirror directly');

    const steps = YAML.parse(read(resolve(root, '.github/actions/install-redis/action.yml'))).runs.steps;
    const restore = steps.find((step: { id?: string }) => step.id === 'redis-debs');
    assert.match(restore.uses, /^actions\/cache\/restore@[a-f0-9]{40}$/);
    const download = steps.find((step: { name?: string }) => step.name === 'Download Redis packages on cache miss');
    assert.equal(download.if, "steps.redis-debs.outputs.cache-hit != 'true'");
    assert.match(download.run, /--download-only/);
    // download() runs before ||, so without errexit: a failed dependency
    // download must fail the function, or the stale-index refresh is skipped.
    assert.match(download.run, /redis-server redis-tools \\\n\s*&& \(cd ~\/\.cache\/wm-redis-debs && sudo apt-get download redis-server redis-tools\)/);
    // ...and a failed download refreshes the stale index, then retries once.
    assert.match(download.run, /\ndownload \|\| \{ sudo apt-get update -qq && download; \}\n/);
    const install = steps.find((step: { name?: string }) => step.name === 'Install Redis packages');
    assert.match(install.run, /sudo dpkg -i "\$\{debs\[@\]\}"/);
    assert.doesNotMatch(install.run, /apt-get install[^\n]*\.deb/, 'apt-get must not install the cached .deb paths');
    assert.match(install.run, /redis-server --version/);
    assert.match(install.run, /redis-cli --version/);
    assert.equal(install['continue-on-error'], undefined);
    const save = steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/cache/save@'));
    assert.equal(save.if, download.if);
  });

  it('requires real Redis before the consumer-prices publisher regressions', () => {
    const steps = YAML.parse(testWorkflow).jobs['consumer-prices'].steps;
    const installIndex = steps.findIndex((step: { uses?: string }) => step.uses === './.github/actions/install-redis');
    const testIndex = steps.findIndex((step: { run?: string }) => step.run === 'npm test --prefix consumer-prices-core');
    assert.ok(installIndex >= 0 && installIndex < testIndex, 'consumer-prices must install Redis before its tests');
    assert.equal(steps[installIndex].if, undefined, 'Redis must be installed on every consumer-prices run');
    assert.equal(steps[installIndex]['continue-on-error'], undefined, 'Redis installation failure must fail CI');
    assert.equal(steps[testIndex]['continue-on-error'], undefined, 'publisher regression failure must fail CI');
  });

  it('shares tracked edge bundle discovery with pre-push', () => {
    const edgeBundleStep = workflowStepBlock(testWorkflow, 'Edge function bundle check');
    assert.match(
      edgeBundleStep,
      /^\s+run: node scripts\/check-edge-function-bundles\.mjs --caller=ci\s*$/m,
    );
    assert.doesNotMatch(edgeBundleStep, /find api\//);
  });

  it('routes generated OpenAPI artifacts into the owning unit job (#6558, #6650)', () => {
    // Executes the real awk rather than matching its source. These artifacts
    // live under `docs/`, which the blanket `/^docs\// { next }` rule excludes,
    // so the carve-outs are the only thing keeping an OpenAPI-only PR from
    // setting code=false and skipping the contract tests in `unit`.
    const awkBlock = shellAwkAssignmentBlock('CODE');
    const codeFilterSays = (path: string) => evaluateAwkAssignmentBlock(awkBlock, [path]) > 0;

    assert.ok(
      codeFilterSays('docs/api/worldmonitor.openapi.yaml'),
      'a PR that only regenerates the unified OpenAPI bundle must still run the unit job',
    );
    for (const path of [
      'docs/api/MarketService.openapi.json',
      'docs/api/MarketService.openapi.yaml',
    ]) {
      assert.ok(
        codeFilterSays(path),
        `${path} must set code=true so the OpenAPI filter-parameter contract test runs`,
      );
    }
    // Prose under docs/ stays excluded — the carve-out is for the machine
    // artifact, not for the directory.
    for (const path of ['docs/api-reference.mdx', 'docs/perf/openapi-bundle-capacity-2026-08-13.md']) {
      assert.ok(!codeFilterSays(path), `${path} must not set code=true`);
    }

    const unit = testJobBlock('unit-built-output');
    assert.match(
      unit,
      /^\s+run: node scripts\/openapi-capacity-report\.mjs --out "\$RUNNER_TEMP\/openapi-capacity\.json"\s*$/m,
      'unit job must publish the OpenAPI capacity report',
    );
    // No `--budget`: the step must measure against the real 950,000 guard. The
    // flag exists for local what-if analysis and to exercise the over-budget
    // exit in tests, and passing it here would be the one-line way to make the
    // reported headroom mean nothing.
    assert.ok(
      !/openapi-capacity-report\.mjs[^\n]*--budget/.test(unit),
      'the CI step must not override the scanner budget',
    );
    assert.match(
      unit,
      /name: openapi-capacity-\$\{\{ github\.run_attempt \}\}/,
      'the capacity artifact name must carry run_attempt — upload-artifact v6 rejects a duplicate name within a run, which collides on the re-run started to chase the failure',
    );
    assert.match(
      unit,
      /path: \$\{\{ runner\.temp \}\}\/openapi-capacity\.json/,
      'the capacity artifact must be read from the same path the step wrote',
    );
    // `if: failure()` would publish nothing on a green run and `if: success()`
    // nothing on a red one; the breakdown is worth reading in both cases, and
    // an over-budget run is when it matters most. Narrowing this to either
    // would stop publishing on exactly the runs someone goes looking for it.
    const upload = unit.slice(unit.indexOf('- name: Upload OpenAPI capacity report'));
    assert.match(
      upload.slice(0, upload.indexOf('- name: ', 1)),
      /if: \$\{\{ !cancelled\(\) \}\}/,
      'the capacity artifact must be uploaded whether the step passed or failed',
    );
    // The report must run BEFORE the suite: an over-budget artifact fails
    // test:data anyway, and failing at the front costs 30s instead of 10min.
    assert.ok(
      unit.indexOf('openapi-capacity-report.mjs') < unit.indexOf('npm run test:data'),
      'the capacity report must run before the test suite',
    );
  });



  it('path-filters Test jobs on push to main instead of compiling everything', () => {
    const changes = testWorkflow.slice(testWorkflow.indexOf('id: diff'));
    const pushGate = changes.slice(0, changes.indexOf('CODE=$('));
    assert.match(
      pushGate,
      /compare\/\$\{BEFORE\}\.\.\.\$\{\{ github\.sha \}\}/,
      'push to main must classify files from the compare API',
    );
    assert.match(
      pushGate,
      /No usable parent SHA; running every Test job/,
      'a zero parent SHA must fail open',
    );
    assert.match(
      pushGate,
      /Compare listing is truncated at 300 files; running every Test job/,
      'a truncated compare must fail open',
    );
    assert.match(pushGate, /emit_all_true/);
    assert.ok(
      pushGate.indexOf('compare/${BEFORE}') < pushGate.lastIndexOf('emit_all_true'),
      'the compare must run; fail-open is only the truncated/error path',
    );
  });

  it('keeps GitHub Actions external uses pinned to commit SHAs', () => {
    const failures = collectActionFiles(root).flatMap((file) =>
      unpinnedActionUses(read(resolve(root, file))).map((uses) => `${file}: ${uses}`),
    );

    assert.deepEqual(
      failures,
      [],
      `GitHub Actions uses refs must be full commit SHAs or Docker digests:\n${failures.join('\n')}`,
    );
  });
});

describe('scheduled workflows run only in the upstream repository', () => {
  // A public repo's forks inherit every cron. Forks that enable Actions then
  // probe production on our schedule: one day of MCP smoke traffic came from
  // ~1,600 runner IPs against ~17 upstream runs. Push, PR and manual runs in
  // forks stay allowed; only the fork's own schedule is skipped.
  const FORK_GUARD = "github.event_name != 'schedule' || github.repository == 'koala73/worldmonitor'";

  it('every job in a scheduled workflow carries the fork guard', () => {
    const missing: string[] = [];
    for (const name of readdirSync(workflowsDir).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))) {
      const workflow = YAML.parse(read(resolve(workflowsDir, name)));
      const on = workflow.on ?? workflow[true as unknown as string];
      if (!on || typeof on !== 'object' || !('schedule' in on)) continue;
      for (const [jobId, job] of Object.entries(workflow.jobs as Record<string, { if?: unknown }>)) {
        if (!String(job.if ?? '').includes(FORK_GUARD)) missing.push(`${name}#${jobId}`);
      }
    }
    assert.deepEqual(missing, [], `add \`(${FORK_GUARD})\` to the job-level if of: ${missing.join(', ')}`);
  });

  it('skips only a fork\'s own scheduled run', () => {
    const cases: Array<[string, string, boolean]> = [
      ['schedule', 'koala73/worldmonitor', true],
      ['schedule', 'someone/worldmonitor', false],
      ['push', 'someone/worldmonitor', true],
      ['pull_request', 'someone/worldmonitor', true],
      ['workflow_dispatch', 'someone/worldmonitor', true],
    ];
    for (const [event_name, repository, expected] of cases) {
      assert.equal(runInNewContext(FORK_GUARD, { github: { event_name, repository } }), expected, `${event_name} in ${repository}`);
    }
  });
});

describe('Rust toolchain pin', () => {
});
