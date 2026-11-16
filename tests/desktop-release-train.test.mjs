import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

import {
  compareReleaseVersions,
  releaseVersionFromTag,
  resolveDesktopRelease,
} from '../scripts/resolve-desktop-release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientEnv = Object.fromEntries([
  'VITE_CLERK_PUBLISHABLE_KEY', 'VITE_WS_RELAY_URL', 'VITE_PMTILES_URL_PUBLIC', 'CONVEX_URL',
].map((key) => [key, 'fixture-configured']));

test('release version comparison is numeric and strict', () => {
  assert.equal(compareReleaseVersions('2.10.0', '2.5.23'), 1);
  assert.equal(compareReleaseVersions('2.5.23', '2.5.23'), 0);
  assert.equal(compareReleaseVersions('2.4.99', '2.5.0'), -1);
  assert.throws(() => compareReleaseVersions('2.10.0-beta.1', '2.5.23'), /strict MAJOR\.MINOR\.PATCH/);
  assert.throws(() => compareReleaseVersions(' 2.10.0', '2.5.23'), /strict MAJOR\.MINOR\.PATCH/);
  assert.throws(() => compareReleaseVersions('999999999999999999.0.0', '2.5.23'), /safe integer range/);
  assert.throws(() => releaseVersionFromTag('v2.10.0-tech'), /vMAJOR\.MINOR\.PATCH/);
});

test('release resolution only advances when package.json is newer', () => {
  assert.deepEqual(
    resolveDesktopRelease({ packageVersion: '2.10.0', latestReleaseTag: 'v2.5.23' }),
    {
      action: 'release',
      tag: 'v2.10.0',
      latestReleaseTag: 'v2.5.23',
      reason: 'v2.10.0 is newer than published v2.5.23',
    },
  );
  assert.equal(resolveDesktopRelease({ packageVersion: '2.5.23', latestReleaseTag: 'v2.5.23' }).action, 'noop');
  assert.equal(resolveDesktopRelease({ packageVersion: '2.5.22', latestReleaseTag: 'v2.5.23' }).action, 'noop');
  assert.equal(resolveDesktopRelease({ packageVersion: '2.5.23' }).action, 'release');
  assert.throws(
    () => resolveDesktopRelease({ packageVersion: '2.10.0', latestReleaseTag: 'release-2.5.23' }),
    /vMAJOR\.MINOR\.PATCH/,
  );
});
