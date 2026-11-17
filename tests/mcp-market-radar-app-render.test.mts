import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildUiResourceRead, MARKET_RADAR_UI_URI } from '../api/mcp/ui/registry';

// The compiled Market Radar plugin page (market.html + src/plugin-market-main.ts)
// was removed; this inline document stands in for the fetched build.
const body = '<!DOCTYPE html><html><head></head><body><main id="marketRoot"></main></body></html>';

describe('market resource current-document delivery', () => {
  it('both the new URI and legacy read alias use the data-free bounded loader and asset policy', async () => {
    const previous = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      return new Response(body.replace('</body>', '<script type="module" src="/plugin/assets/market-test.js"></script></body>'), { headers: { 'Content-Type': 'text/html' } });
    };
    try {
      for (const uri of [MARKET_RADAR_UI_URI, 'ui://worldmonitor/market-radar.html']) {
        const response = await buildUiResourceRead(1, uri, {});
        const resource = (await response.json()).result.contents[0];
        assert.equal(resource.uri, uri);
        assert.match(resource.text, /market.html/);
        assert.match(resource.text, /marketRoot/);
        assert.match(resource.text, /cache: 'no-store'/);
        assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
        assert.deepEqual(resource._meta.ui.csp.resourceDomains, ['https://www.worldmonitor.app']);
        assert.deepEqual(resource._meta.ui.csp.frameDomains, []);
      }
      assert.deepEqual(requested, ['https://www.worldmonitor.app/plugin/market.html', 'https://www.worldmonitor.app/plugin/market.html']);
    } finally { globalThis.fetch = previous; }
  });
});
