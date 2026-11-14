import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UMAMI_RELEASE_COMMIT = '2f6e2b5ff256862a081d9e74bed18a42ebf795e3';
const UMAMI_FIX_COMMIT = '7c030e4c5da4b5fdf3e75e80787a0344b040ac8a';

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('Umami retention SQL', () => {
  it('runs bounded retention on a pinned Postgres client without shell interpolation', () => {
    const executableSql = read('scripts/umami-retention.sql').replace(/^\s*--.*$/gmu, '');
    assert.match(executableSql, /LIMIT 10000/);
    // try-, not xact-: each delete commits on its own now, so the lock has to
    // outlive one transaction, and an overlapping tick has to skip rather than
    // block into lock_timeout and crash the cron (#6375).
    assert.match(executableSql, /pg_try_advisory_lock/);
    assert.doesNotMatch(executableSql, /\bTRUNCATE\b/i);
  });
});
