#!/usr/bin/env node
// Runs as the Provincial-511 member of seed-bundle-canada (#6711).
// The dashboard and terminal consumer read Ontario 511 only.

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import {
  fetchVendor511,
  isCompleteVendor511,
  ONTARIO_511,
  select511Records,
} from './lib/provincial-511.mjs';

loadEnvFile(import.meta.url);

const ONTARIO_KEY = 'infra:ontario-511:v1';
const CACHE_TTL = 5400;
const STAGGER_MS = 7000;

function stampRecords(records) {
  return records.map((record) => ({ ...record, source: 'ontario-511' }));
}

async function fetchOntario511() {
  const raw = process.env.ONTARIO_511_KEY;
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key) {
    const err = new Error('Ontario 511: not configured (ONTARIO_511_KEY missing); keeping last-good');
    err.notConfigured = true;
    err.nonRetryable = true;
    throw err;
  }
  const envelope = await fetchVendor511(ONTARIO_511, {
    userAgent: CHROME_UA,
    staggerMs: STAGGER_MS,
    key,
  });
  if (!isCompleteVendor511(envelope, ONTARIO_511)) {
    const failed = envelope.failedResources?.join(', ') || 'incomplete';
    const err = new Error(`Ontario 511: partial poll (${failed} failed); keeping last-good`);
    err.nonRetryable = true;
    throw err;
  }
  const combined = [...envelope.events, ...envelope.alerts, ...envelope.conditions];
  return { records: stampRecords(select511Records(combined)) };
}

export function declareRecords(data) {
  return Array.isArray(data?.records) ? data.records.length : 0;
}

function validateOntario511(data) {
  return data != null && typeof data === 'object' && Array.isArray(data.records);
}

runSeed('infra', 'ontario-511', ONTARIO_KEY, fetchOntario511, {
  validateFn: validateOntario511,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'ontario-511-v1',
  declareRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: 45,
}).catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
