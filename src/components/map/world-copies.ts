/** Integer translations of a horizontal interval that intersects the viewport. */
export function visibleWorldCopies(left: number, right: number, width: number, period: number): number[] {
  if (!(period > 0) || !Number.isFinite(left + right + width + period)) return [0];
  const first = Math.floor(-right / period) + 1;
  const last = Math.ceil((width - left) / period) - 1;
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index);
}

/** The translation that brings a coordinate nearest a reference on a periodic axis. */
export function nearestWorldCopy(value: number, reference: number, period: number): number {
  return period > 0 ? value + Math.round((reference - value) / period) * period : value;
}
