#!/usr/bin/env node

/**
 * Seed research data to Redis for 4 research endpoints:
 * - listArxivPapers (cs.AI default category)
 * - listHackernewsItems (top feed)
 * - listTrendingRepos (python, javascript, typescript daily)
 */

import ARXIV_CATEGORIES from './shared/research-arxiv-categories.json' with { type: 'json' };

import { loadEnvFile, CHROME_UA, runSeed, writeExtraKeyWithMeta, sleep } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

// The canonical key's staleness gate. Exported so the TTL invariant below is pinned by a test.
export const RESEARCH_MAX_STALE_MIN = 150;
// 3h. MUST outlive the health staleness gate (RESEARCH_MAX_STALE_MIN → 9000s) so a merely-late
// tick degrades to STALE_SEED (last-good still served) instead of an EMPTY crit, and it is ≈3×
// the ~hourly cron so a single arXiv blip stays a graceful exit-0 RETRY rather than exit-1 +
// `researchArxivHnTrending` EMPTY in prod (issue #5409). Was 3600 (≈1× cron, BELOW the gate).
export const ARXIV_TTL = 10800;
// ≈3× the hourly cron, like ARXIV_TTL: 600s left every HN feed EMPTY for ~50 min of each hour.
export const HN_TTL = 10800;
// ≈3× the hourly cron, like ARXIV_TTL and HN_TTL.
export const TRENDING_TTL = 10800;

// ─── arXiv Papers ───


// Parse arXiv Atom XML into paper records. Pure — split out so the fetch path stays testable.
function parseArxivEntries(xml) {
  const papers = [];
  const entryBlocks = xml.split('<entry>').slice(1);
  for (const block of entryBlocks) {
    const id = (block.match(/<id>([\s\S]*?)<\/id>/)?.[1] || '').trim().split('/').pop() || '';
    const title = (block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '').trim().replace(/\s+/g, ' ');
    const summary = (block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || '').trim().replace(/\s+/g, ' ');
    const published = block.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() || '';
    const publishedAt = published ? new Date(published).getTime() : 0;
    const urlMatch = block.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/);
    const paperUrl = urlMatch?.[1] || `https://arxiv.org/abs/${id}`;

    const authors = [];
    const authorMatches = block.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g);
    for (const m of authorMatches) authors.push(m[1].trim());

    const cats = [];
    const catMatches = block.matchAll(/<category[^>]*term="([^"]+)"/g);
    for (const m of catMatches) cats.push(m[1]);

    if (title && id) papers.push({ id, title, summary, authors, categories: cats, publishedAt, url: paperUrl });
  }
  return papers;
}

// Fetch ONE arXiv category with a bounded retry. arXiv intermittently times out (#5409); a
// single transient timeout on the PRIMARY category (cs.AI) used to zero the whole record set,
// so retry once before giving up. Returns [] on a non-retryable HTTP error; throws only if
// every attempt failed (the caller isolates that per-category). `fetchFn`/`sleepFn` injectable
// for tests.
export async function fetchArxivCategory(cat, { fetchFn = fetch, retries = 1, sleepFn = sleep } = {}) {
  const url = `https://export.arxiv.org/api/query?search_query=cat:${cat}&sortBy=submittedDate&sortOrder=descending&start=0&max_results=50`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const resp = await fetchFn(url, {
        headers: { Accept: 'application/xml', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) { console.warn(`  arXiv ${cat}: HTTP ${resp.status}`); return []; }
      return parseArxivEntries(await resp.text());
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleepFn(2000); // brief backoff before the retry
    }
  }
  throw lastErr;
}

// Fetch all arXiv categories with PER-CATEGORY ISOLATION (#5409). A timeout on one category
// must not discard the others — in particular a good cs.AI (the primary record key that drives
// declareRecords) must survive a cs.CL/cs.CR blip. Previously the loop let any category error
// reject the whole function, so a single arXiv timeout zeroed the primary record set → exit 1 +
// `researchArxivHnTrending` EMPTY in prod. Never throws: a total outage returns {} so the caller's
// Promise.allSettled stays fulfilled and runSeed takes the graceful last-good RETRY path.
export async function fetchArxivPapers({ fetchFn = fetch, retries = 1, sleepFn = sleep } = {}) {
  const results = {};
  for (const cat of ARXIV_CATEGORIES) {
    try {
      const papers = await fetchArxivCategory(cat, { fetchFn, retries, sleepFn });
      if (papers.length > 0) results[`research:arxiv:v1:${cat}::50`] = { papers, pagination: undefined };
      console.log(`  arXiv ${cat}: ${papers.length} papers`);
    } catch (e) {
      console.warn(`  arXiv ${cat} failed: ${e?.message || e} — other categories unaffected`);
    }
    await sleepFn(3000); // arXiv rate limit: 1 req/3s
  }
  return results;
}

// ─── Hacker News ───

