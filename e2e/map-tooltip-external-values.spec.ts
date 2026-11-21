import { expect, test } from '@playwright/test';

test('map tooltip external values remain text', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.goto('/tests/map-harness.html');
  await page.waitForFunction(() => (window as Window & { __mapHarness?: { ready: boolean } }).__mapHarness?.ready === true);

  const labels = await page.evaluate(async () => {
    const deckModule = '/src/components/DeckGLMap.ts';
    const { DeckGLMap } = await import(/* @vite-ignore */ deckModule);
    const getTooltip = DeckGLMap.prototype.getTooltip;
    const disease = (cases: unknown) => getTooltip.call({}, {
      layer: { id: 'disease-outbreaks-layer' },
      object: { item: {
        disease: 'Cholera', location: 'Test location', alertLevel: 'warning',
        sourceName: 'ThinkGlobalHealth', publishedAt: Date.UTC(2026, 8, 1), cases,
      } },
    }).html;

    return {
      disease: [disease('<img src=x onerror=alert(1)>'), disease(1), disease(42), disease(0)],
    };
  });

  expect(labels.disease[0]).toContain('&lt;img');
  expect(labels.disease[1]).toContain('1 case</span>');
  expect(labels.disease[2]).toContain('42 cases</span>');
  expect(labels.disease[3]).not.toContain(' case');

  await page.evaluate(({ disease }) => {
    const evidence = document.createElement('main');
    evidence.id = 'tooltip-evidence';
    evidence.style.cssText = 'position:fixed;inset:20px;z-index:999999;background:#111c29;color:#eee;padding:28px;font:16px/1.8 sans-serif';
    evidence.innerHTML = '<h1>Map tooltip regression fixtures</h1><p>Controlled external values; actual renderer output</p>'
      + disease.map(html => `<section style="margin:14px;padding:12px;border:1px solid #617186">${html}</section>`).join('');
    document.body.appendChild(evidence);
  }, labels);
  const evidence = page.locator('#tooltip-evidence');
  await expect(evidence.locator('img, script, b')).toHaveCount(0);
  await expect(evidence).toContainText('Cholera');
  await evidence.screenshot({ path: 'test-results/map-tooltip-external-values.png' });
});
