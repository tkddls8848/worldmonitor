import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import catchAll, { config } from '../api/[...notfound].ts';
import notFound from '../api/not-found.ts';

// Regression guard for #4724: the `/api/:path*` -> /api/not-found rewrite (#4698)
// was an afterFiles rewrite that shadowed every dynamic `api/<svc>/v1/[rpc].ts`
// gateway, 404ing the entire versioned REST surface in production. The fix moves
// the JSON-404 handler to a filesystem catch-all (`api/[...notfound].ts`), which
// has the lowest dynamic-route precedence and so cannot shadow real endpoints.
describe('api/[...notfound].ts — filesystem catch-all replaces the shadowing rewrite (#4724)', () => {
  it('delegates to the shared api/not-found.ts handler', () => {
    assert.equal(catchAll, notFound, 'catch-all must re-export the shared not-found handler (single source of truth)');
  });

  it('runs on the edge runtime', () => {
    assert.equal(config?.runtime, 'edge');
  });

  it('returns the structured JSON 404 envelope for an unmatched path', async () => {
    const res = catchAll(new Request('https://worldmonitor.app/api/seismology/v1/list-earthquakes', { method: 'GET' }));
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error?.code, 'not_found');
    assert.ok(body.error.message.includes('/api/seismology/v1/list-earthquakes'), 'message must echo the requested path');
  });
});
