import { expect, test } from '@playwright/test';

test('Live News does not overlap adjacent dashboard panels (#8276)', async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.addInitScript(() => {
    localStorage.setItem('worldmonitor-variant', 'full');
    localStorage.setItem('worldmonitor-first-screen-mode', '"full"');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-inspector-tab-v1', 'news');
    localStorage.setItem(
      'wm-pro-banner-launched-dismissed',
      String(Date.now()),
    );
  });

  await page.setViewportSize({
    width: 1600,
    height: 866,
  });

  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  const news = page.locator(
    '#panelsGrid > .panel[data-panel="live-news"]',
  );

  await expect(news).toHaveCount(1, {
    timeout: 60_000,
  });

  await expect(news).not.toHaveClass(/panel-deferred-shell/, { timeout: 60_000 });

  // Live News holds one player and takes two rows at every desktop height.
  for (const height of [590, 671, 672, 866]) {
    await page.setViewportSize({
      width: 1600,
      height,
    });
    await news.scrollIntoViewIfNeeded();
    await expect.poll(
      async () => page.evaluate(() => {
        const grid = document.querySelector('#panelsGrid');

        if (!grid) return false;

        const panels = Array.from(
          grid.querySelectorAll<HTMLElement>(':scope > .panel'),
        ).filter(
          panel => getComputedStyle(panel).display !== 'none',
        );

        const parsedGap = Number.parseFloat(getComputedStyle(grid).rowGap);
        const rowGap = Number.isFinite(parsedGap) ? parsedGap : 4;
        const panel = panels.find(candidate => candidate.dataset.panel === 'live-news');
        if (!panel) return false;

        const wantHeight = 2 * 200 + rowGap;
        const rect = panel.getBoundingClientRect();
        const style = getComputedStyle(panel);
        const next = panels
          .filter(candidate => candidate !== panel)
          .map(candidate => ({
            panel: candidate,
            rect: candidate.getBoundingClientRect(),
          }))
          .filter(candidate => {
            const horizontalOverlap =
              Math.min(rect.right, candidate.rect.right) -
              Math.max(rect.left, candidate.rect.left);

            return (
              horizontalOverlap > 20 &&
              candidate.rect.top > rect.top + 5
            );
          })
          .sort(
            (a, b) => a.rect.top - b.rect.top,
          )[0];

        if (!next) return false;

        const gap = next.rect.top - rect.bottom;

        return (
          style.gridRowStart === 'span 2' &&
          Math.abs(rect.height - wantHeight) <= 2 &&
          Math.abs(gap - rowGap) <= 2 &&
          !panel.classList.contains('resized')
        );
      }),
      {
        message:
          `Video panel layout at 1600x${height}`,
        timeout: 30_000,
      },
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1600, height: 866 });
  await news.scrollIntoViewIfNeeded();
  // The player fills the panel: no empty band between the video and the
  // panel's bottom edge, at the natural size and after a user makes it taller.
  const deadSpaceBelowPlayer = () => news.evaluate((element) => {
    const player = element.querySelector('.live-news-player');
    if (!player) return null;
    return Math.round(element.getBoundingClientRect().bottom - player.getBoundingClientRect().bottom);
  });
  await expect.poll(deadSpaceBelowPlayer, { message: 'natural Live News footprint' }).toBeLessThanOrEqual(16);
  expect(await deadSpaceBelowPlayer()).toBeGreaterThanOrEqual(0);
  const footprint = (panel: typeof news) => panel.evaluate(element => ({
    span: getComputedStyle(element).gridRowStart,
    height: Math.round(element.getBoundingClientRect().height),
  }));
  // A user can enable every optional channel (85); the wrapped channel bar
  // must not push a collapsed panel past its one grid row.
  await news.evaluate((element) => {
    const switcher = element.querySelector('.live-news-switcher')!;
    const buttons = Array.from(switcher.querySelectorAll('.live-channel-btn'));
    for (let i = 0; switcher.querySelectorAll('.live-channel-btn').length < 85; i++) {
      const clone = buttons[i % buttons.length]!.cloneNode(true) as HTMLElement;
      clone.classList.remove('active');
      switcher.appendChild(clone);
    }
  });
  // A collapsed video panel is only a header, so it reserves one grid row
  // instead of the two-row .panel-wide footprint.
  {
    const panel = news;
    await panel.locator('.panel-collapse-btn').click();
    await expect(panel).toHaveClass(/panel-collapsed/);
    await expect.poll(() => footprint(panel)).toMatchObject({ span: 'span 1' });
    expect((await footprint(panel)).height).toBeLessThanOrEqual(200);
  }
  const expectedRowGap = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#panelsGrid')!).rowGap) || 4);
  {
    const panel = news;
    await panel.locator('.panel-collapse-btn').click();
    await expect(panel).not.toHaveClass(/panel-collapsed/);
    const expectedSpan = 2;
    await expect.poll(() => footprint(panel)).toEqual({
      span: `span ${expectedSpan}`,
      height: expectedSpan * 200 + (expectedSpan - 1) * expectedRowGap,
    });
  }
  const newsHandle = news.locator(':scope > .panel-resize-handle');
  await newsHandle.focus();
  await newsHandle.press('End');
  await expect(news).toHaveClass(/\bspan-4\b/);
  await expect.poll(deadSpaceBelowPlayer, { message: 'four-row Live News footprint' }).toBeLessThanOrEqual(16);
  expect(await deadSpaceBelowPlayer(), 'four-row player stays inside the panel').toBeGreaterThanOrEqual(0);
});

