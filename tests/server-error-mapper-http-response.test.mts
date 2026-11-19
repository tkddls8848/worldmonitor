import { afterEach, describe, test } from 'node:test';
import { expect, vi } from './helpers/vitest-compat.mts';

import {
  attachApiErrorHttpResponseMetadata,
  mapErrorToResponse,
} from '../server/error-mapper';
import { ApiError } from '../src/generated/server/worldmonitor/market/v1/service_server';

describe('opt-in ApiError HTTP responses', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('serializes an opted-in retryable 503 without rate-limit headers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new ApiError(503, 'Stock backtest quota service unavailable', '');
    (error as ApiError & { retryAfter: number }).retryAfter = 30;
    attachApiErrorHttpResponseMetadata(error, { envelope: 'error' });

    const response = mapErrorToResponse(error, new Request('https://example.com'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Stock backtest quota service unavailable',
    });
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(response.headers.get('RateLimit-Limit')).toBeNull();
    expect(response.headers.get('X-RateLimit-Limit')).toBeNull();
  });

  test('preserves the legacy ApiError envelope without explicit metadata', async () => {
    const error = new ApiError(429, 'Ordinary retryable error', '');
    (error as ApiError & { retryAfter: number }).retryAfter = 15;

    const response = mapErrorToResponse(error, new Request('https://example.com'));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      message: 'Ordinary retryable error',
      retryAfter: 15,
    });
    expect(response.headers.get('Retry-After')).toBe('15');
    expect(response.headers.get('RateLimit-Limit')).toBeNull();
  });
});
