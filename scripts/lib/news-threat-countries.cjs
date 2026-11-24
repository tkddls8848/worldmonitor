'use strict';

const THREAT_COUNTRY_NAME_TO_ISO2 = {
  'afghanistan':'AF','albania':'AL','algeria':'DZ','angola':'AO','argentina':'AR',
  'armenia':'AM','australia':'AU','austria':'AT','azerbaijan':'AZ','bahrain':'BH',
  'bangladesh':'BD','belarus':'BY','belgium':'BE','bolivia':'BO','brazil':'BR',
  'burkina faso':'BF','burma':'MM','cambodia':'KH','cameroon':'CM','canada':'CA',
  'chad':'TD','chile':'CL','china':'CN','colombia':'CO','congo':'CG',
  'costa rica':'CR','croatia':'HR','cuba':'CU','cyprus':'CY',
  'czech republic':'CZ','czechia':'CZ',
  'democratic republic of the congo':'CD','dr congo':'CD','drc':'CD',
  'denmark':'DK','djibouti':'DJ','dominican republic':'DO',
  'ecuador':'EC','egypt':'EG','el salvador':'SV','eritrea':'ER',
  'estonia':'EE','ethiopia':'ET','finland':'FI','france':'FR',
  'georgia':'GE','germany':'DE','ghana':'GH','greece':'GR',
  'guatemala':'GT','guinea':'GN','haiti':'HT','honduras':'HN','hungary':'HU',
  'iceland':'IS','india':'IN','indonesia':'ID','iran':'IR','iraq':'IQ',
  'ireland':'IE','israel':'IL','italy':'IT','ivory coast':'CI',
  'jamaica':'JM','japan':'JP','jordan':'JO','kazakhstan':'KZ',
  'kenya':'KE','kosovo':'XK','kuwait':'KW','kyrgyzstan':'KG',
  'laos':'LA','latvia':'LV','lebanon':'LB','libya':'LY','lithuania':'LT',
  'mali':'ML','mauritania':'MR','mexico':'MX','moldova':'MD',
  'mongolia':'MN','montenegro':'ME','morocco':'MA','mozambique':'MZ',
  'myanmar':'MM','namibia':'NA','nepal':'NP','netherlands':'NL',
  'new zealand':'NZ','nicaragua':'NI','niger':'NE','nigeria':'NG',
  'north korea':'KP','north macedonia':'MK','norway':'NO',
  'oman':'OM','pakistan':'PK','palestine':'PS','panama':'PA',
  'paraguay':'PY','peru':'PE','philippines':'PH','poland':'PL',
  'portugal':'PT','qatar':'QA','romania':'RO','russia':'RU','rwanda':'RW',
  'saudi arabia':'SA','senegal':'SN','serbia':'RS','sierra leone':'SL',
  'singapore':'SG','slovakia':'SK','slovenia':'SI','somalia':'SO',
  'south africa':'ZA','south korea':'KR','south sudan':'SS','spain':'ES',
  'sri lanka':'LK','sudan':'SD','sweden':'SE','switzerland':'CH',
  'syria':'SY','taiwan':'TW','tajikistan':'TJ','tanzania':'TZ',
  'thailand':'TH','togo':'TG','tunisia':'TN','turkey':'TR',
  'turkmenistan':'TM','uganda':'UG','ukraine':'UA',
  'united arab emirates':'AE','uae':'AE',
  'united kingdom':'GB','uk':'GB','united states':'US','usa':'US',
  'uruguay':'UY','uzbekistan':'UZ','venezuela':'VE','vietnam':'VN',
  'yemen':'YE','zambia':'ZM','zimbabwe':'ZW',
  // Key aliases
  'tehran':'IR','moscow':'RU','beijing':'CN','kyiv':'UA','pyongyang':'KP',
  'tel aviv':'IL','gaza':'PS','damascus':'SY','sanaa':'YE','houthi':'YE',
  'kremlin':'RU','pentagon':'US','nato':'','irgc':'IR','hezbollah':'LB',
  'hamas':'PS','taliban':'AF','riyadh':'SA','ankara':'TR',
  'saudi':'SA','houthis':'YE',
};
// Sort by name length desc so longer multi-word names match first (used for tie-breaking same position)
const THREAT_COUNTRY_NAME_ENTRIES = Object.entries(THREAT_COUNTRY_NAME_TO_ISO2)
  .filter(([name, iso2]) => name.length >= 3 && iso2.length === 2)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([name, iso2]) => ({ name, iso2, regex: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') }));

// Returns the single primary affected country — the country appearing immediately after a
// locative preposition or attack verb, which marks the grammatical object/affected entity.
// Returns [] when no such pattern fires (no attribution is better than wrong attribution).
// "UK and US launch strikes on Yemen" → ['YE']
// "US strikes on Yemen condemned by Iran" → ['YE'] (Iran is a reactor, not affected)
// "Yemen says UK and US strikes hit Hodeidah" → [] (Hodeidah is a city, skip)
// "Russia invades Ukraine" → ['UA']
const AFFECTED_PREFIX_RE = /\b(in|on|against|at|into|across|inside|targeting|toward[s]?|invad(?:es?|ed|ing)|attack(?:s|ed|ing)?|bomb(?:s|ed|ing)?|hitt?(?:ing|s)?|strik(?:es?|ing))\s+(?:the\s+)?/gi;
function matchCountryNamesInText(text) {
  const lower = text.toLowerCase();
  let match;
  AFFECTED_PREFIX_RE.lastIndex = 0;
  while ((match = AFFECTED_PREFIX_RE.exec(lower)) !== null) {
    const afterPfx = lower.slice(match.index + match[0].length);
    for (const { name, iso2 } of THREAT_COUNTRY_NAME_ENTRIES) {
      if (afterPfx.startsWith(name) && (afterPfx.length === name.length || /\W/.test(afterPfx[name.length]))) {
        return [iso2];
      }
    }
  }
  return [];
}

// City and region names -> ISO2 (scripts/build-news-places.mjs), longest phrase first.
const NEWS_PLACES = require('../shared/news-places.json');
const NEWS_PLACE_MAX_WORDS = 4;
// Mirrors stripPublisherSuffix in scripts/shared/geo-extract.mjs.
const THREAT_PUBLISHER_CREDIT_WORDS = /\b(?:post|times|news|journal|herald|tribune|guardian|telegraph|gazette|press|reuters|bloomberg|jazeera|bbc|cnn|nbc|cbs|npr|afp|tv|television|radio|daily|weekly|observer|independent|monitor|chronicle|express|mail|standard|insider|magazine|media|network|wire|agency|today|online)\b|\.(?:com|org|net|gov)\b/i;
const THREAT_CREDIT_TAIL_CHARS = 120;
// Every country a lowercased, diacritic-free text names. Place phrases resolve first and are
// blanked, so "new mexico" is US, not MX; country names are then blanked as they match, so
// "sudan" cannot also fire inside "south sudan".
function countriesNamedInText(lower) {
  const tokens = [...lower.matchAll(/[a-z]+/g)];
  const found = [];
  let rest = lower;
  for (let i = 0; i < tokens.length; i++) {
    for (let n = Math.min(NEWS_PLACE_MAX_WORDS, tokens.length - i); n >= 1; n--) {
      const iso2 = NEWS_PLACES[tokens.slice(i, i + n).map((t) => t[0]).join(' ')];
      if (!iso2) continue;
      if (!found.includes(iso2)) found.push(iso2);
      const end = tokens[i + n - 1].index + tokens[i + n - 1][0].length;
      rest = rest.slice(0, tokens[i].index) + ' '.repeat(end - tokens[i].index) + rest.slice(end);
      i += n - 1;
      break;
    }
  }
  for (const { iso2, regex } of THREAT_COUNTRY_NAME_ENTRIES) {
    if (!regex.test(rest)) continue;
    if (!found.includes(iso2)) found.push(iso2);
    rest = rest.replace(new RegExp(regex.source, 'gi'), (m) => ' '.repeat(m.length));
  }
  return found;
}

// The threat summary feeds CII's information score, where a headline that names no
// attack target still says something about every country it mentions: "Saudi Arabia
// intercepts missile near Red Sea oil hub" has no target and used to count for nobody.
// Alert routing keeps the strict single-country rule above.
function threatSummaryCountries(text) {
  const affected = matchCountryNamesInText(text);
  if (affected.length > 0) return affected;
  // Uppercase US/UK are the countries; lowercase "us" stays the pronoun.
  let lower = text.replace(/\bU\.S\.(?:A\.)?/g, 'United States ').replace(/\bU\.K\./g, 'United Kingdom ')
    .replace(/\bUS\b/g, 'United States').replace(/\bUK\b/g, 'United Kingdom')
    .normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  // Drop a trailing " - The Washington Post" credit so the outlet's country is not counted.
  const tailStart = Math.max(0, lower.length - THREAT_CREDIT_TAIL_CHARS);
  const credit = /\s[-–—|]\s+([^-–—|]+)$/.exec(lower.slice(tailStart));
  if (credit) {
    const tail = credit[1].trim();
    const isCredit = tail.split(/\s+/).length <= 6
      && (THREAT_PUBLISHER_CREDIT_WORDS.test(tail) || countriesNamedInText(tail).length === 0);
    if (isCredit) lower = lower.slice(0, tailStart + credit.index);
  }
  return countriesNamedInText(lower);
}

module.exports = { matchCountryNamesInText, threatSummaryCountries };