test('collapsing user-resized Live News releases its grid rows (#10185)', async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.addInitScript(() => {
    localStorage.setItem('worldmonitor-variant', 'full');
    localStorage.setItem('worldmonitor-first-screen-mode', '"full"');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-inspector-tab-v1', 'news');
    localStorage.setItem(
      'wm-pro-banner-launched-dismissed',
      String(Date.now()),
    );
  });

  await page.setViewportSize({ width: 1600, height: 866 });
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  const footprint = (id: string) => page.evaluate((panelId) => {
    const panel = document.querySelector<HTMLElement>(
      `#panelsGrid > .panel[data-panel="${panelId}"]`,
    );
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    const below = Array.from(
      document.querySelectorAll<HTMLElement>('#panelsGrid > .panel'),
    )
      .filter(other => other !== panel && getComputedStyle(other).display !== 'none')
      .map(other => other.getBoundingClientRect())
      .filter(other =>
        Math.min(rect.right, other.right) - Math.max(rect.left, other.left) > 20 &&
        other.top > rect.top + 5)
      .sort((a, b) => a.top - b.top)[0];
    return {
      span: getComputedStyle(panel).gridRowStart,
      height: Math.round(rect.height),
      gapBelow: below ? Math.round(below.top - rect.bottom) : null,
    };
  }, id);

  for (const id of ['live-news']) {
    const panel = page.locator(`#panelsGrid > .panel[data-panel="${id}"]`);
    const toggle = panel.locator('.panel-collapse-btn');
    const handle = panel.locator(':scope > .panel-resize-handle');

    await expect(handle).toHaveCount(1, { timeout: 60_000 });
    const gridRowGap = await page.evaluate(() => {
      const parsed = Number.parseFloat(getComputedStyle(document.querySelector('#panelsGrid')!).rowGap);
      return Number.isFinite(parsed) ? parsed : 4;
    });
    const span4Height = 4 * 200 + 3 * gridRowGap;
    await handle.focus();
    await handle.press('End');
    await expect(panel).toHaveClass(/\bresized\b/);
    await expect.poll(() => footprint(id)).toMatchObject({ span: 'span 4', height: span4Height });

    await toggle.click();
    await expect(panel).toHaveClass(/panel-collapsed/);
    await expect.poll(() => footprint(id), {
      message: `collapsed resized ${id} reserves one grid row`,
    }).toMatchObject({ span: 'span 1' });
    const collapsed = await footprint(id);
    expect(collapsed!.height, `${id} collapsed height`).toBeLessThanOrEqual(200);
    expect(collapsed!.gapBelow, `${id} has a panel below`).not.toBeNull();
    expect(collapsed!.gapBelow!, `${id} does not overlap the next panel`).toBeGreaterThanOrEqual(0);
    expect(collapsed!.height + collapsed!.gapBelow!, `${id} collapsed slot`).toBeLessThanOrEqual(200 + gridRowGap);
    await expect(handle, `${id} row resize is unavailable while collapsed`).toBeHidden();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(panel).toHaveClass(/panel-collapsed/, { timeout: 60_000 });
    await panel.scrollIntoViewIfNeeded();
    await expect(panel).not.toHaveClass(/panel-deferred-shell/);
    await expect.poll(() => footprint(id)).toMatchObject({ span: 'span 1' });

    await toggle.click();
    await expect(panel).not.toHaveClass(/panel-collapsed/);
    await expect(handle).toBeVisible();
    await expect.poll(() => footprint(id), {
      message: `expanded ${id} restores the saved span`,
    }).toMatchObject({ span: 'span 4', height: span4Height });
  }

  expect(await page.evaluate(() => localStorage.getItem('worldmonitor-panel-spans')))
    .toBe(JSON.stringify({ 'live-news': 4 }));
});

