import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainModule } from '../scripts/_entrypoint.mjs';

test('entry-point detection converts Windows paths to canonical file URLs', () => {
  const fileUrl = new URL('../scripts/seed-fx-yoy.mjs', import.meta.url);
  const windowsPath = fileURLToPath(fileUrl);

  assert.equal(isMainModule(fileUrl.href, windowsPath), true);
  assert.equal(isMainModule(fileUrl.href, `${windowsPath}.other`), false);
  assert.equal(pathToFileURL(windowsPath).href, fileUrl.href);
  if (process.platform === 'win32') assert.notEqual(`file://${windowsPath}`, fileUrl.href);
});

test('FX YoY and unrest producers use the cross-platform main-module guard', () => {
  for (const script of ['seed-fx-yoy.mjs', 'seed-unrest-events.mjs']) {
    const source = readFileSync(new URL(`../scripts/${script}`, import.meta.url), 'utf8');
    assert.match(source, /isMainModule\(import\.meta\.url\)/, script);
    assert.doesNotMatch(source, /file:\/\/\$\{process\.argv\[1\]\}/, script);
  }
});
