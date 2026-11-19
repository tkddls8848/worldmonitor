import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { it } from 'node:test';

const require = createRequire(import.meta.url);
const StreamValues = require('stream-json/streamers/StreamValues');
const katex = require('katex');
const { load } = require('js-yaml');
const semver = require('semver');

const inputs = [
  '{"__proto__":{"isAdmin":true},"name":"bob"}',
  '{"__proto__":null,"name":"bob"}',
  '{"user":{"__proto__":{"isAdmin":true},"name":"alice"}}',
  '{"__proto__":["admin"],"name":"bob"}',
  '{"__proto__":"value","name":"bob"}',
];

it('stream-json respects reviver deletion and parses consecutive values', async () => {
  const values = [];
  await pipeline(
    Readable.from(['{"__proto__":null,"keep":1} {"keep":2}']),
    StreamValues.withParser({ reviver: (key, value) => key === '__proto__' ? undefined : value }),
    async (source) => { for await (const item of source) values.push(item.value); },
  );
  assert.deepEqual(values, [{ keep: 1 }, { keep: 2 }]);
});

it('KaTeX ignores inherited trust while preserving explicit trusted rendering', () => {
  const expression = '\\href{javascript:alert(1)}{click}';
  assert.equal(katex.renderToString(expression, Object.create({ trust: true })).includes('href="javascript:alert(1)"'), false);
  assert.equal(katex.renderToString(expression, { trust: true }).includes('href="javascript:alert(1)"'), true);
  assert.match(katex.renderToString('x^2 + 1'), /katex/);
});


function npmLockVersions(path, name) {
  const lock = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  return Object.entries(lock.packages)
    .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
    .map(([, entry]) => entry.version);
}

function pnpmLockVersions(path, name) {
  const lock = load(readFileSync(new URL(path, import.meta.url), 'utf8'));
  return Object.keys(lock.packages).filter((key) => key.startsWith(`${name}@`)).map((key) => key.slice(name.length + 1));
}

const patchedLocks = [
  ['fast-xml-parser', '5.12.0', npmLockVersions, '../package-lock.json'],
  ['fast-xml-parser', '5.12.0', npmLockVersions, '../scripts/package-lock.json'],
  ['fast-xml-parser', '5.12.0', npmLockVersions, '../blog-site/package-lock.json'],
  ['sharp', '0.35.5', npmLockVersions, '../package-lock.json'],
  ['sharp', '0.35.5', npmLockVersions, '../blog-site/package-lock.json'],
  ['markdown-it', '14.3.3', npmLockVersions, '../package-lock.json'],
  ['@vitest/mocker', '4.1.12', npmLockVersions, '../package-lock.json'],
  ['@vitest/mocker', '4.1.12', npmLockVersions, '../consumer-prices-core/package-lock.json'],
  ['fast-uri', '3.1.9', npmLockVersions, '../package-lock.json'],
];

for (const [name, patched, versionsOf, path] of patchedLocks) {
  it(`${path.slice(3)} selects only ${name} >= ${patched}`, () => {
    const versions = versionsOf(path, name);
    assert.ok(versions.length > 0);
    for (const version of versions) assert.ok(semver.gte(version, patched), `${name}@${version}`);
  });
}
