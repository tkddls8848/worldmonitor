/** Keep the physical premium slot and rotate the lead member on the recovery tick. */
export function orderMacroSections(physicalPremiumSection, macroSections, turn = null) {
  const sections = [physicalPremiumSection, ...macroSections];
  if (turn === null) return sections;
  if (!Number.isSafeInteger(turn) || turn < 0) throw new TypeError('turn must be a non-negative safe integer');
  if (macroSections.length) {
    const offset = turn % macroSections.length;
    const [lead] = sections.splice(offset + 1, 1);
    const preceding = sections.splice(1, offset);
    sections.push(...preceding);
    sections.unshift(lead);
  }
  return sections;
}
