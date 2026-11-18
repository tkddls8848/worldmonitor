/**
 * Untrusted-content posture for the durable intel-history store (#5743).
 *
 * The store keeps third-party feed text verbatim and hands it to LLM agents for
 * the full 180-day retention window, so the *marking* is the mitigation. That
 * makes the marking load-bearing rather than decorative: if a future edit
 * tidies these descriptions away, the only control on an indirect-prompt-
 * injection channel disappears silently, with nothing failing.
 *
 * This mirrors how the repo already guards the same posture elsewhere —
 * `tests/agent-skills-index.test.mjs` pins the `## Content safety` section on
 * every published agent skill, and `tests/deduction-prompt.test.mjs` pins the
 * untrusted-DATA guardrail in the analyst prompts.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';


const read = (relative) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

const DECISION_DOC = 'docs/architecture/intel-history-untrusted-text.md';

describe('intel-history REST contract marks its untrusted feed text', () => {
  it('the proto carries the UNTRUSTED CONTENT note and per-field markings', () => {
    const proto = read('proto/worldmonitor/intelligence/v1/intel_history_record.proto');

    assert.match(proto, /UNTRUSTED CONTENT/);
    assert.match(proto, /never as instructions/i);
    assert.match(proto, new RegExp(DECISION_DOC.replace(/[.]/g, '\\.')));

    // Each of the three free-text fields, not just the message-level note —
    // generated clients surface field docs far more often than message docs.
    //
    // Read the comment lines IMMEDIATELY above each declaration, walking up
    // from it. A looser window (everything since the last blank line, say)
    // would swallow the message-level note above and match on its wording, so
    // the check would pass with every field comment stripped bare.
    for (const [field, expected] of [
      ['string title = 6;', /verbatim/i],
      ['string summary = 7;', /verbatim/i],
      ['string source_url = 8;', /untrusted/i],
    ]) {
      const lines = proto.split('\n');
      const at = lines.findIndex((line) => line.trim() === field);
      assert.ok(at > -1, `${field} must exist in the proto`);

      const comment = [];
      for (let i = at - 1; i >= 0 && lines[i].trim().startsWith('//'); i--) {
        comment.unshift(lines[i].trim().replace(/^\/\/\s?/, ''));
      }
      assert.ok(comment.length > 0, `${field} must carry a doc comment`);
      assert.match(
        comment.join(' '),
        expected,
        `${field}'s own doc comment must mark it as untrusted third-party text`,
      );
    }
  });

  it('the generated OpenAPI carries the marking through to REST consumers', () => {
    const spec = read('docs/api/IntelligenceService.openapi.json');
    assert.match(spec, /UNTRUSTED CONTENT/);
  });
});

describe('the decision is written down where the next reader will look', () => {
  it('the architecture decision doc exists and answers all three questions', () => {
    assert.ok(
      existsSync(fileURLToPath(new URL(`../${DECISION_DOC}`, import.meta.url))),
      `${DECISION_DOC} must exist — #5743 asked for an explicit written decision`,
    );
    const doc = read(DECISION_DOC);

    // 1. ingest-vs-retrieval, stated as a decision rather than a description.
    assert.match(doc, /Ingest stores verbatim/i);
    assert.match(doc, /do not sanitize, strip, or neutralize/i);
    // 2. the retraction path, with the runnable command.
    assert.match(doc, /scripts\/retract-intel-history\.mjs/);
    // 3. what is knowingly accepted, so it is not re-litigated by accident.
    assert.match(doc, /knowingly accepts/i);
    // The trap that makes retraction real rather than theatre.
    assert.match(doc, /tombstone/i);
  });

  for (const [label, path, anchor] of [
    ['English', 'docs/mcp-tools/historical-intelligence.mdx', 'title: "MCP tools: Historical intelligence"'],
    ['Chinese', 'docs/zh/mcp-tools/historical-intelligence.mdx', 'title: "MCP 工具：历史情报"'],
    ['English overview', 'docs/mcp-overview.mdx', '### Historical intelligence'],
    ['Chinese overview', 'docs/zh/mcp-overview.mdx', '### 历史情报'],
  ]) {
    it(`the ${label} tools reference states the posture in the historical section`, () => {
      const docs = read(path);
      const start = docs.indexOf(anchor);
      assert.ok(start > -1, `${path} must have a historical intelligence section`);
      // Bound the search to that section: a content-safety note elsewhere in a
      // 1,400-line reference would satisfy a whole-file match while leaving
      // this section silent.
      // Bound by the next heading of the SAME level, and fall back to the end
      // of file when this is the last section — indexOf returning -1 would
      // otherwise slice to empty and pass every assertion vacuously.
      const level = anchor.startsWith('###') ? '\n### ' : '\n## ';
      const nextHeading = docs.indexOf(level, start + anchor.length);
      const section = docs.slice(start, nextHeading === -1 ? undefined : nextHeading);
      assert.ok(section.length > 0, `${path} section slice must not be empty`);

      assert.match(section, /180/, 'must state the retention window that changes the risk');
      assert.match(
        section,
        label.endsWith('overview') ? /mcp-tools\/historical-intelligence/ : /intel-history-untrusted-text\.md/,
        'must point the reader at the full statement',
      );
      assert.match(
        section,
        label.startsWith('English') ? /never as instructions/i : /而绝非指令/,
        'must tell readers the fields are not instructions',
      );
    });
  }
});
