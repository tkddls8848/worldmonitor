/**
 * Operator retraction CLI (#5743).
 *
 * The argument rules here decide whether an intelligence record is deleted
 * from a durable, agent-facing archive, so they are tested as logic rather
 * than exercised by hand: a flag that silently swallows the next flag as its
 * value would record "--dry-run" as the audit reason for a deletion, and a
 * `--restore` that accepted a document id would send a request that can never
 * resolve.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RETRACT_MAX_IDENTIFIERS,
  parseRetractArgs,
  resolveRetractTarget,
  runRetractCli,
} from '../scripts/retract-intel-history.mjs';
import { INTEL_HISTORY_DIMS, openIntelHistoryStore } from '../shared/intel-history-store.mjs';

const ENV = {};

describe('parseRetractArgs', () => {
  it('builds a retract payload from mixed ids and dedupe keys', () => {
    const parsed = parseRetractArgs([
      '--id',
      'doc-1',
      '--dedupe-key',
      'energy:intelligence:abc',
      '--id',
      'doc-2',
      '--reason',
      '  poisoned RSS item, #5743  ',
    ]);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, 'retract');
    assert.deepEqual(parsed.payload, {
      ids: ['doc-1', 'doc-2'],
      dedupeKeys: ['energy:intelligence:abc'],
      reason: 'poisoned RSS item, #5743',
    });
  });

  it('requires a reason when retracting', () => {
    const parsed = parseRetractArgs(['--dedupe-key', 'k']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--reason is required/);
  });

  it('requires at least one identifier', () => {
    const parsed = parseRetractArgs(['--reason', 'why']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /at least one --id or --dedupe-key/);
  });

  // A flag-shaped value is the failure that matters: `--reason --dry-run`
  // would otherwise retract for the stated reason "--dry-run" AND send the
  // request the operator meant to preview.
  for (const argv of [
    ['--reason'],
    ['--reason', '--dry-run', '--dedupe-key', 'k'],
    ['--dedupe-key', '--reason', 'why'],
    ['--id'],
  ]) {
    it(`rejects a missing or flag-shaped value: ${JSON.stringify(argv)}`, () => {
      const parsed = parseRetractArgs(argv);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error, /requires a value/);
    });
  }

  it('rejects more identifiers than the relay accepts in one call', () => {
    const argv = [];
    for (let i = 0; i <= RETRACT_MAX_IDENTIFIERS; i++) {
      argv.push('--dedupe-key', `k-${i}`);
    }
    argv.push('--reason', 'sweep');

    const parsed = parseRetractArgs(argv);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /at most 100 identifiers/);
  });

  it('rejects an identifier with leading or trailing whitespace', () => {
    // Caught at the CLI so a copy-paste typo is an actionable message rather
    // than a 400 — and never a request that tombstones the typo and reports
    // success while the real record stays live.
    for (const argv of [
      ['--dedupe-key', ' energy:intelligence:abc', '--reason', 'r'],
      ['--dedupe-key', 'energy:intelligence:abc ', '--reason', 'r'],
      ['--id', ' abc', '--reason', 'r'],
    ]) {
      const parsed = parseRetractArgs(argv);
      assert.equal(parsed.ok, false, `${JSON.stringify(argv)} must be rejected`);
      assert.match(parsed.error, /leading or trailing whitespace/);
    }
  });

  it('rejects --list combined with retraction arguments', () => {
    // --list used to win outright, so this listed the tombstones and exited 0
    // having retracted nothing.
    const parsed = parseRetractArgs(['--list', '--dedupe-key', 'k', '--reason', 'r']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--list cannot be combined with/);

    const limitOutsideList = parseRetractArgs(['--dedupe-key', 'k', '--reason', 'r', '--limit', '5']);
    assert.equal(limitOutsideList.ok, false);
    assert.match(limitOutsideList.error, /--limit applies to --list only/);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    const parsed = parseRetractArgs(['--purge-all', '--reason', 'x']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /unknown argument: --purge-all/);
  });

  it('builds a restore payload from dedupe keys alone', () => {
    const parsed = parseRetractArgs(['--restore', '--dedupe-key', 'k1', '--dedupe-key', 'k2']);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, 'restore');
    assert.deepEqual(parsed.payload, { dedupeKeys: ['k1', 'k2'] });
  });

  it('rejects --restore with a document id, which cannot resolve', () => {
    const parsed = parseRetractArgs(['--restore', '--id', 'doc-1']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--dedupe-key only/);
  });

  it('parses a bounded list request', () => {
    assert.deepEqual(parseRetractArgs(['--list']), {
      ok: true,
      mode: 'list',
      payload: {},
      dryRun: false,
    });
    assert.deepEqual(parseRetractArgs(['--list', '--limit', '5']).payload, { limit: 5 });

    for (const bad of ['0', '-3', '2.5', 'many']) {
      const parsed = parseRetractArgs(['--list', '--limit', bad]);
      assert.equal(parsed.ok, false, `--limit ${bad} must be rejected`);
      assert.match(parsed.error, /positive integer/);
    }
  });

  it('rejects --list combined with --restore', () => {
    const parsed = parseRetractArgs(['--list', '--restore']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /mutually exclusive/);
  });

  it('treats --help as a success, not a usage failure', async () => {
    const { code, lines } = await runRetractCli(['--help'], { env: ENV });
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /Usage:/);
  });
});

describe('resolveRetractTarget', () => {
  it('uses WM_INTEL_HISTORY_DB and needs no credential', () => {
    assert.deepEqual(resolveRetractTarget({ WM_INTEL_HISTORY_DB: 'C:/data/history.sqlite' }), {
      ok: true,
      dbPath: 'C:/data/history.sqlite',
    });
  });

  it('falls back to the repo .personal database', () => {
    const target = resolveRetractTarget({});
    assert.equal(target.ok, true);
    assert.match(target.dbPath.replaceAll('\\', '/'), /\/\.personal\/intel-history\.sqlite$/);
  });
});

describe('runRetractCli', () => {
  const dirs = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

  /** A temp database seeded with one stored record; returns the CLI env. */
  function seededEnv() {
    const dir = mkdtempSync(join(tmpdir(), 'retract-cli-'));
    dirs.push(dir);
    const file = join(dir, 'history.sqlite');
    const store = openIntelHistoryStore(file);
    try {
      store.append({
        domain: 'energy',
        resource: 'intelligence',
        runId: 'run-1',
        records: [{
          dedupeKey: 'energy:intelligence:abc',
          title: 'Poisoned headline',
          occurredAt: Date.now(),
          embedding: new Array(INTEL_HISTORY_DIMS).fill(0.1),
        }],
      });
    } finally {
      store.close();
    }
    return { env: { WM_INTEL_HISTORY_DB: file }, file };
  }

  function rows(file) {
    const store = openIntelHistoryStore(file, { readOnly: true });
    try {
      return store.timeline({ domain: 'energy' }).records;
    } finally {
      store.close();
    }
  }

  it('retracts a stored record by dedupe key and keeps it out', async () => {
    const { env, file } = seededEnv();

    const { code, lines } = await runRetractCli(
      ['--dedupe-key', 'energy:intelligence:abc', '--reason', 'poisoned'],
      { env },
    );

    assert.equal(code, 0, lines.join('\n'));
    assert.match(lines.join('\n'), /"tombstoned": 1/);
    assert.match(lines.join('\n'), /"deleted": 1/);
    // An operator who re-queries immediately may still see the record through
    // the read cache; if the tool does not say why, the obvious read is "the
    // retraction failed".
    assert.match(lines.join('\n'), /Allow ~1 hour/);
    assert.equal(rows(file).length, 0);
  });

  it('retracts by record id', async () => {
    const { env, file } = seededEnv();
    const [record] = rows(file);

    const { code, lines } = await runRetractCli(['--id', record.id, '--reason', 'wrong'], { env });

    assert.equal(code, 0, lines.join('\n'));
    assert.match(lines.join('\n'), /energy:intelligence:abc/);
    assert.equal(rows(file).length, 0);
  });

  it('restores and lists through the same database', async () => {
    const { env } = seededEnv();
    await runRetractCli(['--dedupe-key', 'energy:intelligence:abc', '--reason', 'poisoned'], { env });

    const listed = await runRetractCli(['--list'], { env });
    assert.equal(listed.code, 0);
    assert.match(listed.lines.join('\n'), /"reason": "poisoned"/);
    assert.doesNotMatch(listed.lines.join('\n'), /Allow ~1 hour/);

    const restored = await runRetractCli(['--restore', '--dedupe-key', 'energy:intelligence:abc'], { env });
    assert.equal(restored.code, 0);
    assert.match(restored.lines.join('\n'), /"restored": 1/);
    assert.doesNotMatch(restored.lines.join('\n'), /Allow ~1 hour/);

    const after = await runRetractCli(['--list'], { env });
    assert.match(after.lines.join('\n'), /"records": \[\]/);
  });

  it('exits non-zero when restore leaves requested keys untouched', async () => {
    const { env } = seededEnv();
    await runRetractCli(['--dedupe-key', 'restored-key', '--reason', 'r'], { env });

    const { code, lines } = await runRetractCli(
      ['--restore', '--dedupe-key', 'restored-key', '--dedupe-key', 'missing-key'],
      { env },
    );

    assert.equal(code, 1);
    assert.match(lines.join('\n'), /missing-key/);
    assert.match(lines.join('\n'), /partial/);
  });

  it('changes nothing on --dry-run', async () => {
    const { env, file } = seededEnv();
    let opened = 0;

    const { code, lines } = await runRetractCli(
      ['--dedupe-key', 'energy:intelligence:abc', '--reason', 'why', '--dry-run'],
      { env, openStore: () => { opened += 1; throw new Error('must not open'); } },
    );

    assert.equal(code, 0);
    assert.equal(opened, 0, 'a dry run must not open the store');
    assert.match(lines.join('\n'), /\[dry-run\] retract on /);
    assert.equal(rows(file).length, 1);
  });

  it('surfaces a store rejection as a non-zero exit', async () => {
    const { env } = seededEnv();

    const { code, lines } = await runRetractCli(['--id', '999999', '--reason', 'why'], { env });

    assert.equal(code, 1);
    assert.match(lines.join('\n'), /retract failed/);
    assert.match(lines.join('\n'), /no identifier resolved/);
    assert.doesNotMatch(lines.join('\n'), /Allow ~1 hour/, 'no reassurance on a failed request');
  });

  it('returns its failure result when the database cannot be opened', async () => {
    for (const err of [new Error('unable to open database file'), new Error('database is locked')]) {
      const { code, lines } = await runRetractCli(
        ['--dedupe-key', 'k', '--reason', 'why'],
        { env: { WM_INTEL_HISTORY_DB: 'C:/nowhere/history.sqlite' }, openStore: () => { throw err; } },
      );
      assert.equal(code, 1);
      assert.match(lines.join('\n'), /retract failed on /);
    }
  });

  it('a review never creates a missing database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'retract-cli-'));
    dirs.push(dir);
    const file = join(dir, 'absent.sqlite');

    const { code } = await runRetractCli(['--list'], { env: { WM_INTEL_HISTORY_DB: file } });

    assert.equal(code, 1);
    assert.equal(existsSync(file), false);
  });

  it('warns loudly about ids that resolved to nothing', async () => {
    const { env } = seededEnv();

    const { code, lines } = await runRetractCli(
      ['--id', '424242', '--dedupe-key', 'energy:intelligence:abc', '--reason', 'mixed'],
      { env },
    );

    const out = lines.join('\n');
    // Non-zero: a partial application left named identities unsuppressed, and
    // a scripted `retract ... || alert` must not stay silent on that.
    assert.equal(code, 1);
    assert.match(out, /FAILED: 1 id\(s\) did not resolve and were NOT tombstoned/);
    assert.match(out, /424242/);
    assert.match(out, /partial/i);
  });

  it('tells the operator when the retraction list was truncated', async () => {
    const { env } = seededEnv();
    await runRetractCli(['--dedupe-key', 'a', '--dedupe-key', 'b', '--reason', 'r'], { env });

    const { lines } = await runRetractCli(['--list', '--limit', '1'], { env });
    assert.match(lines.join('\n'), /raise --limit/);
  });
});
