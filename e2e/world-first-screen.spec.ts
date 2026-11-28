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
  const lastQuote = ticker.locator('[data-ticker="KRW=X"]');
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

async function openBattleFixture(page: Page): Promise<void> {
  await seedAnonymousDashboard(page, 'full');
  await page.addInitScript(() => {
    localStorage.setItem('worldmonitor-first-screen-mode', '"world"');
    localStorage.setItem('wm-locale-explicit', 'ko');
    localStorage.setItem('worldmonitor-theme', 'dark');
  });
  const now = Date.now();
  const date = new Date(now).toISOString().slice(0, 10);
  const snapshot = {
    schemaVersion: 1, date, availableDates: [date], countries: { KR: { level: 'high' } },
    anchors: { KR: [128, 37], JP: [137, 36], UA: [31, 49], RU: [70, 58], CA: [-106, 56], US: [-100, 39] },
  };
  const link = (actor: string, target: string, kind: string, age: number, magnitude: number) => ({
    id: `${kind}:${actor}:${target}`, actor, target, kind, direction: 'pressure', magnitude,
    trend: age < 24 ? 'new' : 'steady', firstSeen: now - age * 3_600_000, lastSeen: now - age * 3_600_000,
    evidence: [{ source: 'Fixture authority', title: 'Verifiable original headline', url: 'https://example.com/evidence', publishedAt: now - age * 3_600_000 }],
  });
  const korea = link('JP', 'KR', 'sanctions', 8, 85);
  const headline = '일본이 한국에 수출 제한을 발표했다';
  const links = [
    link('CA', 'US', 'tariffs', 1, 92),
    { ...korea, headline, evidence: [{ ...korea.evidence[0]!, aiExtracted: true, aiSummary: headline, singleSource: true }] },
    link('RU', 'UA', 'conflict', 528, 100),
    { ...link('CA', 'UA', 'support', 48, 80), direction: 'support', undirected: true },
  ];
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
  await page.route('**/api/world-overview/v1/get-impact-links?*', (route) => route.fulfill({ json: {
    generatedAt: now, links, summary: { today: links.slice(0, 2), byCountry: {} },
    sources: [{ id: 'ucdp', status: 'delayed', dataAsOf: links[2]!.lastSeen }],
    countryEvents: [{ id: 'country:conflict:KR', country: 'KR', kind: 'conflict', eventCount: 7,
      magnitude: 48, lastSeen: links[2]!.lastSeen, evidence: links[2]!.evidence }],
  } }));
  await page.route('**/api/bootstrap?*', (route) => {
    const data = new URL(route.request().url()).searchParams.get('keys') === 'worldOverview' ? { worldOverview: snapshot } : {};
    return route.fulfill({ json: { data, missing: [] } });
  });
  await page.route('https://tiles.openfreemap.org/styles/**', (route) =>
    route.fulfill({ json: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background' }] } }));
  await page.goto('/dashboard');
}

for (const renderer of ['svg', 'deckgl'] as const) {
  test(`Battle Map draws the same pressure and impact key in ${renderer}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    if (renderer === 'svg') {
      await page.addInitScript(() => {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, options?: unknown) {
          return type.startsWith('webgl') ? null : Reflect.apply(getContext, this, [type, options]);
        } as typeof getContext;
      });
    } else {
      await page.addInitScript(() => {
        // Allow headless software GL while keeping the real WebGL renderer.
        const getExtension = WebGL2RenderingContext.prototype.getExtension;
        WebGL2RenderingContext.prototype.getExtension = function (this: WebGL2RenderingContext, name: string) {
          return name === 'WEBGL_debug_renderer_info' ? null : Reflect.apply(getExtension, this, [name]);
        };
      });
    }
    await openBattleFixture(page);
    const map = page.locator(`#mapContainer.${renderer}-mode`);
    await expect(map).toHaveAttribute('data-world-legend', /\bfill\b/);
    if (renderer === 'svg') await expect(map.locator('.layer-toggles')).toBeHidden();
    const legend = page.locator('.bm-key-plate');
    await expect(legend.locator('.wfs-cii-scale')).toBeVisible();
    await expect(legend.locator('[data-level="4"]')).toHaveCSS('background-color', 'rgb(166, 34, 54)');
    await expect(legend.locator('.bm-line-key')).toHaveText(['충돌', '제재', '관세', '지지 (양자)']);
    await expect(page.locator('.bm-arc[data-undirected="true"] .bm-arc-arrow')).toHaveCount(0);
    if (renderer === 'deckgl') expect(await map.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none');
    const domestic = page.locator('.bm-country-event');
    await expect(domestic).toHaveAttribute('aria-label', /국내 무력 사건 · 7건/);
    const conflictFilter = page.locator('.bm-filters button[data-kind="conflict"]');
    await expect(conflictFilter).toHaveText('충돌 1');
    await conflictFilter.click();
    await expect(domestic).toBeVisible();
    await expect(page.locator('.bm-arc[data-kind="conflict"]')).toHaveCount(0);
    await conflictFilter.click();
    const arc = page.locator('.bm-arc[data-kind="tariffs"]');
    await expect(arc.locator('.bm-arc-core')).toHaveAttribute('d', /^M.*Q/);
    await expect(arc.locator('.bm-arc-core')).toHaveAttribute('stroke-dasharray', '4 3 9 3');
    await expect(arc.locator('.bm-arc-tracer')).toBeHidden();
    await expect(page.locator('.bm-arc[data-kind="conflict"]')).toHaveAttribute('opacity', '0.32');

    const point = await arc.locator('path.bm-arc-hit').evaluate((path: SVGPathElement) => {
      const bounds = path.ownerSVGElement!.getBoundingClientRect();
      const location = path.getPointAtLength(path.getTotalLength() * 0.55);
      return { x: bounds.left + location.x, y: bounds.top + location.y };
    });
    await page.mouse.click(point.x, point.y);
    const evidence = page.locator('.bm-link-drawer');
    await expect(evidence).toHaveAttribute('data-state', 'open');
    await expect(evidence.getByRole('link', { name: 'Verifiable original headline' })).toHaveAttribute('href', 'https://example.com/evidence');
    await page.keyboard.press('Escape');
    for (const id of ['tariffs:CA:US', 'sanctions:JP:KR']) {
      if (await evidence.getAttribute('data-state') === 'open') await page.keyboard.press('Escape');
      const chip = page.locator(`.bm-strip [data-impact-id="${id}"]`);
      await page.getByRole('button', { name: '확대', exact: true }).click();
      await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      const selectedArc = page.locator(`.bm-arc[data-link-id="${id}"]`);
      await expect(selectedArc).toHaveAttribute('opacity', '1');
      await expect(evidence.getByRole('link', { name: 'Verifiable original headline' })).toBeVisible();
      if (id === 'sanctions:JP:KR') {
        await expect(chip).toContainText('일본이 한국에 수출 제한을 발표했다');
        await expect(evidence.locator('.bm-source-label')).toContainText('AI 추출 · 단일 출처');
        await expect(evidence.getByRole('link', { name: 'Verifiable original headline' })).toHaveAttribute('href', 'https://example.com/evidence');
      }
      await expect.poll(() => selectedArc.locator('.bm-arc-core').evaluate((element: SVGPathElement) => {
        if (!element.hasAttribute('d')) return false;
        const viewport = element.ownerSVGElement!.getBoundingClientRect();
        const drawer = document.querySelector('.bm-link-drawer[data-state="open"]')!.getBoundingClientRect();
        return [0, element.getTotalLength()].every((distance) => {
          const point = element.getPointAtLength(distance);
          const x = point.x + viewport.left;
          const y = point.y + viewport.top;
          return x >= viewport.left && x <= viewport.right && y >= viewport.top && y <= viewport.bottom
            && (x <= drawer.left || x >= drawer.right || y <= drawer.top || y >= drawer.bottom);
        });
      })).toBe(true);
    }
    await evidence.getByRole('button', { name: '대한민국' }).click();
    const brief = page.locator('.wfs-country-drawer:not(.bm-link-drawer)');
    await expect(brief).toHaveAttribute('data-state', 'open');
    await expect(brief.locator('[data-section="impact"]')).toContainText('수신 1');
    await expect(brief.locator('[data-section="korea-economy"]')).toBeAttached();
    await expect(brief.locator('[data-section="country-events"]')).toContainText('국내 무력 사건 · 7건');
    await brief.getByRole('button', { name: '국가 상세 닫기' }).click();

    await page.getByRole('button', { name: '24H', exact: true }).click();
    await expect(page.locator('.bm-arc[data-kind="conflict"]')).toHaveCount(0);
    await expect(legend.locator('.bm-line-key')).toHaveText(['제재', '관세']);
    await page.locator('.bm-filters button[data-kind="sanctions"]').click();
    await page.locator('.bm-filters button[data-kind="tariffs"]').click();
    await expect(page.locator('.bm-status')).toHaveAttribute('data-state', 'filtered');
    await page.getByRole('button', { name: '7D로 확장' }).click();
    await expect(legend.locator('.bm-line-key')).toHaveText(['충돌', '지지 (양자)']);
    await legend.getByRole('button', { name: 'CII', exact: true }).click();
    await expect(legend.locator('[data-level="4"]')).toHaveCSS('background-color', 'rgb(200, 46, 67)');
  });
}
