// Arabic country names in MCP tool arguments (#9722, "Voice and agent consumers").
//
// An agent serving Arabic-speaking users passes the country the user named,
// in Arabic: "السعودية", "الإمارات", "مصر". Every MCP country argument resolves
// through requireCountryCode / resolveCountryFilter (api/mcp/_country-args.ts)
// or resolveCountryArg directly, so these cases pin that one boundary: CLDR
// Arabic names and common short and official forms resolve for every country
// the English resolver supports, spelling variants normalize, ambiguous or
// conflicting inputs stay unresolved, and the error for an unknown name still
// names the value.

import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  COUNTRY_ARG_HINT,
  requireCountryCode,
  resolveCountryArg,
  resolveCountryFilter,
} from '../api/mcp/_country-args.ts';
import { isAssignedCountryCode, resolveCountryCode } from '../shared/country-code-resolve.ts';
import { normalizeArabicCountryToken, resolveArabicCountryName } from '../shared/country-code-resolve-arabic.ts';
import ARABIC_NAMES from '../shared/country-names-ar.json' with { type: 'json' };
import LOCALIZED_NAMES from '../shared/country-names-localized.json' with { type: 'json' };
import { buildArabicCountryNames } from '../scripts/build-country-names-ar.mjs';
import { normalizeCountryDirectRead } from '../shared/country-brief-host.ts';
import { buildArticlePrompts } from '../server/worldmonitor/news/v1/_shared.ts';
import { HMAC_SECRET, callBody, makePipelineMock } from './helpers/mcp-pro-deps.mjs';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const AR = new Intl.DisplayNames(['ar'], { type: 'region' });

function allAssignedCodes(): string[] {
  const codes: string[] = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (isAssignedCountryCode(code)) codes.push(code);
    }
  }
  return codes;
}

describe('Arabic country names resolve at the MCP argument boundary', () => {
  const cases: Array<[string, string]> = [
    ['السعودية', 'SA'],
    ['المملكة العربية السعودية', 'SA'],
    ['الإمارات', 'AE'],
    ['الإمارات العربية المتحدة', 'AE'],
    ['دولة الإمارات العربية المتحدة', 'AE'],
    ['مصر', 'EG'],
    ['جمهورية مصر العربية', 'EG'],
    ['إيران', 'IR'],
    ['العراق', 'IQ'],
    ['اليمن', 'YE'],
    ['قطر', 'QA'],
    ['الكويت', 'KW'],
    ['البحرين', 'BH'],
    ['عُمان', 'OM'],
    ['سلطنة عمان', 'OM'],
    ['الأردن', 'JO'],
    ['لبنان', 'LB'],
    ['سوريا', 'SY'],
    ['سورية', 'SY'],
    ['فلسطين', 'PS'],
    ['الولايات المتحدة الأمريكية', 'US'],
    ['أمريكا', 'US'],
    ['بريطانيا', 'GB'],
    ['روسيا', 'RU'],
    ['الصين', 'CN'],
    ['تركيا', 'TR'],
    ['السودان', 'SD'],
    ['جنوب السودان', 'SS'],
    ['كوريا الشمالية', 'KP'],
    ['كوريا الجنوبية', 'KR'],
    ['الكونغو الديمقراطية', 'CD'],
    ['ميانمار', 'MM'],
    ['بورما', 'MM'],
  ];
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      assert.equal(requireCountryCode(input, 'test'), expected);
    });
  }

  it('optional country filters accept Arabic names, singly and in arrays', () => {
    assert.deepEqual(resolveCountryFilter('السعودية', 'country'), ['sa']);
    assert.deepEqual(resolveCountryFilter(['الإمارات', 'قطر', 'IQ', 'Iran'], 'countries'), ['ae', 'qa', 'iq', 'ir']);
  });

  it('resolveCountryArg keeps every English, alpha-2 and alpha-3 answer', () => {
    for (const input of ['Iraq', 'IQ', 'IRQ', 'UK', 'Congo (DRC)', 'Myanmar (Burma)', 'ZZ']) {
      assert.equal(resolveCountryArg(input), resolveCountryCode(input), input);
    }
  });
});

