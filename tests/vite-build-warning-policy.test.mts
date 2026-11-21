import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  chunkSizeWarningLimitKb,
  getChunkSizeWarning,
  isExpectedEmptyRpcClientWarning,
} from '../scripts/vite-build-warning-policy.mts';

describe('Vite build warning policy', () => {
  it('keeps the 1200 kB limit for unrelated chunks', () => {
    assert.equal(chunkSizeWarningLimitKb('main'), 1200);
    assert.match(
      getChunkSizeWarning({
        name: 'unrelated-lazy-feature',
        fileName: 'assets/unrelated-lazy-feature-hash.js',
        sizeBytes: 1_500_000,
      }) ?? '',
      /budget is 1200 kB/,
    );
  });

  it('grants no chunk a size exception now that the GlobeMap chunk is gone', () => {
    assert.equal(chunkSizeWarningLimitKb('GlobeMap'), 1200);
    assert.match(
      getChunkSizeWarning({
        name: 'GlobeMap',
        fileName: 'assets/GlobeMap-hash.js',
        sizeBytes: 1_900_000,
      }) ?? '',
      /budget is 1200 kB/,
    );
  });

  it('suppresses only the expected disabled cyber client', () => {
    assert.equal(isExpectedEmptyRpcClientWarning({
      code: 'EMPTY_BUNDLE',
      names: ['rpc-client-cyber-v1'],
    }, false), true);
    assert.equal(isExpectedEmptyRpcClientWarning({
      code: 'EMPTY_BUNDLE',
      names: ['rpc-client-cyber-v1'],
    }, true), false);
    assert.equal(isExpectedEmptyRpcClientWarning({
      code: 'EMPTY_BUNDLE',
      names: ['rpc-client-market-v1'],
    }, false), false);
    assert.equal(isExpectedEmptyRpcClientWarning({
      code: 'EMPTY_BUNDLE',
      names: ['rpc-client-cyber-v1', 'rpc-client-market-v1'],
    }, false), false);
  });
});
