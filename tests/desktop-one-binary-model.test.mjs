import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import { SUPPORTED_VARIANTS } from '../api/download.js';
import { SITE_VARIANTS } from '../src/config/variant.ts';

// #5908 was not one bug — it was five surfaces disagreeing about whether the
// desktop app ships one binary or one binary per variant. The endpoints, the
// workflow, the packager, the switcher, and the docs each encoded a different
// answer, and nothing failed when they drifted. These assertions are the
// agreement itself: the model is "one published binary, variants switch
// in-app", and every surface has to keep saying so.
//
// This file is a verification mechanism, so it is written to fail loudly rather
// than silently cover less than it claims: every lookup that could return
// `undefined` after a rename is asserted to have found something, and the
// release-publisher scan walks ALL workflows rather than trusting a filename.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readRepoFile = (relPath) => readFileSync(resolve(root, relPath), 'utf8');

const pkg = JSON.parse(readRepoFile('package.json'));
const workflowsDir = resolve(root, '.github/workflows');
const workflowFiles = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));

const workflows = new Map(
  workflowFiles.map((f) => [f, loadYaml(readFileSync(resolve(workflowsDir, f), 'utf8'))])
);

const allJobSteps = (doc) =>
  Object.values(doc?.jobs ?? {}).flatMap((job) => job?.steps ?? []);

/** Every Tauri build across every workflow — release legs and the canary alike. */
function tauriBuilders() {
  const builders = [];
  for (const [file, doc] of workflows) {
    for (const step of allJobSteps(doc)) {
      if (String(step?.uses ?? '').startsWith('tauri-apps/tauri-action')) {
        builders.push({ file, step });
      }
    }
  }
  return builders;
}

/**
 * Builds that actually cut a release. tauri-action publishes only when given a
 * `tagName`, so a build without one (the Linux canary) ships nothing.
 */
function releasePublishers() {
  return tauriBuilders().filter(({ step }) => step.with?.tagName);
}

/** Find exactly one step by name, so a duplicate decoy cannot satisfy the lookup. */
function theStepNamed(steps, name) {
  const matches = steps.filter((step) => step.name === name);
  assert.equal(
    matches.length,
    1,
    `expected exactly one step named "${name}" — 0 means this guard silently stopped checking anything, >1 means a decoy can satisfy it`
  );
  return matches[0];
}

test('/api/download accepts exactly the variants the in-app switcher offers', () => {
  // `world` is a legacy alias for `full` kept for existing download links; it is
  // deliberately not a switcher target.
  const expected = new Set([...SITE_VARIANTS, 'world']);
  assert.deepEqual(
    [...SUPPORTED_VARIANTS].sort(),
    [...expected].sort(),
    'A variant the switcher offers but /api/download rejects gives that user a 302 to the releases page instead of a download; the reverse advertises a variant the product does not have.'
  );
});

test('no npm script builds or packages a per-variant desktop binary', () => {
  const offenders = Object.entries(pkg.scripts)
    .filter(([name, body]) => {
      if (!name.startsWith('desktop:')) return false;
      // Any variant other than full, any variant flag, any alternate config —
      // matched by shape rather than by the tech/finance names that happened to
      // exist when this was written.
      const variantEnv = body.match(/VITE_VARIANT=(\w+)/);
      return (
        (variantEnv && variantEnv[1] !== 'full')
        || /--variant/.test(body)
        || /--config\s+src-tauri\//.test(body)
      );
    })
    .map(([name]) => name);
  assert.deepEqual(offenders, [], 'desktop packaging is variant-agnostic under the one-binary model');
});

test('the desktop updater does not request a per-variant download asset', () => {
  const updater = readRepoFile('src/app/desktop-updater.ts');
  assert.match(
    updater,
    /api\/download\?platform=\$\{platform\}`/,
    'the download URL must be exactly the platform query'
  );
  assert.doesNotMatch(
    updater,
    /[?&]variant=/,
    'Asking /api/download for a per-variant asset can only ever 302 to the releases page.'
  );
  // A query built via URLSearchParams would carry no literal `variant=`, so the
  // regex above would miss it.
  assert.doesNotMatch(updater, /URLSearchParams|searchParams\.(set|append)/);
});

test('/api/download applies the binary-identity filter on every path', () => {
  // The updater sends no variant, so a variant-gated filter would leave the
  // app's own download unfiltered.
  const handler = readRepoFile('api/download.js');
  assert.match(handler, /const asset = findDesktopAsset\(assets, matcher\);/);
  assert.doesNotMatch(
    handler,
    /variant\s*\?\s*findDesktopAsset/,
    'the identity filter must not be conditional on variant'
  );
});
