import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INDEXABLE_LANDING_LOCALES,
  defaultLandingLocale,
  indexableLandingPassthroughPrefixes,
  landingByPath,
  landingHreflangCluster,
  nonDefaultLandingLocales,
} from '../shared/indexable-landing-locales.ts';

describe('indexable landing locale registry', () => {
  it('pins English as x-default and keeps path ids aligned with app locale codes', () => {
    const english = defaultLandingLocale();
    assert.equal(english.id, 'en');
    assert.equal(english.canonicalPath, '/');
    assert.equal(english.canonicalUrl, 'https://www.worldmonitor.app/');
    assert.deepEqual(
      nonDefaultLandingLocales().map((locale) => locale.id),
      ['es', 'pt', 'ru', 'fr', 'de', 'ar'],
    );
    const portuguese = INDEXABLE_LANDING_LOCALES.find((locale) => locale.id === 'pt');
    assert.equal(portuguese?.canonicalPath, '/pt/');
    assert.equal(portuguese?.hreflang, 'pt-BR');
    assert.equal(portuguese?.ogLocale, 'pt_BR');
    assert.equal(INDEXABLE_LANDING_LOCALES.find((locale) => locale.id === 'ar')?.dir, 'rtl');
  });

  it('matches only the landing path itself', () => {
    assert.equal(landingByPath('/')?.id, 'en');
    assert.equal(landingByPath('/es')?.id, 'es');
    assert.equal(landingByPath('/es/')?.id, 'es');
    assert.equal(landingByPath('/pt-br/'), undefined);
    assert.equal(landingByPath('/es/dashboard'), undefined);
    assert.equal(landingByPath('/zh'), undefined);
  });

  it('publishes a reciprocal cluster without query-string targets', () => {
    const cluster = landingHreflangCluster();
    assert.equal(cluster[0]?.hreflang, 'x-default');
    assert.equal(cluster[0]?.href, 'https://www.worldmonitor.app/');
    const codes = cluster.map((entry) => entry.hreflang);
    assert.deepEqual(codes, ['x-default', 'en', 'es', 'pt-BR', 'ru', 'fr', 'de', 'ar']);
    assert.equal(new Set(codes).size, codes.length);
    for (const entry of cluster) {
      assert.equal(new URL(entry.href).search, '');
      assert.doesNotMatch(entry.href, /[?&]lang=/i);
    }
    assert.deepEqual(
      indexableLandingPassthroughPrefixes(),
      ['/es', '/pt', '/ru', '/fr', '/de', '/ar'],
    );
  });

});
