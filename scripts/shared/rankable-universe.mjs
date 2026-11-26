// Shared country universe for reference data, country history, and scorecards.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Sibling JSON in the same scripts/shared/ directory — no path
// traversal, no cross-directory dependency, container-safe.
const SOVEREIGN_STATUS_PATH = resolve(here, 'sovereign-status.json');

const RANKABLE_UNIVERSE = (() => {
  const raw = readFileSync(SOVEREIGN_STATUS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const map = new Map();
  for (const entry of parsed.entries) {
    if (entry?.iso2 && (entry.status === 'un-member' || entry.status === 'sar')) {
      map.set(entry.iso2.toUpperCase(), entry.status);
    }
  }
  return map;
})();

/**
 * Is this country in the rankable universe (UN member or recognized SAR)?
 * Case-insensitive on iso2.
 *
 * @param {string} iso2
 * @returns {boolean}
 */
export function isInRankableUniverse(iso2) {
  if (typeof iso2 !== 'string' || iso2.length !== 2) return false;
  return RANKABLE_UNIVERSE.has(iso2.toUpperCase());
}

/**
 * Get the sovereign status of a rankable country, or null if not eligible.
 * @param {string} iso2
 * @returns {'un-member' | 'sar' | null}
 */
export function getSovereignStatus(iso2) {
  if (typeof iso2 !== 'string') return null;
  return RANKABLE_UNIVERSE.get(iso2.toUpperCase()) ?? null;
}

/**
 * Returns the full list of rankable ISO2 codes, sorted alphabetically.
 * Used for diagnostics/tests; not for hot paths.
 * @returns {string[]}
 */
export function listRankableCountries() {
  return [...RANKABLE_UNIVERSE.keys()].sort();
}

export const RANKABLE_UNIVERSE_SIZE = RANKABLE_UNIVERSE.size;
