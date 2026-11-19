/** Personal builds never initialize hosted accounts, checkout, or telemetry.
 * This flag grants no API entitlements and does not unlock hosted services.
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
