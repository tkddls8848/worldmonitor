/** Bundle API handlers for the personal server, including versioned route families. */

import { build } from 'esbuild';
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { findStaleHandlerBundles } from './lib/stale-handler-bundles.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const apiDir = path.join(ROOT, 'api');

// Skip the catch-all [domain] directory (handled by build-sidecar-sebuf.mjs)
const SKIP_DIRS = new Set(['[domain]', '[[...path]]']);

const VERSION_DIR = /^v\d+$/;
const entries = [];
const dirs = await readdir(apiDir, { withFileTypes: true });
for (const d of dirs) {
  if (!d.isDirectory() || SKIP_DIRS.has(d.name)) continue;
  if (VERSION_DIR.test(d.name)) {
    const versionDir = path.join(apiDir, d.name);
    for (const family of await readdir(versionDir, { withFileTypes: true })) {
      if (!family.isDirectory()) continue;
      if (!existsSync(path.join(versionDir, family.name, '[rpc].ts'))) continue;
      entries.push(path.join(versionDir, family.name, '[rpc].ts'));
    }
    continue;
  }
  const tsFile = path.join(apiDir, d.name, 'v1', '[rpc].ts');
  if (existsSync(tsFile)) {
    entries.push(tsFile);
  }
}

// A deleted domain leaves its gitignored [rpc].js bundle behind, and the local
// API server routes every .js under api/: remove bundles whose source is gone.
for (const file of findStaleHandlerBundles(apiDir)) {
  rmSync(file);
  console.log(`build:sidecar-handlers  removed stale bundle ${path.relative(ROOT, file)} (no [rpc].ts)`);
}

// Personal fork: the standalone edge routes the dashboard calls on the personal
// server. The local API server only routes bundled .js files, so without these
// /api/chat-analyst and /api/latest-brief answer "No local handler". Outputs
// are gitignored next to their sources.
export const PERSONAL_EDGE_ENTRIES = [
  'chat-analyst.ts',
  'latest-brief.ts',
  'brief/share-url.ts',
  'brief/[userId]/[issueDate].ts',
  // The dashboard Trip Assessment dialog (src/services/travel-risk-export.ts).
  'travel-risk-assessment.ts',
];
for (const rel of PERSONAL_EDGE_ENTRIES) {
  const tsFile = path.join(apiDir, rel);
  if (!existsSync(tsFile)) {
    console.error(`build:sidecar-handlers  missing personal edge entry api/${rel}`);
    process.exit(1);
  }
  entries.push(tsFile);
}

if (entries.length === 0) {
  console.log('build:sidecar-handlers  no domain handlers found, skipping');
  process.exit(0);
}

try {
  await build({
    entryPoints: entries,
    outdir: ROOT,
    outbase: ROOT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    treeShaking: true,
    // Resolve @/ alias to src/
    alias: { '@': path.join(ROOT, 'src') },
  });

  // Report results
  let totalKB = 0;
  for (const entry of entries) {
    const jsFile = entry.replace(/\.ts$/, '.js');
    if (existsSync(jsFile)) {
      const { size } = await stat(jsFile);
      totalKB += size / 1024;
    }
  }
  console.log(`build:sidecar-handlers  ${entries.length} domains  ${totalKB.toFixed(0)} KB total`);
} catch (err) {
  console.error('build:sidecar-handlers failed:', err.message);
  process.exit(1);
}
