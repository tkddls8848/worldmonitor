#!/usr/bin/env node
/**
 * Operator tool for retracting records from the intel-history store (#5743).
 *
 * The store is agent-facing and durable for the full 180-day retention window,
 * so a poisoned or factually wrong feed item is retrievable — by semantic
 * search, timeline read, and precedent match — for months after the live
 * snapshot that produced it has rolled over. This is the supported way to take
 * one back.
 *
 * A retraction does two things: it deletes the stored rows, and it tombstones
 * their `dedupeKey` so the producing seeder — still reading the same unchanged
 * upstream feed — cannot re-add them on its next tick. Deleting alone is
 * undone within the hour. See `retract` in scripts/lib/intel-history-store.mjs.
 *
 * Usage:
 *   # find the record first — every retrieval path projects `id` and the
 *   # seeder-side `dedupeKey` convention is ${domain}:${resource}:${stableId}
 *   node scripts/retract-intel-history.mjs \
 *     --id <record-id> --reason "poisoned RSS item, #5743"
 *   node scripts/retract-intel-history.mjs \
 *     --dedupe-key energy:intelligence:oilprice-9f3a-1780000000000 \
 *     --reason "instruction-shaped headline"
 *
 *   # undo a retraction (lifts the tombstone; does NOT resurrect the row —
 *   # the seeder re-appends only if the event is still in its live window)
 *   node scripts/retract-intel-history.mjs --restore --dedupe-key <key>
 *
 *   # review what is currently suppressed
 *   node scripts/retract-intel-history.mjs --list
 *
 * Both --id and --dedupe-key are repeatable and may be combined. --dry-run
 * prints the resolved request without applying it.
 *
 * Environment: WM_INTEL_HISTORY_DB (optional; defaults to
 * <repo>/.personal/intel-history.sqlite), read from the checkout's `.env.local`
 * exactly as every seeder does.
 */

import { loadEnvFile } from './_seed-utils.mjs';
import { openIntelHistoryStore, resolveIntelHistoryDbPath } from './lib/intel-history-store.mjs';

/** Matches the per-call cap the store enforces (scripts/lib/intel-history-store.mjs). */
export const RETRACT_MAX_IDENTIFIERS = 100;

const OPERATIONS = {
  retract: 'retract',
  restore: 'restore',
  list: 'listRetractions',
};

export const USAGE = `Usage:
  retract   node scripts/retract-intel-history.mjs --reason <why> (--id <id> | --dedupe-key <key>)...
  restore   node scripts/retract-intel-history.mjs --restore (--dedupe-key <key>)...
  review    node scripts/retract-intel-history.mjs --list [--limit <n>]

  --dry-run  print the resolved request instead of applying it`;

/**
 * Parse argv into a request plan. Pure — no env, no clock, no network — so the
 * argument rules that decide whether an intelligence record gets deleted are
 * testable without a database behind them.
 *
 * Returns `{ ok: false, error }` rather than throwing or exiting: the failure
 * text is what an operator reads at 3am, and it belongs in one place that a
 * test can assert on.
 *
 * @param {string[]} argv  arguments after the script path
 */
