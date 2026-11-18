// Gitignored domain handler bundles (api/<domain>/v<N>/[rpc].js and
// api/v<N>/<domain>/[rpc].js) whose [rpc].ts source no longer exists. The local
// API server routes every .js under api/, so a bundle left behind by a deleted
// domain keeps serving that domain until it is removed.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function findStaleHandlerBundles(apiDir) {
  if (!existsSync(apiDir)) return [];
  const stale = [];
  const visit = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2 && entry.name !== 'node_modules') visit(full, depth + 1);
      } else if (depth === 2 && entry.name === '[rpc].js' && !existsSync(path.join(dir, '[rpc].ts'))) {
        stale.push(full);
      }
    }
  };
  visit(apiDir, 0);
  return stale;
}