test('legacy bottom-set Live News migrates into the inspector grid and releases rows on collapse (#10185)', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.addInitScript(() => {
    localStorage.setItem('worldmonitor-variant', 'full');
    localStorage.setItem('worldmonitor-first-screen-mode', '"full"');
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-inspector-tab-v1', 'news');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
  });
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.dataset.wmEventHandlersReady === 'true');
  // Seed legacy persisted bottom-set placement; Option B retires #mapBottomGrid
  // and migrates those panels cleanly into #panelsGrid under their domain tab.
  await page.evaluate(() => {
    const order = Array.from(document.querySelectorAll<HTMLElement>('.panel[data-panel]'))
      .map(panel => panel.dataset.panel!);
    localStorage.setItem('panel-order', JSON.stringify(order));
    localStorage.setItem('panel-order-bottom-set', JSON.stringify(['live-news']));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await expect(page.locator('#mapBottomGrid > .panel')).toHaveCount(0);

  for (const id of ['live-news']) {
    const panel = page.locator(`#panelsGrid > .panel[data-panel="${id}"]`);
    const handle = panel.locator(':scope > .panel-resize-handle');
    const toggle = panel.locator('.panel-collapse-btn');
    const toolbar = panel.locator('.live-news-toolbar');
    const span = () => panel.evaluate(element => getComputedStyle(element).gridRowStart);
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await panel.evaluate(element => element.scrollIntoView({ block: 'nearest' }));
    await expect(panel).not.toHaveClass(/panel-deferred-shell/);
    await handle.focus();
    await handle.press('End');
    await expect.poll(span).toBe('span 4');
    await expect(toolbar).toBeVisible();
    await toggle.click();
    await expect(panel).toHaveClass(/panel-collapsed/);
    await page.screenshot({ path: testInfo.outputPath(`${id}-collapsed-bottom.png`) });
    await expect.poll(span, { message: `collapsed ${id} reserves one bottom-grid row` }).toBe('span 1');
    await expect(toolbar).toBeHidden();
    await expect(handle).toBeHidden();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(panel).toHaveClass(/panel-collapsed/, { timeout: 60_000 });
    await expect.poll(span).toBe('span 1');
    // A collapsed shell below the expanded news panel mounts only once
    // scrolled into view. Wait for the real controls before exercising them.
    await panel.evaluate(element => element.scrollIntoView({ block: 'nearest' }));
    await expect(panel).not.toHaveClass(/panel-deferred-shell/);
    await expect(toolbar).toHaveCount(1);
    await expect(toolbar).toBeHidden();
    await toggle.click();
    await expect(panel).not.toHaveClass(/panel-collapsed/);
    await expect.poll(span).toBe('span 4');
    await expect(toolbar).toBeVisible();
    await expect(handle).toBeVisible();
  }
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('worldmonitor-panel-spans')!)))
    .toEqual({ 'live-news': 4 });
});
