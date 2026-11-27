import { expect, test, type Page } from '@playwright/test';

const LIVE_MEDIA_REQUEST = /(?:youtube\.com\/embed|youtube\.com\/iframe_api|googlevideo\.com|\/api\/youtube-embed|\/videoplayback(?:[?#/]|$)|\.m3u8(?:[?#]|$))/i;

/** Click-to-play everywhere: the viewer has switched Live News autoplay off in Settings. */
async function installCleanLiveMediaPrefs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.removeItem('wm-live-streams-always-on');
    localStorage.setItem('wm-live-news-autoplay', 'false');
    localStorage.removeItem('wm-live-media-idle-stop');
    localStorage.removeItem('worldmonitor-active-channel');
  });
}

async function installAlwaysOnLiveMediaPrefs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('wm-live-streams-always-on', 'true');
    localStorage.removeItem('wm-live-news-autoplay');
    localStorage.removeItem('wm-live-media-idle-stop');
    localStorage.removeItem('worldmonitor-active-channel');
  });
}

async function liveNewsTransportCount(page: Page): Promise<number> {
  return page.evaluate(() => (
    document.querySelectorAll(
      '.panel[data-panel="live-news"] iframe[src*="youtube"], .panel[data-panel="live-news"] iframe[src*="/api/youtube-embed"], .panel[data-panel="live-news"] video.live-news-media',
    ).length
  ));
}

/**
 * The dashboard swaps a deferred shell for the real panel while it settles. Scrolling or observing the
 * shell races that swap ("Element is not attached"), and the real panel's lazy start never sees it.
 */
async function waitForRealPanel(page: Page, panelId: string): Promise<void> {
  await page.waitForFunction((id) => {
    const panel = document.querySelector<HTMLElement>(`.panel[data-panel="${id}"]`);
    return panel !== null && panel.dataset.deferredPanel !== 'true';
  }, panelId, { timeout: 60_000 });
}

async function disablePanelViaStoredSettings(page: Page, panelId: string): Promise<void> {
  await setPanelEnabledViaStoredSettings(page, panelId, false);
}

async function setPanelEnabledViaStoredSettings(page: Page, panelId: string, enabled: boolean): Promise<void> {
  await page.evaluate(({ targetPanelId, enabled }) => {
    const key = 'worldmonitor-panels';
    const oldValue = localStorage.getItem(key);
    const panels = oldValue
      ? JSON.parse(oldValue) as Record<string, { enabled?: boolean; name?: string; priority?: number }>
      : {};
    if (!oldValue) {
      document.querySelectorAll<HTMLElement>('.panel[data-panel]').forEach((panel, index) => {
        const id = panel.dataset.panel;
        if (!id || panels[id]) return;
        const title = panel.querySelector('.panel-title')?.textContent?.trim() || id;
        panels[id] = { name: title, enabled: !panel.classList.contains('hidden'), priority: index + 1 };
      });
    }
    if (!panels[targetPanelId]) throw new Error(`Panel ${targetPanelId} is not in stored settings`);
    panels[targetPanelId] = { ...panels[targetPanelId], enabled };
    const newValue = JSON.stringify(panels);
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent('storage', {
      key,
      oldValue,
      newValue,
      storageArea: localStorage,
      url: window.location.href,
    }));
  }, { targetPanelId: panelId, enabled });
}