export function parseRetractArgs(argv) {
  const ids = [];
  const dedupeKeys = [];
  let reason = '';
  let limit;
  let restore = false;
  let list = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Every value-taking flag reads argv[++i] and must reject a missing or
    // flag-shaped value: `--reason --dry-run` would otherwise silently record
    // "--dry-run" as the audit reason for a deletion.
    const takeValue = (name) => {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) {
        return { error: `${name} requires a value` };
      }
      return { value };
    };

    switch (arg) {
      case '--id':
      case '--dedupe-key':
      case '--reason':
      case '--limit': {
        const taken = takeValue(arg);
        if (taken.error) return { ok: false, error: taken.error };
        if (arg === '--id') ids.push(taken.value);
        else if (arg === '--dedupe-key') dedupeKeys.push(taken.value);
        else if (arg === '--reason') reason = taken.value.trim();
        else {
          const parsed = Number(taken.value);
          if (!Number.isInteger(parsed) || parsed < 1) {
            return { ok: false, error: '--limit must be a positive integer' };
          }
          limit = parsed;
        }
        break;
      }
      case '--restore':
        restore = true;
        break;
      case '--list':
        list = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--help':
      case '-h':
        // Asking for help is not a failure — exiting 1 here would make a
        // wrapper script treat a successful `--help` as a broken invocation.
        return { ok: false, help: true, error: USAGE };
      default:
        return { ok: false, error: `unknown argument: ${arg}` };
    }
  }

  // An untrimmed identifier looks up an identity that does not exist: the
  // retraction deletes nothing, tombstones the typo, and reports success while
  // the record it was called about stays live. The store rejects these too;
  // catching them here turns a store error into an actionable message.
  for (const [flag, values] of [['--id', ids], ['--dedupe-key', dedupeKeys]]) {
    const untrimmed = values.find((value) => value !== value.trim());
    if (untrimmed !== undefined) {
      return {
        ok: false,
        error: `${flag} value has leading or trailing whitespace: ${JSON.stringify(untrimmed)}`,
      };
    }
  }

  if (list && restore) {
    return { ok: false, error: '--list and --restore are mutually exclusive' };
  }

  // --list used to win outright, so `--list --dedupe-key k --reason r` listed
  // the tombstones and exited 0 having retracted nothing — the identifier and
  // reason checks live below this branch and never ran. A composed command
  // that silently does the wrong one of two things is worse than an error.
  if (list && (ids.length > 0 || dedupeKeys.length > 0 || reason)) {
    return {
      ok: false,
      error: '--list cannot be combined with --id, --dedupe-key, or --reason',
    };
  }
  if (!list && limit !== undefined) {
    return { ok: false, error: '--limit applies to --list only' };
  }

  if (list) {
    return { ok: true, mode: 'list', payload: limit === undefined ? {} : { limit }, dryRun };
  }

  const total = ids.length + dedupeKeys.length;
  if (total === 0) {
    return { ok: false, error: `at least one --id or --dedupe-key is required\n\n${USAGE}` };
  }
  if (total > RETRACT_MAX_IDENTIFIERS) {
    return {
      ok: false,
      error: `at most ${RETRACT_MAX_IDENTIFIERS} identifiers per call, got ${total}`,
    };
  }

  if (restore) {
    // Document ids died with the rows they named, so there is nothing for the
    // restore route to resolve one against.
    if (ids.length > 0) {
      return { ok: false, error: '--restore takes --dedupe-key only; the document ids are gone with the rows' };
    }
    return { ok: true, mode: 'restore', payload: { dedupeKeys }, dryRun };
  }

  // Required, never defaulted. A tombstone outlives the incident by up to 180
  // days and the row it replaced is unrecoverable; "why is this suppressed?"
  // has to be answerable from the record the operator leaves behind.
  if (!reason) {
    return { ok: false, error: `--reason is required when retracting\n\n${USAGE}` };
  }

  return { ok: true, mode: 'retract', payload: { ids, dedupeKeys, reason }, dryRun };
}

/**
 * Resolve the history database from an env bag. The store is local, so no
 * credential is involved; the path is reported so an operator can see which
 * database a command acted on.
 *
 * @param {Record<string, string | undefined>} env
 */
export function resolveRetractTarget(env) {
  return { ok: true, dbPath: resolveIntelHistoryDbPath(env) };
}

/**
 * Wire the pieces together. Separated from the process-level entry point below
 * so a test can drive the whole flow with an injected env and store opener.
 *
 * @returns {Promise<{code: number, lines: string[]}>}
 */