describe('Arabic spelling variants normalize', () => {
  const variants: Array<[string, string, string]> = [
    ['without the article', 'سعودية', 'SA'],
    ['without the article', 'عراق', 'IQ'],
    ['bare alef for hamza', 'ايران', 'IR'],
    ['bare alef for hamza', 'الامارات', 'AE'],
    ['bare alef for hamza-below', 'اسرائيل', 'IL'],
    ['haa for taa marbuta', 'السعوديه', 'SA'],
    ['alef maqsura for yaa', 'الولايات المتحده الامريكيه', 'US'],
    ['tatweel', 'الســعودية', 'SA'],
    ['full diacritics', 'العِرَاق', 'IQ'],
    ['Persian yeh and kaf', 'الکویت', 'KW'],
    ['surrounding whitespace', '  مصر  ', 'EG'],
    ['dash or parentheses in a CLDR name', 'الكونغو (كينشاسا)', 'CD'],
    ['Arabic presentation forms', 'ﻣﺼﺮ', 'EG'],
    // A parenthetical modifier is part of the name, not noise to discard:
    // dropping it answered "Sudan (South)" with Sudan.
    ['split name, modifier first', 'السودان (جنوب)', 'SS'],
    ['split name, modifier last', 'غينيا (الاستوائية)', 'GQ'],
    ['split name, Arabic base and code', 'العراق (IQ)', 'IQ'],
    ['split name, English base', 'Iraq (العراق)', 'IQ'],
  ];
  for (const [label, input, expected] of variants) {
    it(`${label}: ${input} -> ${expected}`, () => {
      assert.equal(resolveCountryArg(input), expected);
    });
  }

  it('folds every variant onto one token', () => {
    const forms = ['الإمارات', 'الامارات', 'الإمَارَات', 'الإمـارات', 'إمارات'];
    const keys = new Set(forms.map(normalizeArabicCountryToken));
    assert.equal(keys.size, 1, JSON.stringify([...keys]));
  });
});

describe('Arabic inputs that must not resolve', () => {
  const rejects: Array<[string, string]> = [
    ['two countries named together', 'السعودية (إيران)'],
    ['two countries side by side', 'السعودية إيران'],
    ['a code that contradicts the Arabic name', 'السعودية (IR)'],
    ['an unresolved modifier on a country', 'السودان (مرحبا)'],
    ['an unresolved Arabic base on a code', 'مرحبا (IR)'],
    ['a bare ambiguous name', 'كوريا'],
    ['a city, not a country', 'الرياض'],
    ['a demonym', 'السعودي'],
    ['an unrelated word', 'مرحبا'],
    ['a lone article', 'ال'],
    ['punctuation only', '،؛'],
    ['an overlong value', 'مصر'.repeat(60)],
  ];
  for (const [label, input] of rejects) {
    it(`${label}: ${input.slice(0, 24)}`, () => {
      assert.equal(resolveCountryArg(input), null);
      assert.equal(resolveArabicCountryName(input), null);
    });
  }

  it('Arabic text never reaches the alpha-2 or alpha-3 passthrough', () => {
    assert.equal(resolveArabicCountryName('IQ'), null);
    assert.equal(resolveArabicCountryName('Iraq'), null);
  });

  it('still raises a validation error that names the unresolved value', () => {
    assert.throws(() => requireCountryCode('مرحبا', 'get-country-risk'), (error: Error) => {
      const violations = (error as unknown as { violations: Array<{ field: string; description: string }> }).violations;
      assert.equal(error.name, 'RpcValidationError');
      assert.equal(violations[0]?.field, 'country_code');
      assert.ok(violations[0]?.description.includes('"مرحبا"'), violations[0]?.description);
      assert.ok(violations[0]?.description.includes(COUNTRY_ARG_HINT));
      return true;
    });
  });

  it('the argument hint tells agents Arabic names are accepted', () => {
    assert.match(COUNTRY_ARG_HINT, /Arabic/);
  });
});

describe('Arabic name data', () => {
  const names = ARABIC_NAMES.names as Record<string, string[]>;

  it('covers every assigned country code, and only those', () => {
    assert.deepEqual(Object.keys(names).sort(), allAssignedCodes());
  });

  it('resolves the CLDR Arabic name of every assigned country to that country', () => {
    for (const code of allAssignedCodes()) {
      const cldr = AR.of(code);
      if (!cldr || cldr === code) continue;
      assert.equal(resolveCountryArg(cldr), code, `${code} ${cldr}`);
    }
  });

  it('resolves every committed name to its own country', () => {
    for (const [code, list] of Object.entries(names)) {
      for (const name of list) assert.equal(resolveArabicCountryName(name), code, `${code} ${name}`);
    }
  });

  it('no two countries share a normalized name', () => {
    const owner = new Map<string, string>();
    for (const [code, list] of Object.entries(names)) {
      for (const name of list) {
        const key = normalizeArabicCountryToken(name);
        assert.ok(key, `${code} ${name} normalizes to nothing`);
        const prior = owner.get(key);
        assert.ok(!prior || prior === code, `${name}: ${prior} and ${code} collide on "${key}"`);
        owner.set(key, code);
      }
    }
  });

  it('matches the generator output (node scripts/build-country-names-ar.mjs)', (t) => {
    // CLDR names come from the running ICU. A different CLDR release may
    // rename a country; the committed file records which release built it.
    if (process.versions.cldr !== ARABIC_NAMES.cldr) {
      t.skip(`runtime CLDR ${process.versions.cldr} differs from committed ${ARABIC_NAMES.cldr}`);
      return;
    }
    assert.deepEqual(buildArabicCountryNames(), ARABIC_NAMES);
  });
});

// Arabic summaries use the existing summarize-article output-language path.

// Tools that once accepted only ISO-2 (#9722). Production answered
// get_resilience_indicators {country_code: "مصر"} with -32602 "countryCode
// must be an assigned ISO 3166-1 alpha-2 code" after every other country tool
// had moved to the shared resolver.
