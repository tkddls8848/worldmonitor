// Every HTML page we serve under the site-wide CSP must be able to run its
// own scripts. That CSP uses 'strict-dynamic' with no 'unsafe-inline', so the
// browser silently drops:
//   - a `javascript:` URL,
//   - an inline event-handler attribute (onclick=, onload=, …).
// Each of these shipped once and left a dead control in production (the MCP
// consent page's "Use API key instead", the OAuth error pages' "go back", the
// hosted YouTube embed's player). This sweep reads the served sources so the
// next one fails here instead.
//
// The script-src nonce/hash checks and the per-route CSP checks read the
// deployment's CSP rules, which left this personal build with vercel.json.

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const ROOT = new URL('..', import.meta.url);

// Served under a different CSP, or not served as a page under ours.
const EXEMPT = {
  // Own CSP rules in the deployment config.
  'api/slack/oauth/callback.ts': '/api/slack/oauth/callback',
  'api/discord/oauth/callback.ts': '/api/discord/oauth/callback',
  'public/wm-widget-sandbox.html': '/wm-widget-sandbox.html',
};
const EXEMPT_DIRS = ['api/mcp/ui/'];

const JAVASCRIPT_URL = /\b(?:href|src|action)\s*=\s*["']?\s*javascript:/gi;
// A tag, then whole attributes (quoted values are skipped, so text such as
// aria-label="turn on x=1" is not read as a handler), then an on* attribute.
const INLINE_HANDLER = /<[a-zA-Z][^\s/>]*(?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>`]+))?)*?\s+on[a-z]+\s*=/gi;

function servedSources() {
  const files = execFileSync('git', ['ls-files', '*.html', 'public/*.html', 'api/**.js', 'api/**.ts', 'server/**.ts'], {
    cwd: ROOT, encoding: 'utf8',
  }).split('\n').filter(Boolean);
  return [...new Set(files)].filter((f) =>
    !f.includes('/') || f.startsWith('public/') || f.startsWith('api/') || f.startsWith('server/'))
    .filter((f) => !/(^|\/)__tests__\/|\.test\.|\.d\.ts$/.test(f))
    .filter((f) => !(f in EXEMPT) && !EXEMPT_DIRS.some((d) => f.startsWith(d)));
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function blockedMarkup(file, text) {
  const failures = [];
  for (const m of text.matchAll(JAVASCRIPT_URL)) failures.push(`${file}:${lineOf(text, m.index)} javascript: URL`);
  for (const m of text.matchAll(INLINE_HANDLER)) failures.push(`${file}:${lineOf(text, m.index)} inline event handler`);
  return failures;
}

describe('inline handler and javascript: URL detection', () => {
  const handlers = (html) => [...html.matchAll(INLINE_HANDLER)].length;
  it('finds quoted, unquoted and uppercase handlers', () => {
    assert.equal(handlers('<button onclick="run()">'), 1);
    assert.equal(handlers("<button onclick='run()'>"), 1);
    assert.equal(handlers('<button onclick=run()>'), 1);
    assert.equal(handlers('<button ONCLICK=run()>'), 1);
    assert.equal(handlers('<img src="x.png" OnError = "f()">'), 1);
    assert.equal(handlers('<input disabled\n  onfocus=f()>'), 1);
  });
  it('ignores attributes that only contain "on"', () => {
    assert.equal(handlers('<button data-onclick="run()">'), 0);
    assert.equal(handlers('<a aria-label="turn on x=1" href="/">'), 0);
    assert.equal(handlers('<div title=\'click on=me\'>'), 0);
    assert.equal(handlers('<span class=icon one-click>'), 0);
    assert.equal(handlers('if (a<b && el.onclick) el.onclick = f;'), 0);
  });
  it('finds javascript: URLs', () => {
    assert.equal([...'<a href="javascript:history.back()">'.matchAll(JAVASCRIPT_URL)].length, 1);
    assert.equal([...'<a HREF=javascript:void(0)>'.matchAll(JAVASCRIPT_URL)].length, 1);
    assert.equal([...'<a href="/docs/javascript:guide">'.matchAll(JAVASCRIPT_URL)].length, 0);
  });
});

describe('served HTML runs under the site-wide CSP', () => {
  it('no javascript: URL or inline event handler is blocked', () => {
    const failures = [];
    for (const file of servedSources()) {
      const text = readFileSync(new URL(file, ROOT), 'utf8');
      if (!/<script\b|javascript:|<[a-z]/i.test(text)) continue;
      failures.push(...blockedMarkup(file, text));
    }
    assert.deepEqual(failures, [], `blocked by the site-wide CSP:\n  ${failures.join('\n  ')}`);
  });
});