export async function runRetractCli(
  argv,
  { env = process.env, openStore = (dbPath, options) => openIntelHistoryStore(dbPath, options) } = {},
) {
  const parsed = parseRetractArgs(argv);
  if (!parsed.ok) return { code: parsed.help ? 0 : 1, lines: [parsed.error] };

  const target = resolveRetractTarget(env);

  if (parsed.dryRun) {
    return {
      code: 0,
      lines: [`[dry-run] ${OPERATIONS[parsed.mode]} on ${target.dbPath}`, JSON.stringify(parsed.payload, null, 2)],
    };
  }

  // Opening a missing database, a locked file, or the store refusing the
  // request all land here. The operator gets the exit code this function
  // exists to return — the one moment a scripted `retract … || alert` must
  // fire — instead of a stack trace.
  let body;
  let store;
  try {
    // A review never creates the database; a retraction may (it tombstones a
    // key before the seeder has ever written).
    store = openStore(target.dbPath, { readOnly: parsed.mode === 'list' });
    body = store[OPERATIONS[parsed.mode]](parsed.payload);
  } catch (err) {
    return { code: 1, lines: [`${OPERATIONS[parsed.mode]} failed on ${target.dbPath}: ${err?.message || err}`] };
  } finally {
    try { store?.close(); } catch { /* best-effort */ }
  }

  const lines = [JSON.stringify(body, null, 2)];

  if (parsed.mode === 'retract') {
    // Ids that did not resolve tombstoned NOTHING. The store rejects the
    // all-unresolved case outright, but a mixed batch still succeeds while
    // silently leaving those identities unsuppressed — and the reassuring
    // cache note below would otherwise be the last thing the operator reads.
    const unresolved = Array.isArray(body?.unresolvedIds) ? body.unresolvedIds : [];
    if (unresolved.length > 0) {
      lines.push(
        '',
        `FAILED: ${unresolved.length} id(s) did not resolve and were NOT tombstoned:`,
        ...unresolved.map((id) => `  ${id}`),
        'A deleted or pruned row cannot be retracted by id. Re-run those with',
        '--dedupe-key to suppress the identity itself.',
        '',
        'The identifiers that DID resolve were retracted; this is a partial',
        'application, so the exit code is non-zero.',
      );
      // Exit non-zero even though the resolved half succeeded. This tool is
      // driven during incidents and from scripts, and "some of the identities
      // you named are still unsuppressed" is a failure state — a 0 here lets
      // `retract ... || alert` stay silent on a half-done containment.
      return { code: 1, lines };
    }

    // The store is clean immediately; the read cache in front of it is not,
    // and it cannot be purged for a single record (its keys are hashes of the
    // request, not of the rows in the response). An operator who checks
    // straight away and still sees the record would otherwise conclude the
    // retraction failed and start retrying.
    lines.push(
      '',
      'Note: a 30-minute success cache sits in front of the store, so a record',
      'can stay visible in RPC reads for up to 30 minutes. Allow ~1 hour before',
      'concluding a record is still retrievable. See',
      'docs/architecture/intel-history-untrusted-text.md § Propagation.',
    );
  }

  if (parsed.mode === 'restore') {
    const notRetracted = Array.isArray(body?.notRetracted) ? body.notRetracted : [];
    if (notRetracted.length > 0) {
      lines.push(
        '',
        `FAILED: ${notRetracted.length} key(s) were not retracted:`,
        ...notRetracted.map((key) => `  ${key}`),
        '',
        'The keys that DID have tombstones were restored; this is a partial',
        'application, so the exit code is non-zero.',
      );
      return { code: 1, lines };
    }
  }

  if (parsed.mode === 'list' && body?.partial === true) {
    lines.push(
      '',
      'More retractions exist than this page shows — raise --limit to see them.',
    );
  }

  return { code: 0, lines };
}

if (process.argv[1]?.endsWith('retract-intel-history.mjs')) {
  // Only when actually run, never on import — the same contract every seeder
  // follows, and the reason a test importing this module does not pick up a
  // developer's database path.
  loadEnvFile(import.meta.url);
  const { code, lines } = await runRetractCli(process.argv.slice(2));
  for (const line of lines) {
    if (code === 0) console.log(line);
    else console.error(line);
  }
  process.exit(code);
}
