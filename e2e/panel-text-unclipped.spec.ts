import { expect, test, type Page } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

// Verify that each Predictions label stays within its segment at all fixture widths.

const CLOSES_AT = Date.parse('2027-12-31T00:00:00Z');

const MARKETS = [
  { id: 'm1', title: 'Will the Fed cut rates at the December meeting?', yesPrice: 0.89 },
  { id: 'm2', title: 'Iran leadership change by December 31?', yesPrice: 0.13 },
  { id: 'm3', title: 'Will Brent close above $90 this year?', yesPrice: 0.87 },
  { id: 'm4', title: 'US recession declared in 2027?', yesPrice: 0.5 },
].map((m) => ({ ...m, volume: 28_800_000, url: `https://polymarket.com/event/${m.id}`, closesAt: CLOSES_AT, category: 'geopolitics', source: 'MARKET_SOURCE_POLYMARKET' }));

const VIEWPORTS = [
  { width: 1920, height: 1200, mobile: false },
  { width: 1366, height: 768, mobile: false },
  { width: 393, height: 852, mobile: true },
];

interface LabelFit { text: string; outside: number }

function measureLabels(page: Page): Promise<{ panel: number; labels: LabelFit[] }> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#panelsGrid .panel[data-panel="polymarket"]')!;
    const labels = [...panel.querySelectorAll<HTMLElement>('.prediction-label')].map((label) => {
      const own = label.parentElement!.getBoundingClientRect();
      const bar = label.closest('.prediction-bar')!.getBoundingClientRect();
      const r = label.getBoundingClientRect();
      const outside = Math.max(own.left - r.left, r.right - own.right, bar.left - r.left, r.right - bar.right, 0);
      return { text: label.textContent!.trim(), outside: Math.round(outside * 10) / 10 };
    });
    return { panel: Math.round(panel.getBoundingClientRect().width), labels };
  });
}

test('prediction labels are never clipped', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  for (const viewport of VIEWPORTS) {
    const { mobile, ...size } = viewport;
    const context = await browser.newContext({ viewport: size, colorScheme: 'dark', isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    await seedAnonymousDashboard(page, 'full', {
      localStorage: {
        'wm-inspector-tab-v1': 'markets',
        'worldmonitor-panels': JSON.stringify({
          polymarket: { name: 'Predictions', enabled: true, priority: 0 },
        }),
      },
    });
    await page.route(/^https?:\/\/(?!(127\.0\.0\.1:4173|localhost:4173)(?:\/|$)).*/i, (route) => route.abort());
    await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
    await page.route('**/api/bootstrap*', (route) => route.fulfill({ json: { missing: [], data: {} } }));
    await page.route(/list-prediction-markets/, (route) => route.fulfill({ json: { markets: MARKETS, fetchedAt: Date.now(), dataAvailable: true } }));

    await page.goto('/dashboard');
    const variant = `${viewport.width}${mobile ? '-phone' : ''}`;

    const predictions = page.locator('#panelsGrid .panel[data-panel="polymarket"]');
    await expect
      .poll(async () => {
        await predictions.scrollIntoViewIfNeeded().catch(() => {});
        return predictions.locator('.prediction-bar').count();
      }, { message: `prediction bars at ${variant}`, timeout: 90_000 })
      .toBe(MARKETS.length);
    await predictions.screenshot({ path: testInfo.outputPath(`polymarket-${variant}.png`) });
    const bars = await measureLabels(page);
    expect(bars.labels).toHaveLength(MARKETS.length * 2);
    expect.soft(
      bars.labels.filter((label) => label.outside > 0.5),
      `polymarket at ${variant} (panel ${bars.panel}px): labels outside their segment`,
    ).toEqual([]);

    await context.close();
  }
});
