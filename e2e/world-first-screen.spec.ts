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

async function openBattleFixture(page: Page, seam = false): Promise<void> {
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
  const extra = link('CA', 'US', 'tension', 2, 30);
  const today = [
    ...(seam ? [link('US', 'JP', 'tariffs', 1, 94)] : []),
    link('CA', 'US', 'tariffs', 1, 92),
    { ...korea, headline, evidence: [{ ...korea.evidence[0]!, aiExtracted: true, aiSummary: headline, singleSource: true }] },
    extra,
  ];
  const conflict = link('RU', 'UA', 'conflict', 528, 100);
  const links = [...today, conflict, { ...link('CA', 'UA', 'support', 48, 80), direction: 'support', undirected: true }];
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
  await page.route(/\/api\/market\/v1\/list-(market|commodity)-quotes\?/, (route) => route.fulfill({ json: { quotes: [] } }));
  await page.route('**/country-boundary-overrides.geojson', (route) => route.fulfill({ json: { type: 'FeatureCollection', features: [] } }));
  await page.route('**/api/world-overview/v1/get-impact-links?*', (route) => route.fulfill({ json: {
    generatedAt: now, links, summary: { today, byCountry: {} },
    sources: [{ id: 'ucdp', status: 'delayed', dataAsOf: conflict.lastSeen }],
    countryEvents: [{ id: 'country:conflict:KR', country: 'KR', kind: 'conflict', eventCount: 7,
      magnitude: 48, lastSeen: conflict.lastSeen, evidence: conflict.evidence }],
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
    await expect(page.locator('.bm-country-label[data-country="KR"]')).toHaveText('한국');
    await expect(page.locator('.bm-story-label[data-story-for="tariffs:CA:US"]')).toHaveText('캐나다 → 미국 관세');
    const todayChip = page.locator('.bm-strip [data-impact-id="tariffs:CA:US"]');
    await todayChip.hover();
    await expect(page.locator('.bm-arc.bm-preview-link')).toHaveAttribute('data-link-id', 'tariffs:CA:US');
    await expect(page.locator('.bm-arc[data-kind="conflict"]')).toHaveCSS('opacity', '0.12');
    await page.mouse.move(0, 0);
    await todayChip.focus();
    await expect(page.locator('.bm-arc.bm-preview-link')).toHaveCount(1);
    await todayChip.blur();
    await expect(page.locator('.bm-arc.bm-preview-link')).toHaveCount(0);
    const hiddenStory = page.locator('.bm-arc[data-link-id="tension:CA:US"]');
    const hiddenChip = page.locator('.bm-strip [data-impact-id="tension:CA:US"]');
    await expect(hiddenStory).toHaveCount(0);
    await hiddenChip.focus();
    await expect(hiddenStory).toHaveClass(/bm-preview-link/);
    await hiddenChip.blur();
    await expect(hiddenStory).toHaveCount(0);
    await page.locator('.bm-list-toggle').click();
    await expect(page.locator('.bm-link-drawer [data-impact-id="tension:CA:US"]')).toBeVisible();
    await page.keyboard.press('Escape');
    const domestic = page.locator('.bm-country-event[tabindex="0"]');
    const domesticToggle = page.getByRole('button', { name: '국내 사건', exact: true });
    await expect(domestic).toHaveCount(0);
    await domesticToggle.click();
    await expect(domestic).toHaveAttribute('aria-label', /국내 무력 사건 · 7건/);
    await page.reload();
    await expect(domesticToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(domestic).toBeVisible();
    const conflictFilter = page.locator('.bm-filters button[data-kind="conflict"]');
    await expect(conflictFilter).toHaveText('충돌 1');
    await conflictFilter.click();
    await expect(domestic).toBeVisible();
    await expect(page.locator('.bm-arc')).toHaveCount(1);
    await expect(page.locator('.bm-arc[data-kind="conflict"]')).toHaveCount(1);
    await page.getByRole('button', { name: '주요 영향선', exact: true }).click();
    const arc = page.locator('.bm-arc[data-kind="tariffs"][tabindex="0"]');
    await expect(arc.locator('.bm-arc-core')).toHaveAttribute('d', /^M.*Q/);
    await expect(arc.locator('.bm-arc-core')).toHaveAttribute('stroke-dasharray', '4 3 9 3');
    await expect(arc.locator('.bm-arc-tracer')).toBeHidden();
    await expect(page.locator('.bm-arc[data-kind="conflict"]')).toHaveCSS('opacity', '0.558');

    const point = await arc.locator('path.bm-arc-hit').evaluate((path: SVGPathElement) => {
      const point = path.getPointAtLength(path.getTotalLength() * 0.55).matrixTransform(path.getScreenCTM()!);
      return { x: point.x, y: point.y };
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
      const selectedArc = page.locator(`.bm-arc[data-link-id="${id}"][tabindex="0"]`);
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
          const { x, y } = element.getPointAtLength(distance).matrixTransform(element.getScreenCTM()!);
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
    await conflictFilter.click();
    await expect(page.locator('.bm-status')).toHaveAttribute('data-state', 'filtered');
    await page.getByRole('button', { name: '7D로 확장' }).click();
    await expect(legend.locator('.bm-line-key')).toHaveText(['충돌']);
    await legend.getByRole('button', { name: 'CII', exact: true }).click();
    await expect(legend.locator('[data-level="4"]')).toHaveCSS('background-color', 'rgb(200, 46, 67)');
  });
}

for (const renderer of ['svg', 'deckgl'] as const) {
  for (const viewport of [{ width: 1600, height: 900 }, { width: 390, height: 844 }]) {
    test(`Battle Map repeats the atlas across the seam in ${renderer} at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript((renderer) => {
        if (renderer === 'svg') {
          const getContext = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, options?: unknown) {
            return type.startsWith('webgl') ? null : Reflect.apply(getContext, this, [type, options]);
          } as typeof getContext;
        } else {
          const getExtension = WebGL2RenderingContext.prototype.getExtension;
          WebGL2RenderingContext.prototype.getExtension = function (this: WebGL2RenderingContext, name: string) {
            return name === 'WEBGL_debug_renderer_info' ? null : Reflect.apply(getExtension, this, [name]);
          };
        }
      }, renderer);
      await page.route('**/src/components/MapContainer.ts*', async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace('this.isMobile = isMobileDevice();', renderer === 'deckgl' ? 'this.isMobile = false;' : '$&') + `
          const setMode = MapContainer.prototype.setWorldOverviewMode;
          MapContainer.prototype.setWorldOverviewMode = function (on) {
            window.__seamMap = this;
            return setMode.call(this, on);
          };
        ` });
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      await openBattleFixture(page, true);
      const map = page.locator(`#mapContainer.${renderer}-mode`);
      await expect(map).toHaveAttribute('data-world-legend', /\bfill\b/);
      const jump = async (lon: number, zoom: number) => page.evaluate(({ lon, zoom }) => {
        const { __seamMap: map } = window as unknown as {
          __seamMap: {
            deckGLMap?: {
              maplibreMap: { jumpTo(options: { center: [number, number]; zoom: number }): void };
              deckOverlay: { pickObject(options: { x: number; y: number; layerIds: string[] }): { object?: { properties: Record<string, string> } } | null };
            };
            setCenter(lat: number, lon: number, zoom: number, options: { instant: boolean }): number;
            worldProjector(): (lat: number, lon: number) => { x: number; y: number };
          };
        };
        const deck = map.deckGLMap;
        if (deck) deck.maplibreMap.jumpTo({ center: [lon, 44], zoom });
        else map.setCenter(44, lon, zoom, { instant: true });
        return new Promise<[{ x: number; y: number; hit: string }[], number]>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const project = map.worldProjector();
          const rect = document.querySelector('#mapContainer')!.getBoundingClientRect();
          const period = Math.abs(project(0, 180).x - project(0, -180).x);
          const points = [[65, 167], [64, -153]].map(([lat, lng]) => {
            const { x, y } = project(lat!, lng!);
            const visibleX = x + Math.round((rect.width / 2 - x) / period) * period;
            const client = { x: rect.left + visibleX, y: rect.top + y };
            const hit = deck
              ? deck.deckOverlay.pickObject({ x: visibleX, y, layerIds: ['world-overview-fill'] })?.object?.properties['ISO3166-1-Alpha-2'] ?? ''
              : document.elementFromPoint(client.x, client.y)?.matches('.country, .map-atlas-copy') ? 'land' : '';
            return { ...client, hit };
          });
          resolve([points, period]);
        })));
      }, { lon, zoom });
      const expected = renderer === 'deckgl' ? ['RU', 'US'] : ['land', 'land'];
      const pacificArc = page.locator('.bm-arc[data-link-id="tariffs:US:JP"][tabindex="0"] .bm-arc-core');
      await expect(pacificArc).toHaveAttribute('d', /^M.*Q/);
      for (const lon of [178, -178, 898, -898]) {
        for (const zoom of [1, 2]) {
          const [points, period] = await jump(lon, zoom);
          expect(points.map(({ hit }) => hit), `longitude ${lon}, zoom ${zoom}`).toEqual(expected);
          const span = await pacificArc.evaluate((path: SVGPathElement) =>
            Math.abs(path.getPointAtLength(0).x - path.getPointAtLength(path.getTotalLength()).x));
          expect(span).toBeCloseTo(period * 123 / 360, 1);
          if (zoom === 1 && Math.abs(lon) === 178 && process.env.WM_SEAM_SCREENSHOTS) {
            await page.screenshot({ path: `${process.env.WM_SEAM_SCREENSHOTS}-${renderer}-${viewport.width}-${lon}.png` });
          }
        }
      }

      if (renderer === 'deckgl' && viewport.width === 1600) {
        // At this zoom the same markers and arrows must be visible in several worlds at once.
        await jump(178, 0);
        await page.locator('.bm-domestic-toggle').click();
        const repeated = page.locator('.bm-arc[data-link-id="tariffs:US:JP"]');
        await expect.poll(() => repeated.locator('.bm-arc-arrow').count()).toBeGreaterThan(1);
        await expect.poll(() => page.locator('.bm-country-event').count()).toBeGreaterThan(1);
        await expect.poll(() => page.locator('.bm-country-label[data-country="JP"][visibility="visible"]').count()).toBeGreaterThan(1);
        await expect.poll(() => page.locator('.bm-story-label[data-story-for="tariffs:US:JP"][visibility="visible"]').count()).toBeGreaterThan(1);
      }

      for (const [lon, index, country] of [[178, 1, 'US'], [-178, 0, 'RU']] as const) {
        const [points] = await jump(lon, 2);
        const { x, y } = points[index]!;
        await page.mouse.move(x, y);
        if (renderer === 'deckgl') {
          // MapLibre's hit-test tiles can finish loading after the atlas draw.
          await expect.poll(async () => {
            await page.mouse.move(x + 1, y);
            await page.mouse.move(x, y);
            return page.evaluate(() => (window as unknown as {
              __seamMap: { deckGLMap: { hoveredCountryIso2: string | null } };
            }).__seamMap.deckGLMap.hoveredCountryIso2);
          }).toBe(country);
        } else {
          await expect(map.locator(`.country[data-country-id="${country === 'US' ? '840' : '643'}"]`)).toHaveCSS('stroke-width', '1.5px');
        }
        await page.mouse.click(x, y);
        const drawer = page.locator('.wfs-country-drawer:not(.bm-link-drawer)[data-state="open"]');
        await expect(drawer.locator('.wfs-country-drawer__iso')).toHaveText(country);
        await drawer.locator('[data-action="close"]').click();
      }
      expect(errors).toEqual([]);

      await page.locator('.wfs-full-view').click();
      await expect(map).not.toHaveAttribute('data-world-legend', /\bfill\b/);
      await expect(map.locator('.map-atlas-copy')).toHaveCount(0);
      if (renderer === 'deckgl') {
        expect(await page.evaluate(() => (window as unknown as {
          __seamMap: { deckGLMap: { maplibreMap: { getRenderWorldCopies(): boolean } } };
        }).__seamMap.deckGLMap.maplibreMap.getRenderWorldCopies())).toBe(false);
      }
    });
  }
}
