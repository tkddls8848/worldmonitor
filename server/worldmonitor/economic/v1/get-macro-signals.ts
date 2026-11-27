/**
 * RPC: getMacroSignals -- reads seeded macro signal data from Railway seed cache.
 * All external Yahoo Finance and FRED calls happen in seed-economy.mjs on Railway.
 */

import type {
  ServerContext,
  GetMacroSignalsRequest,
  GetMacroSignalsResponse,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const SEED_CACHE_KEY = 'economic:macro-signals:v2';

function buildFallbackResult(): GetMacroSignalsResponse {
  return {
    timestamp: new Date().toISOString(),
    verdict: 'UNKNOWN',
    bullishCount: 0,
    totalCount: 0,
    signals: {
      liquidity: { status: 'UNKNOWN', sparkline: [] },
      macroRegime: { status: 'UNKNOWN' },
    },
    meta: { qqqSparkline: [] },
    unavailable: true,
  };
}

export async function getMacroSignals(
  _ctx: ServerContext,
  _req: GetMacroSignalsRequest,
): Promise<GetMacroSignalsResponse> {
  try {
    const result = await getCachedJson(SEED_CACHE_KEY, true) as GetMacroSignalsResponse | null;
    if (result && !result.unavailable && result.totalCount > 0) return result;
    return buildFallbackResult();
  } catch {
    return buildFallbackResult();
  }
}
