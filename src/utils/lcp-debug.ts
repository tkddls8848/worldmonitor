export type LcpDebugDetail = Record<string, string | number | boolean | null | undefined>;

export type LcpMarkSnapshot = {
  detail?: LcpDebugDetail;
  name: string;
  startTime: number;
};

const MAX_MARKS = 120;

/** The deck layer ids last committed to the map, and when (performance.now()). */
export type DeckLayersSnapshot = {
  at: number;
  ids: string[];
};

type LcpDebugMarkTarget = {
  deckLayers?: DeckLayersSnapshot;
  enabled?: boolean;
  marks?: LcpMarkSnapshot[];
};

export function markLcpDebug(name: string, detail?: LcpDebugDetail): void {
  // Opt-in only: when the LCP debug recorder is not installed (the default for
  // all production traffic), this is a single property read + early return. We
  // deliberately do NOT call performance.mark() unless debug is enabled — an
  // unconditional native mark on every boot-path call site would pollute the
  // User Timing buffer that RUM/Sentry/analytics read and add main-thread cost
  // to the very metric this instrumentation measures (#4512 review).
  if (typeof window === 'undefined') return;
  const state = (window as unknown as { __wmLcpDebug?: LcpDebugMarkTarget }).__wmLcpDebug;
  if (!state?.enabled || !Array.isArray(state.marks)) return;

  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    try {
      performance.mark(name);
    } catch {
      // A malformed mark name should never break dashboard startup.
    }
  }

  state.marks.push({
    detail,
    name,
    startTime: Math.round(typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()),
  });
  if (state.marks.length > MAX_MARKS) state.marks.splice(0, state.marks.length - MAX_MARKS);
}

/**
 * Records which deck layers the map just committed, for the perf runner
 * (scripts/perf-personal.mjs) to tell that a toggled layer reached the map.
 * Opt-in like markLcpDebug: a single property read when debug is off. Kept
 * out of the mark list on purpose: it fires on every layer commit and would
 * push the boot marks out of the capped list.
 */
export function recordDeckLayersDebug(layers: readonly unknown[]): void {
  if (typeof window === 'undefined') return;
  const state = (window as unknown as { __wmLcpDebug?: LcpDebugMarkTarget }).__wmLcpDebug;
  if (!state?.enabled) return;
  const ids: string[] = [];
  for (const layer of layers) {
    const id = layer && typeof layer === 'object' ? (layer as { id?: unknown }).id : undefined;
    if (typeof id === 'string') ids.push(id);
  }
  state.deckLayers = { at: performance.now(), ids };
}
