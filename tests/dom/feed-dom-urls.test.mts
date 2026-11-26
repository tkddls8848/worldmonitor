import { afterEach, beforeAll, expect, it } from 'vitest';
import { MonitorPanel } from '@/components/MonitorPanel';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);
afterEach(() => document.body.replaceChildren());
const url = 'https://example.com/story?a=1&b=2';
it('preserves query parameters on a monitor news link', () => {
  const panel = new MonitorPanel([{ id: 'm', keywords: ['news'], color: '#fff' }]);
  document.body.append(panel.getElement());
  panel.renderResults([{ title: 'news', link: url, source: 'test', isAlert: false, pubDate: new Date() }]);
  expect(panel.getElement().querySelector('a')!.getAttribute('href')).toBe(url);
  panel.destroy();
});
