import { expect, test } from '@playwright/test';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

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
