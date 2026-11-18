import type { AccessContextSnapshot } from '@/services/webmcp';

/** Keys that must never appear on a WebMCP access snapshot or bounded result. */
export const ACCESS_CONTEXT_PRIVACY_KEYS = [
  'email',
  'name',
  'userId',
  'id',
  'token',
  'sessionId',
  'image',
  'session',
] as const;

export interface WebMcpAccessContextInput {
  enabledPanelUsed: number;
  dashboardTabCount: number;
}

function nonNegativeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Bounded, PII-free access snapshot for WebMCP. There is no account, so the
 * session is always signed out and sign-in is unavailable. Every dashboard
 * feature is available, so the tier is always pro and nothing is capped. The
 * account API and MCP grants have no backend here, so those flags stay false.
 */
export function buildWebMcpAccessContext(
  input: WebMcpAccessContextInput,
): AccessContextSnapshot {
  return {
    accountState: 'signed_out',
    clerk: 'unavailable',
    productTier: 'pro',
    capabilities: {
      premiumAccess: true,
      apiAccess: false,
      mcpAccess: false,
      dataExport: true,
    },
    limits: {
      enabledPanels: {
        used: nonNegativeCount(input.enabledPanelUsed),
        cap: null,
      },
      dashboardTabs: {
        used: nonNegativeCount(input.dashboardTabCount),
        cap: null,
        canCreate: true,
      },
    },
  };
}
