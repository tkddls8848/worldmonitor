import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// Source-text guard for the relay side of the occurrence-event pipeline
// (news.breaking, market.move). The relay process
// cannot be imported in a test (it opens sockets at load), so the contract is
// pinned the way tests/notification-relay-coalesce-key.test.mjs pins the
// coalesce keys: by reading scripts/personal-providers.cjs.

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relaySrc = readFileSync(resolve(root, 'scripts/personal-providers.cjs'), 'utf8');
const { API_FANOUT_EVENT_TYPES, API_FANOUT_LIST_KEY } = require('../scripts/lib/occurrence-events.cjs');

function blockAfter(marker, length = 1200) {
  const index = relaySrc.indexOf(marker);
  assert.notEqual(index, -1, `missing ${marker}`);
  return relaySrc.slice(index, index + length);
}

describe('ais-relay API fan-out tee', () => {
  it('requires the shared id module and tees only the fan-out event types after a confirmed queue push', () => {
    assert.match(relaySrc, /require\('\.\/lib\/occurrence-events\.cjs'\)/);
    const publish = blockAfter('async function publishNotificationEvent(', 3500);
    assert.match(publish, /const fanout = API_FANOUT_EVENT_TYPES\.has\(eventType\)/);
    // Id first, so the queue message and the tee copy are the same bytes.
    assert.ok(publish.indexOf('occurrenceEventIdFor(eventType, payload, publishedAt)') < publish.indexOf("upstashLpush('wm:events:queue', msg)"));
    // Tee after the LPUSH succeeded, inside the `ok` branch, before the log line.
    const okBranch = publish.slice(publish.indexOf('if (ok) {'));
    assert.ok(okBranch.indexOf('teeApiFanout(eventType, msg)') < okBranch.indexOf('[Notify] Queued'));
    assert.match(okBranch, /if \(fanout\) teeApiFanout\(eventType, msg\)/);
    assert.deepEqual([...API_FANOUT_EVENT_TYPES].sort(), ['market_alert', 'rss_alert']);
  });

  it('the tee is one EVAL that pushes, caps and expires the list, and never rejects into the publish path', () => {
    const tee = blockAfter('function teeApiFanout(', 700);
    assert.match(tee, /upstashEval\(API_FANOUT_TEE_SCRIPT, \[API_FANOUT_LIST_KEY\], \[msg, API_FANOUT_LIST_CAP, API_FANOUT_LIST_TTL_SECONDS\]\)/);
    assert.match(tee, /\.catch\(/, 'a tee failure is logged, not thrown');
    assert.equal(API_FANOUT_LIST_KEY, 'wm:events:api:v1');
  });
});
