/** Personal builds never initialize hosted accounts, checkout, or telemetry.
 * This flag grants no API entitlements and does not unlock hosted services.
 */
// The window guard keeps node:test imports (no import.meta.env) at false
// without optional-chaining import.meta.env, which would make Vite keep the
// whole env object instead of inlining this one key.
export const PERSONAL_MODE = typeof window !== 'undefined' && import.meta.env.VITE_PERSONAL_MODE === 'true';
