#!/usr/bin/env node
import { runBundle, DAY } from './_bundle-runner.mjs';

// These keys predate the current collector. Keep them so existing reference
// data remains readable while the sources refresh on their usual cadence.
await runBundle('country-reference', [
  { label: 'Country-Reference', script: 'seed-country-reference.mjs', seedMetaKey: 'resilience:static', intervalMs: 90 * DAY, timeoutMs: 280_000 },
  { label: 'Food-Stocks', script: 'seed-food-stocks.mjs', seedMetaKey: 'resilience:food-stocks', intervalMs: 30 * DAY, timeoutMs: 480_000 },
  { label: 'Fuel-Stocks', script: 'seed-recovery-fuel-stocks.mjs', seedMetaKey: 'resilience:recovery:fuel-stocks', canonicalKey: 'resilience:recovery:fuel-stocks:v1', intervalMs: 30 * DAY, timeoutMs: 300_000 },
  { label: 'Low-Carbon-Generation', script: 'seed-low-carbon-generation.mjs', seedMetaKey: 'resilience:low-carbon-generation', canonicalKey: 'resilience:low-carbon-generation:v1', intervalMs: 7 * DAY, timeoutMs: 300_000 },
  { label: 'Power-Losses', script: 'seed-power-reliability.mjs', seedMetaKey: 'resilience:power-losses', canonicalKey: 'resilience:power-losses:v1', intervalMs: 7 * DAY, timeoutMs: 300_000 },
  { label: 'Import-HHI', script: 'seed-recovery-import-hhi.mjs', seedMetaKey: 'resilience:recovery:import-hhi', canonicalKey: 'resilience:recovery:import-hhi:v1', intervalMs: 30 * DAY, timeoutMs: 1_800_000 },
  { label: 'Five-Factor-Scorecard', script: 'seed-five-factor-scorecard.mjs', seedMetaKey: 'scorecard:five-factor', intervalMs: DAY, timeoutMs: 180_000 },
]);
