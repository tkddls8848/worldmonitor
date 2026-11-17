import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');

// Guards the multi-language SDK packages (orank Access "Multi-language SDK
// packages" gap). Agents verify a package is the official SDK through its
// homepage metadata pointing at the product domain, and each ecosystem keeps
// its version in TWO places (manifest + source constant) that the publish
// workflows cross-check against the release tag — these assertions stop any
// of that wiring from silently drifting.

const HOMEPAGE = 'https://worldmonitor.app';

describe('Python SDK package (sdk/python → PyPI worldmonitor-sdk)', () => {
  const pyproject = read('sdk/python/pyproject.toml');
  const module = read('sdk/python/src/worldmonitor_sdk/__init__.py');

  it('is the worldmonitor-sdk distribution with the product-domain homepage', () => {
    assert.match(pyproject, /^name = "worldmonitor-sdk"$/m);
    assert.match(pyproject, new RegExp(`^Homepage = "${HOMEPAGE}"$`, 'm'));
    assert.match(pyproject, /^license = "MIT"$/m);
  });

  it('keeps __version__ in sync with pyproject.toml (drift guard)', () => {
    const [, pkgVersion] = pyproject.match(/^version = "([^"]+)"$/m) ?? [];
    const [, modVersion] = module.match(/^__version__ = "([^"]+)"$/m) ?? [];
    assert.ok(pkgVersion, 'pyproject.toml must declare a version');
    assert.equal(modVersion, pkgVersion);
  });

  it('sends a self-identifying User-Agent (Cloudflare WAF blocks the python-urllib default)', () => {
    // Only the two properties the WAF rule depends on: it names the client and
    // carries the product domain. The exact format string is not a contract.
    assert.match(module, /USER_AGENT = "worldmonitor-python[^"]*worldmonitor\.app[^"]*"/);
  });
});

describe('Ruby SDK package (sdk/ruby → gem worldmonitor)', () => {
  const gemspec = read('sdk/ruby/worldmonitor.gemspec');
  const versionRb = read('sdk/ruby/lib/worldmonitor/version.rb');
  const lib = read('sdk/ruby/lib/worldmonitor.rb');

  it('is the worldmonitor gem with the product-domain homepage', () => {
    assert.match(gemspec, /spec\.name = "worldmonitor"/);
    assert.match(gemspec, new RegExp(`spec\\.homepage = "${HOMEPAGE}"`));
    assert.match(gemspec, new RegExp(`"homepage_uri" => "${HOMEPAGE}"`));
    assert.match(gemspec, /spec\.license = "MIT"/);
  });

  it('declares VERSION where the gemspec and publish workflow read it', () => {
    assert.match(versionRb, /VERSION = "\d+\.\d+\.\d+"/);
    assert.match(gemspec, /require_relative "lib\/worldmonitor\/version"/);
  });

  it('sends a self-identifying User-Agent', () => {
    assert.match(lib, /USER_AGENT = "worldmonitor-ruby[^"]*worldmonitor\.app[^"]*"/);
  });
});

describe('Go SDK module (sdk/go → pkg.go.dev)', () => {
  const gomod = read('sdk/go/go.mod');
  const source = read('sdk/go/worldmonitor.go');

  it('is the sdk/go submodule of this repository', () => {
    assert.match(gomod, /^module github\.com\/koala73\/worldmonitor\/sdk\/go$/m);
  });

  it('declares the Version constant the publish workflow checks against the tag', () => {
    assert.match(source, /^const Version = "\d+\.\d+\.\d+"$/m);
  });

  it('documents the product domain and sends a self-identifying User-Agent', () => {
    assert.match(source, /const UserAgent = "worldmonitor-go[\s\S]{0,80}worldmonitor\.app/);
  });
});

describe('Rust SDK package (sdk/rust → crates.io worldmonitor)', () => {
  const manifest = read('sdk/rust/Cargo.toml');
  const source = read('sdk/rust/src/lib.rs');

  it('declares official identity and registry discovery metadata', () => {
    assert.match(manifest, /^name = "worldmonitor"$/m);
    assert.match(manifest, /^homepage = "https:\/\/worldmonitor\.app"$/m);
    assert.match(manifest, /^repository = "https:\/\/github\.com\/koala73\/worldmonitor"$/m);
    assert.match(manifest, /^license = "MIT"$/m);
    assert.match(manifest, /^keywords = .*"osint".*"mcp"/m);
    assert.ok(existsSync(join(ROOT, 'sdk/rust/LICENSE')));
    assert.ok(existsSync(join(ROOT, 'sdk/rust/Cargo.lock')));
    assert.match(source, /env!\("CARGO_PKG_VERSION"\)/);
    assert.match(source, /worldmonitor-rust\//);
  });

  it('links the published Rust crate and API docs from SDK discovery pages', () => {
    for (const path of ['docs/sdks.mdx', 'public/sdks.md', 'public/api/llms.txt']) {
      const content = read(path);
      assert.match(content, /https:\/\/crates\.io\/crates\/worldmonitor/, path);
      assert.match(content, /https:\/\/docs\.rs\/worldmonitor\/0\.1\.0\/worldmonitor\//, path);
      assert.match(content, /cargo add worldmonitor/, path);
      assert.doesNotMatch(content, /not yet published|Rust SDK preparation/i, path);
    }
  });
});

describe('SDK publish workflows', () => {
});

describe('SDK discovery surfaces', () => {
  it('api/llms.txt advertises the SDK surface', () => {
    const llms = read('public/api/llms.txt');
    assert.match(llms, /pip install worldmonitor-sdk/);
    assert.match(llms, /gem install worldmonitor/);
    assert.match(llms, /go get github\.com\/koala73\/worldmonitor\/sdk\/go/);
  });

  it('the docs site has an SDKs page wired into navigation', () => {
    assert.ok(existsSync(join(ROOT, 'docs/sdks.mdx')), 'docs/sdks.mdx must exist');
    const nav = JSON.parse(read('docs/docs.json'));
    assert.match(JSON.stringify(nav.navigation), /"sdks"/);
  });
});
