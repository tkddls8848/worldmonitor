/** Personal builds never initialize hosted accounts, checkout, or telemetry.
 * This flag grants no API entitlements and does not unlock hosted services.
 */
export const PERSONAL_MODE = import.meta.env?.VITE_PERSONAL_MODE === 'true';
