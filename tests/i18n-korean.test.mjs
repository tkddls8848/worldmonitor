import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

const source = readFileSync(new URL('../src/services/i18n.ts', import.meta.url), 'utf8');
const korean = JSON.parse(readFileSync(new URL('../src/locales/ko.json', import.meta.url), 'utf8'));

// Execute the actual registered lookup functions and detection order, without
// importing Vite's import.meta.glob in Node. This exercises i18next precedence,
// including environments whose browser language differs from the default.
async function detect(href, explicit) {
  const detector = new LanguageDetector();
  const window = { location: { href } };
  const localStorage = { getItem: () => explicit };
  const readQueryLanguage = (value) => new URL(value).searchParams.get('lang') || undefined;
  for (const match of source.matchAll(/detector\.addDetector\((\{[\s\S]*?\n  \})\);/g)) {
    detector.addDetector(Function('window', 'localStorage', 'readQueryLanguage', 'EXPLICIT_LOCALE_KEY', `return (${match[1]});`)(window, localStorage, readQueryLanguage, 'wm-locale-explicit'));
  }
  const order = source.match(/order: (\[[^\]]+\])/)[1];
  const instance = i18next.createInstance();
  await instance.use(detector).init({
    resources: { ko: { translation: korean }, en: { translation: {} }, fr: { translation: {} } },
    supportedLngs: ['ko', 'en', 'fr'], fallbackLng: 'en',
    detection: { order: Function(`return ${order};`)(), caches: [] },
  });
  return instance;
}

test('fresh personal installation selects Korean without persisting a choice', async () => {
  const instance = await detect('http://localhost/dashboard', null);
  assert.equal(instance.language, 'ko');
  assert.equal(instance.t('components.playback.live'), '실시간');
  assert.equal(instance.t('popups.timeUnits.h'), '시간');
});

test('saved and shared explicit language choices override the Korean default', async () => {
  assert.equal((await detect('http://localhost/dashboard', 'en')).language, 'en');
  assert.equal((await detect('http://localhost/dashboard?lang=fr', 'en')).language, 'fr');
});
