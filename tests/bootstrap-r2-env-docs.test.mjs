// These text checks pin the R2 credential names, blank secret values, and
// publisher/edge separation in operator documentation (#8690, section 2).
// Runtime behavior cannot verify what .env.example and the runbook tell operators.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');
const runbook = readFileSync(resolve(root, 'docs/railway-seed-consolidation-runbook.md'), 'utf8');
const normalizedRunbook = runbook.replace(/\s+/g, ' ');

const SHARED_ENV = ['R2_ACCOUNT_ID', 'R2_ENDPOINT', 'R2_BOOTSTRAP_BUCKET', 'IRAN_EVENTS_ENABLED'];
const PUBLISHER_ENV = ['R2_BOOTSTRAP_ACCESS_KEY_ID', 'R2_BOOTSTRAP_SECRET_ACCESS_KEY'];
const EDGE_ENV = ['R2_BOOTSTRAP_READ_KEY_ID', 'R2_BOOTSTRAP_READ_SECRET'];

describe('bootstrap R2 environment documentation', () => {
  it('personal setup does not require hosted R2 credentials', () => {
    for (const name of [...SHARED_ENV.filter(name => name.startsWith('R2_')), ...PUBLISHER_ENV, ...EDGE_ENV]) {
      assert.doesNotMatch(envExample, new RegExp('^' + name + '=', 'm'));
    }
  });

  it('runbook keeps publisher and edge credentials in separate production environments', () => {
    for (const name of [...SHARED_ENV, ...PUBLISHER_ENV, ...EDGE_ENV]) {
      assert.match(runbook, new RegExp(`\\b${name}\\b`), `${name} missing from the runbook`);
    }

    assert.match(runbook, /R2_BOOTSTRAP_ACCESS_KEY_ID[^\n]*Railway production/i);
    assert.match(runbook, /R2_BOOTSTRAP_READ_KEY_ID[^\n]*Vercel production/i);
    assert.match(runbook, /publisher[^\n]*PUT[^\n]*GET/i);
    assert.match(runbook, /edge[^\n]*GET[^\n]*(?:cannot|never)[^\n]*(?:PUT|DELETE)/i);
    assert.match(normalizedRunbook, /preview.{0,80}(?:(?:do|does) not|must not|never).{0,80}(?:credential|key)/i);
    assert.match(normalizedRunbook, /must not fall back.{0,80}CLOUDFLARE_R2_/i);
  });

  it('runbook pins the always-on service and credential rotation checks', () => {
    assert.match(runbook, /node scripts\/publish-bootstrap-tiers\.mjs --loop/);
    assert.match(runbook, /no cron schedule/i);
    assert.match(runbook, /scripts\/\*\*[^\n]*shared\/\*\*/i);
    assert.match(normalizedRunbook, /create.{0,80}replacement.{0,80}update.{0,80}verify.{0,80}revoke/i);
    assert.match(runbook, /revoke first/i);
  });
});