export async function fetchHackerNews() {
  const feeds = ['top', 'new', 'best', 'ask', 'show', 'job'];
  const results = {};

  for (const feed of feeds) {
    try {
      const idsResp = await fetch(`https://hacker-news.firebaseio.com/v0/${feed}stories.json`, {
        headers: { 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(10_000),
      });
      if (!idsResp.ok) { console.warn(`  HN ${feed}: HTTP ${idsResp.status}`); continue; }
      const allIds = await idsResp.json();
      if (!Array.isArray(allIds)) continue;

      const ids = allIds.slice(0, 30);
      const items = [];

      for (let i = 0; i < ids.length; i += 10) {
        const batch = ids.slice(i, i + 10);
        const batchResults = await Promise.all(
          batch.map(async (id) => {
            try {
              const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
                headers: { 'User-Agent': CHROME_UA },
                signal: AbortSignal.timeout(5_000),
              });
              if (!res.ok) return null;
              const raw = await res.json();
              if (!raw || (raw.type !== 'story' && raw.type !== 'job')) return null;
              return {
                id: raw.id || 0, title: raw.title || '', url: raw.url || '',
                score: raw.score || 0, commentCount: raw.descendants || 0,
                by: raw.by || '', submittedAt: (raw.time || 0) * 1000,
              };
            } catch { return null; }
          }),
        );
        items.push(...batchResults.filter(Boolean));
      }

      const cacheKey = `research:hackernews:v1:${feed}:30`;
      if (items.length > 0) {
        results[cacheKey] = { items, pagination: undefined };
      }
      console.log(`  HN ${feed}: ${items.length} stories`);
    } catch (error) {
      console.warn(`  HN ${feed} failed: ${error?.message || error}`);
    }
  }
  return results;
}

// ─── Trending Repos ───

const OSSINSIGHT_LANG_MAP = { python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript' };

async function fetchTrendingFromOSSInsight(lang) {
  const ossLang = OSSINSIGHT_LANG_MAP[lang] || lang;
  const resp = await fetch(
    `https://api.ossinsight.io/v1/trends/repos/?language=${ossLang}&period=past_24_hours`,
    {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!resp.ok) return null;
  const json = await resp.json();
  const rows = json?.data?.rows;
  if (!Array.isArray(rows)) return null;
  return rows.slice(0, 50).map(r => ({
    fullName: r.repo_name || '', description: r.description || '',
    language: r.primary_language || lang, stars: r.stars || 0,
    starsToday: 0, forks: r.forks || 0,
    url: r.repo_name ? `https://github.com/${r.repo_name}` : '',
  }));
}

async function fetchTrendingFromGitHubSearch(lang) {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const resp = await fetch(
    `https://api.github.com/search/repositories?q=language:${lang}+created:>${since}&sort=stars&order=desc&per_page=50`,
    {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!Array.isArray(data?.items)) return null;
  return data.items.map(r => ({
    fullName: r.full_name, description: r.description || '',
    language: r.language || '', stars: r.stargazers_count || 0,
    starsToday: 0, forks: r.forks_count || 0,
    url: r.html_url,
  }));
}

export async function fetchTrendingRepos() {
  const languages = ['python', 'javascript', 'typescript'];
  const results = {};

  for (const lang of languages) {
    try {
      let repos = await fetchTrendingFromOSSInsight(lang);
      if (!repos?.length) repos = await fetchTrendingFromGitHubSearch(lang);
      if (!repos || repos.length === 0) { console.warn(`  Trending ${lang}: no data from any source`); continue; }

      const cacheKey = `research:trending:v1:${lang}:daily:50`;
      results[cacheKey] = { repos, pagination: undefined };
      console.log(`  Trending ${lang}: ${repos.length} repos`);
      await sleep(500);
    } catch (e) {
      console.warn(`  Trending ${lang}: ${e.message}`);
    }
  }
  return results;
}

// ─── Main ───

let allData = null;

async function fetchAll() {
  const [arxiv, hn, trending] = await Promise.allSettled([
    fetchArxivPapers(),
    fetchHackerNews(),
    fetchTrendingRepos(),
  ]);

  allData = {
    arxiv: arxiv.status === 'fulfilled' ? arxiv.value : null,
    hn: hn.status === 'fulfilled' ? hn.value : null,
    trending: trending.status === 'fulfilled' ? trending.value : null,
  };

  if (arxiv.status === 'rejected') console.warn(`  arXiv failed: ${arxiv.reason?.message || arxiv.reason}`);
  if (hn.status === 'rejected') console.warn(`  HN failed: ${hn.reason?.message || hn.reason}`);
  if (trending.status === 'rejected') console.warn(`  Trending failed: ${trending.reason?.message || trending.reason}`);

  if (!allData.arxiv && !allData.hn && !allData.trending) throw new Error('All research fetches failed');

  // Write secondary keys BEFORE returning (runSeed calls process.exit after primary write)
  if (allData.arxiv) {
    for (const [key, data] of Object.entries(allData.arxiv)) {
      if (key === 'research:arxiv:v1:cs.AI::50') continue;
      await writeExtraKeyWithMeta(key, data, ARXIV_TTL, data.papers?.length ?? 0);
    }
  }
  if (allData.hn) { for (const [key, data] of Object.entries(allData.hn)) await writeExtraKeyWithMeta(key, data, HN_TTL, data.items?.length ?? 0); }
  if (allData.trending) { for (const [key, data] of Object.entries(allData.trending)) await writeExtraKeyWithMeta(key, data, TRENDING_TTL, data.repos?.length ?? 0); }

  const primaryKey = allData.arxiv?.['research:arxiv:v1:cs.AI::50'];
  return primaryKey || { papers: [], pagination: undefined };
}

function validate(data) {
  return data?.papers?.length > 0;
}

export function declareRecords(data) {
  return data?.papers?.length ?? 0;
}

// Only run the seeder when invoked directly, so tests can import the fetch helpers above
// without the top-level runSeed firing (mirrors seed-economy.mjs). `.endsWith` avoids the
// import.meta.url-vs-argv symlink realpath fail-open (see test-ci-gotchas).
if (process.argv[1]?.endsWith('seed-research.mjs')) {
  runSeed('research', 'arxiv-hn-trending', 'research:arxiv:v1:cs.AI::50', fetchAll, {
    validateFn: validate,
    ttlSeconds: ARXIV_TTL,
    sourceVersion: 'arxiv-hn-gitter',
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: RESEARCH_MAX_STALE_MIN,
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : ''; console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
