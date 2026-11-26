import sovereignStatus from '../../scripts/shared/sovereign-status.json';

export type SovereignStatus = 'un-member' | 'sar';

interface SovereignStatusEntry {
  iso2: string;
  status: SovereignStatus;
}

interface SovereignStatusFile {
  name: string;
  description: string;
  entries: SovereignStatusEntry[];
}

const FILE = sovereignStatus as SovereignStatusFile;

const RANKABLE_UNIVERSE: ReadonlyMap<string, SovereignStatus> = new Map(
  FILE.entries
    .filter((e) => e?.iso2 && (e.status === 'un-member' || e.status === 'sar'))
    .map((e) => [e.iso2.toUpperCase(), e.status]),
);

/** Is this country in the rankable universe (UN member or recognized SAR)? */
export function isInRankableUniverse(iso2: string): boolean {
  if (typeof iso2 !== 'string' || iso2.length !== 2) return false;
  return RANKABLE_UNIVERSE.has(iso2.toUpperCase());
}
