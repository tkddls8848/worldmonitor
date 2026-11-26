import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const buildScript = readFileSync(resolve(root, 'scripts/build-sidecar-handlers.mjs'), 'utf8');
const sidecar = readFileSync(resolve(root, 'scripts/local/local-api-server.mjs'), 'utf8');
function serverFamilies() {
  const serverRoot = resolve(root, 'server/worldmonitor');
  const families = [];
  for (const domain of readdirSync(serverRoot).sort()) {
    const domainDir = join(serverRoot, domain);
    if (!statSync(domainDir).isDirectory()) continue;
    for (const version of readdirSync(domainDir).sort()) {
      if (!/^v\d+$/.test(version)) continue;
      const bundledEntry = `api/${domain}/v1/[rpc].ts`;
      const versionedEntry = `api/${version}/${domain}/[rpc].ts`;
      families.push({
        domain,
        version,
        key: `${version}/${domain}`,
        bundled: version === 'v1' && existsSync(resolve(root, bundledEntry)),
        versioned: existsSync(resolve(root, versionedEntry)),
        urlPrefix: version === 'v1' ? `/api/${domain}/v1/` : `/api/${version}/${domain}/`,
      });
    }
  }
  return families;
}


it('every server route family has one local API entry', () => {
  const families = serverFamilies();
  assert.ok(families.length >= 36);
  assert.ok(families.some(f => f.key === 'v2/shipping'));
  for (const f of families) assert.ok(f.bundled !== f.versioned, f.key);
});
it('versioned handlers are bundled without a cloud-only exception', () => {
  assert.ok(buildScript.includes("entries.push(path.join(versionDir, family.name, '[rpc].ts'))"));
  assert.doesNotMatch(buildScript, /CLOUD_ONLY_ROUTE_FAMILIES/);
  assert.doesNotMatch(sidecar, /isCloudPreferred|cloudOnlyRouteFamilyPrefixes/);
});
