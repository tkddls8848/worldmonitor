import { expect, test, type Page } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

test('mobile world view fits complete ticker items and keeps the date picker in view', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedAnonymousDashboard(page, 'full');
  await page.addInitScript(() => {
    localStorage.setItem('worldmonitor-first-screen-mode', '"world"');
    localStorage.setItem('wm-locale-explicit', 'ko');
    localStorage.setItem('worldmonitor-theme', 'dark');
  });
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/bootstrap?*', (route) => {
    const data = new URL(route.request().url()).searchParams.get('keys') === 'worldOverview'
      ? { worldOverview: { schemaVersion: 1, date: '2026-11-26', countries: {}, anchors: {}, availableDates: ['2026-11-26'] } }
      : {};
    return route.fulfill({ json: { data, missing: [] } });
  });
  await page.goto('/dashboard');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  const ticker = page.getByRole('region', { name: '시세 지표' });
  const lastQuote = ticker.locator('[data-ticker="BTC-USD"]');
  await expect(lastQuote).toBeAttached();
  await expect(ticker).toHaveCSS('scrollbar-width', 'thin');
  expect(await ticker.evaluate((el) => el.clientWidth)).toBeGreaterThanOrEqual(360);
  await ticker.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => ticker.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await lastQuote.focus();
  await expect(lastQuote).toBeInViewport({ ratio: 0.99 });
  await expect(page.locator('.wfs-date-input')).toBeInViewport({ ratio: 0.99 });
});

async function openWorldLegendFixture(page: Page): Promise<void> {
  await seedAnonymousDashboard(page, 'full');
  await page.addInitScript(() => {
    localStorage.setItem('worldmonitor-first-screen-mode', '"world"');
    localStorage.setItem('wm-locale-explicit', 'ko');
    localStorage.setItem('worldmonitor-theme', 'dark');
  });
  const date = '2026-11-26';
  const snapshot = {
    schemaVersion: 1,
    date,
    availableDates: [date],
    countries: { UA: { level: 'war' } },
    anchors: { UA: [31, 49], US: [-100, 38], CA: [-106, 56] },
    relations: [
      { id: 'support-fixture', origin: 'fixed', kind: 'support', field: 'military', from: 'CA', to: 'UA', score: 90 },
      { id: 'tension-fixture', origin: 'fixed', kind: 'tension', field: 'geopolitics', from: 'US', to: 'UA', score: 80 },
    ],
  };
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/bootstrap?*', (route) => {
    const data = new URL(route.request().url()).searchParams.get('keys') === 'worldOverview'
      ? { worldOverview: snapshot }
      : {};
    return route.fulfill({ json: { data, missing: [] } });
  });
  await page.route('https://tiles.openfreemap.org/styles/**', (route) =>
    route.fulfill({ json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background' }] } }));
  await page.goto('/dashboard');
}

test('SVG legend describes visible overlays and leaves the Layers control clickable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, options?: unknown) {
      return type.startsWith('webgl') ? null : Reflect.apply(getContext, this, [type, options]);
    } as typeof getContext;
  });
  await openWorldLegendFixture(page);
  const map = page.locator('#mapContainer.svg-mode');
  await expect(map.locator('.waterway-diamond').first()).toBeVisible();
  const legend = page.locator('.atlas-key-plate');
  await expect(legend.locator('.wfs-cii-scale')).toBeHidden();
  await expect(legend.locator('.wfs-line-legend')).toBeHidden();
  await expect(legend.locator('[data-marker="waterway"]')).toBeVisible();
  await expect(legend.locator('[data-marker="conflict"]')).toBeVisible();
  const layers = map.locator('.layer-toggles .map-control-disclosure');
  const legendBox = await legend.boundingBox();
  const layersBox = await layers.boundingBox();
  expect(legendBox!.y + legendBox!.height).toBeLessThan(layersBox!.y);
  await layers.click();
  await expect(layers).toHaveAttribute('aria-expanded', 'true');
});

test('legend matches DeckGL fills, relation kinds, and hotspot rings that reach the map', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    // Keep real WebGL2 and allow its software implementation in the test browser.
    const getExtension = WebGL2RenderingContext.prototype.getExtension;
    WebGL2RenderingContext.prototype.getExtension = function (this: WebGL2RenderingContext, name: string) {
      return name === 'WEBGL_debug_renderer_info' ? null : Reflect.apply(getExtension, this, [name]);
    };
  });
  await openWorldLegendFixture(page);
  const map = page.locator('#mapContainer.deckgl-mode');
  await expect(map).toHaveAttribute('data-world-legend', /\bhotspots\b/);
  const legend = page.locator('.atlas-key-plate');
  await expect(legend.locator('.wfs-cii-scale')).toBeVisible();
  await expect(legend.locator('[data-level="4"]')).toHaveCSS('background-color', 'rgb(200, 46, 67)');
  await expect(legend.locator('.wfs-line-key')).toHaveText(['지원', '긴장']);
  await expect(legend.locator('[data-marker="hotspot-ring"]')).toBeVisible();
  await expect(legend.locator('[data-marker="waterway"]')).toBeHidden();
  await page.locator('.domain-tab[data-field="military"]').click();
  await expect(legend.locator('.wfs-cii-scale')).toBeHidden();
  await expect(legend.locator('.wfs-line-key')).toHaveText(['긴장']);
  await expect(legend.locator('[data-marker="hotspot-ring"]')).toBeHidden();
});
