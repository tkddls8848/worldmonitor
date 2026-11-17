// The country-headline matcher of the removed live-pulse freeze
// (scripts/freeze-crawlable-live-pulse.mjs), kept verbatim so the
// list-country-headlines and curated-regional-feed tests still check that the
// RPC rows are publishable grounding: a masthead, an https article URL, a
// publication time and a title that names the country.
import { countryMentionTerms, mentionsCountry } from '../../shared/country-mention.js';

const COUNTRY_HEADLINE_LIMIT = 5;

function normalizeHttpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function selectCountryHeadlines(digestItems, code, limit = COUNTRY_HEADLINE_LIMIT) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized) || !Array.isArray(digestItems)) return [];
  const terms = countryMentionTerms(normalized);
  return digestItems
    .map((item) => {
      const title = String(item?.title || '').trim();
      const source = String(item?.source || '').trim();
      const url = normalizeHttpsUrl(item?.link);
      const publishedAt = Number(item?.publishedAt);
      if (!title || !source || !url || title.includes('**')) return null;
      if (!Number.isFinite(publishedAt) || publishedAt <= 0) return null;
      const text = `${title} ${typeof item?.snippet === 'string' ? item.snippet : ''}`;
      if (!mentionsCountry(text, terms)) return null;
      return {
        row: { title, source, url, publishedAt: new Date(publishedAt).toISOString() },
        importanceScore: Number(item?.importanceScore) || 0,
        publishedAtMs: publishedAt,
      };
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => (
      b.importanceScore - a.importanceScore
      || b.publishedAtMs - a.publishedAtMs
      || a.row.title.localeCompare(b.row.title, 'en-US')
    ))
    .slice(0, limit)
    .map((entry) => entry.row);
}
