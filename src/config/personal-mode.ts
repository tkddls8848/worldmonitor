/** True in the personal build (VITE_PERSONAL_MODE=true, set by build:personal).
 * It keeps browser requests on the personal server's own origin: the API base,
 * the RSS proxy, and static data such as the country boundary overrides.
 * Hosted accounts, checkout and telemetry are deleted from this fork, so the
 * flag no longer gates them.
 */
function readPersonalMode(): boolean {
  // Vite inlines this exact member at build time. node:test imports have no
  // import.meta.env, so the read throws there and the flag is off. Optional
  // chaining would make Vite keep the whole env object instead.
  try {
    return import.meta.env.VITE_PERSONAL_MODE === 'true';
  } catch {
    return false;
  }
}

export const PERSONAL_MODE = readPersonalMode();
