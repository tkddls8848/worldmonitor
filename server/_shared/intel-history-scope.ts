/**
 * Scope normalizers for the historical intelligence memory (#5694).
 *
 * Dependency-free on purpose: the MCP registry (an Edge bundle) needs these,
 * and must not reach the store reader in ./intel-history-client.ts, which
 * loads node:sqlite. The client re-exports both.
 *
 * Scope values are compared with `=` against what the seeders wrote, so the
 * caller's casing and padding decide whether anything matches at all. A
 * request for country "ua " silently returns nothing against stored "UA" —
 * indistinguishable, to the caller, from "we have no history for Ukraine".
 * Normalize to the stored form instead of trusting the wire.
 *
 * buf.validate documents these shapes in the proto but does not run: the
 * gateway supplies no `validateRequest` (server/gateway.ts), so this is the
 * only place the contract is actually applied.
 */

export function normalizeCountry(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

export function normalizeDomain(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
