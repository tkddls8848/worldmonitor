import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';
import { deriveSentryTraceId } from '../server/_shared/usage.ts';

test('trace header preserves absent, empty, valid and boundary values', () => {
  const trace = '0123456789abcdef0123456789abcdef-0123456789abcdef-1';
  for (const value of [null, '', trace, 'a'.repeat(512), 'a'.repeat(513)]) {
    const req = new Request('https://worldmonitor.app/api/test', {
      headers: value === null ? {} : { 'sentry-trace': value },
    });
    assert.equal(deriveSentryTraceId(req), value?.slice(0, 512) ?? null);
    assert.equal(req.headers.get('sentry-trace'), value);
  }
});
