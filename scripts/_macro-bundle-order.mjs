/** Keep the physical premium slot and rotate the lead member on the recovery tick. */
export function orderMacroSections(physicalPremiumSection, macroSections, turn = null) {
  if (turn === null) return [physicalPremiumSection, ...macroSections];
  if (!Number.isSafeInteger(turn) || turn < 0) throw new TypeError('turn must be a non-negative safe integer');
  if (!macroSections.length) return [physicalPremiumSection];
  const offset = turn % macroSections.length;
  const rotated = [...macroSections.slice(offset), ...macroSections.slice(0, offset)];
  return [rotated[0], physicalPremiumSection, ...rotated.slice(1)];
}