test.describe('live media intent gating', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('worldmonitor-first-screen-mode', '"full"');
      localStorage.setItem('wm-inspector-tab-v1', 'news');
      localStorage.setItem('wm-locale-explicit', 'en');
    });
  });

  test('a first visit autoplays Live News', async ({ page }) => {
    await page.addInitScript(() => {
      for (const key of ['wm-live-streams-always-on', 'wm-live-news-autoplay', 'wm-live-media-idle-stop', 'worldmonitor-active-channel']) {
        localStorage.removeItem(key);
      }
    });

    await page.goto('/dashboard?liveMediaDefault=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    await expect(liveNews).toBeVisible({ timeout: 60_000 });
    await waitForRealPanel(page, 'live-news');
    await liveNews.scrollIntoViewIfNeeded();
    // No click: the default starts Live News on its own.
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
    await expect(liveNews.getByRole('button', { name: /play live feed/i })).toHaveCount(0);

  });

  test('keeps live media idle until click, then starts Live News', async ({ page }) => {
    await installCleanLiveMediaPrefs(page);
    const mediaRequests: string[] = [];
    page.on('request', (request) => {
      if (LIVE_MEDIA_REQUEST.test(request.url())) mediaRequests.push(request.url());
    });

    await page.goto('/dashboard?liveMediaIntent=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');

    await expect(liveNews).toBeVisible({ timeout: 60_000 });
    await waitForRealPanel(page, 'live-news');
    await liveNews.scrollIntoViewIfNeeded();
    await page.waitForTimeout(3000);

    expect(await liveNewsTransportCount(page)).toBe(0);
    expect(mediaRequests, `live media request(s) before intent: ${mediaRequests.join('\n')}`).toEqual([]);

    await liveNews.getByRole('button', { name: /play live feed/i }).click();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
  });

  test('tears down live news media on hidden tab and panel close', async ({ page }) => {
    await installCleanLiveMediaPrefs(page);

    await page.goto('/dashboard?liveMediaTeardown=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    await expect(liveNews).toBeVisible({ timeout: 60_000 });

    await liveNews.getByRole('button', { name: /play live feed/i }).click();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);

    await page.evaluate(() => {
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);

    await page.evaluate(() => {
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await liveNews.getByRole('button', { name: /play live feed/i }).click();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
    await liveNews.locator('.panel-close-btn').dispatchEvent('click');
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);
  });

  test('stops live news after an hour idle with a notice, resumes only on request, and keeps playing when asked', async ({ page }) => {
    const minute = 60_000;
    const hour = 60 * minute;
    await installCleanLiveMediaPrefs(page);
    await page.clock.install();

    await page.goto('/dashboard?liveMediaIdle=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    const idleNotice = liveNews.locator('.live-media-shell--idle');
    await expect(liveNews).toBeVisible({ timeout: 60_000 });

    await liveNews.getByRole('button', { name: /play live feed/i }).click();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);

    await page.clock.fastForward(5 * minute);
    await page.waitForTimeout(1500);
    expect(await liveNewsTransportCount(page)).toBe(1);

    await page.clock.fastForward(hour);
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);
    await expect(idleNotice).toContainText(/paused for inactivity/i);
    await expect(idleNotice).toContainText('Live video stopped after 1 hour without mouse, keyboard or touch activity.');
    await expect(idleNotice.getByRole('button', { name: 'Resume' })).toBeVisible();
    await expect(idleNotice.getByRole('button', { name: 'Keep playing when idle' })).toBeVisible();

    await page.mouse.move(20, 20);
    await page.mouse.move(240, 240);
    await page.waitForTimeout(1500);
    expect(await liveNewsTransportCount(page)).toBe(0);
    await expect(idleNotice).toBeVisible();

    await idleNotice.getByRole('button', { name: 'Resume' }).click();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);

    await page.clock.fastForward(hour);
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);
    await idleNotice.getByRole('button', { name: 'Keep playing when idle' }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('wm-live-media-idle-stop'))).toBe('never');
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);

    await page.clock.fastForward(5 * hour);
    await page.waitForTimeout(1500);
    expect(await liveNewsTransportCount(page)).toBe(1);
    await expect(idleNotice).toHaveCount(0);
  });

  test('a saved always-on dashboard keeps live news playing through a long idle stretch', async ({ page }) => {
    await installAlwaysOnLiveMediaPrefs(page);
    await page.clock.install();

    await page.goto('/dashboard?liveMediaIdleAlwaysOn=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    await expect(liveNews).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);

    await page.clock.fastForward(5 * 60 * 60_000);
    await page.waitForTimeout(1500);
    expect(await liveNewsTransportCount(page)).toBe(1);
    await expect(liveNews.locator('.live-media-shell--idle')).toHaveCount(0);
  });

  test('tears down Live News when it is disabled through stored settings', async ({ page }) => {
    await installCleanLiveMediaPrefs(page);

    await page.goto('/dashboard?liveMediaDisableSettings=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    await expect(liveNews).toBeVisible({ timeout: 60_000 });

    await liveNews.getByRole('button', { name: /play live feed/i }).click();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
    await disablePanelViaStoredSettings(page, 'live-news');
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);
    await expect(liveNews).toHaveClass(/hidden/);

    await disablePanelViaStoredSettings(page, 'live-news');
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);
    await expect(liveNews).toHaveClass(/hidden/);
  });

  test('always-on mode waits for visibility, then starts Live News', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 220 });
    await installAlwaysOnLiveMediaPrefs(page);
    const mediaRequests: string[] = [];
    page.on('request', (request) => {
      if (LIVE_MEDIA_REQUEST.test(request.url())) mediaRequests.push(request.url());
    });

    await page.goto('/dashboard?liveMediaAlwaysOnVisibility=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    await expect(liveNews).toBeAttached({ timeout: 60_000 });
    await page.waitForTimeout(3000);

    expect(await liveNewsTransportCount(page)).toBe(0);
    expect(mediaRequests, `live media request(s) before visibility: ${mediaRequests.join('\n')}`).toEqual([]);

    await liveNews.scrollIntoViewIfNeeded();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);

    await page.evaluate(() => {
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);

    await page.evaluate(() => {
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
  });

  test('turning autoplay off keeps Live News playing', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 220 });
    await installAlwaysOnLiveMediaPrefs(page);

    await page.goto('/dashboard?liveMediaAlwaysOnToggleOff=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    await expect(liveNews).toBeAttached({ timeout: 60_000 });
    await waitForRealPanel(page, 'live-news');

    await liveNews.scrollIntoViewIfNeeded();
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);

    await page.evaluate(() => {
      localStorage.setItem('wm-live-streams-always-on', 'false');
      window.dispatchEvent(new CustomEvent('wm-live-streams-settings-changed', {
        detail: { alwaysOn: false },
      }));
    });
    // Leaving always-on must NOT collapse the wall — feeds already playing stay until the idle stop.
    await page.waitForTimeout(1500);
    expect(await liveNewsTransportCount(page)).toBe(1);
  });

  test('always-on live news restarts after disable and re-enable through stored settings', async ({ page }) => {
    await installAlwaysOnLiveMediaPrefs(page);

    await page.goto('/dashboard?liveMediaAlwaysOnPanelReenable=1', { waitUntil: 'domcontentloaded' });
    const liveNews = page.locator('.panel[data-panel="live-news"]');
    await expect(liveNews).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);

    await disablePanelViaStoredSettings(page, 'live-news');
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 10_000 }).toBe(0);
    await expect(liveNews).toHaveClass(/hidden/);

    await setPanelEnabledViaStoredSettings(page, 'live-news', true);
    await expect(liveNews).not.toHaveClass(/hidden/);
    await expect.poll(() => liveNewsTransportCount(page), { timeout: 30_000 }).toBe(1);
  });

});
