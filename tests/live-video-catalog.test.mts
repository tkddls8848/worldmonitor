import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { AUDIT_CANARIES, LIVE_NEWS_SOURCES } from '../src/config/live-video-sources.ts';
import { parseSourceEntry, type Candidate } from '../src/services/live-video/model.ts';


// The built-in Live News channel list lives in src/services/live-channels.ts (#8293); the panel only plays it.
const newsChannels = readFileSync(new URL('../src/services/live-channels.ts', import.meta.url), 'utf8')
  + readFileSync(new URL('../src/components/LiveNewsPanel.ts', import.meta.url), 'utf8');
function newsChannelIds(arrayName: string): string[] {
  const body = newsChannels.match(new RegExp(`const ${arrayName}[^=]*=[^\\[]*\\[([\\s\\S]*?)\\n\\];`))?.[1] ?? '';
  return [...body.matchAll(/\{\s*id:\s*'([^']+)',\s*name:/g)].map((match) => match[1]!);
}
const defaultNewsIds = [...newsChannelIds('FULL_LIVE_CHANNELS'), ...newsChannelIds('TECH_LIVE_CHANNELS')];
const builtinNewsIds = new Set([...defaultNewsIds, ...newsChannelIds('OPTIONAL_LIVE_CHANNELS')]);

// Streams deliberately shared by two Live News channels. Anything else repeated is a paste mistake.
const SHARED_NEWS_STREAMS = new Map([['video:HvZt-nh9sGg', ['france24', 'france24-en']]]);

function identity(candidate: Candidate): string {
  if (candidate.kind === 'video') return `video:${candidate.videoId}`;
  if (candidate.kind === 'channel') return `channel:${candidate.channelId}`;
  return `hls:${candidate.url}`;
}

describe('live video catalog', () => {
  // Which slots open the wall is the owner's call: emptying a dead slot moves the next one up.
  it('parses every Live News entry as an https stream, a video or a channel', () => {
    for (const [slot, entries] of Object.entries(LIVE_NEWS_SOURCES)) {
      for (const entry of entries) {
        const parsed = parseSourceEntry(entry);
        assert.ok(parsed.ok, `live-news/${slot}: ${entry} is not a valid entry (${parsed.ok ? '' : parsed.problem})`);
      }
    }
  });

  it('never lists the same stream in two Live News channels unless the pair is declared', () => {
    const seen = new Map<string, string[]>();
    for (const [slot, entries] of Object.entries(LIVE_NEWS_SOURCES)) {
      for (const entry of entries) {
        const parsed = parseSourceEntry(entry);
        if (!parsed.ok) continue;
        const key = identity(parsed.candidate);
        seen.set(key, [...(seen.get(key) ?? []), slot]);
      }
    }
    for (const [key, slots] of seen) {
      if (slots.length < 2) continue;
      assert.deepEqual(slots, SHARED_NEWS_STREAMS.get(key), `${key} is listed in live-news/${slots.join(' and live-news/')}; point one channel at the stream instead`);
    }
  });

  it('has exactly one catalog slot per built-in Live News channel', () => {
    assert.ok(builtinNewsIds.size > 50, 'no Live News channel ids found in src/services/live-channels.ts');
    assert.deepEqual([...builtinNewsIds].sort(), Object.keys(LIVE_NEWS_SOURCES).sort());
  });

  it('does not list CNBC, whose only YouTube live stream is a documentary marathon', () => {
    assert.equal('cnbc' in LIVE_NEWS_SOURCES, false, 'cnbc must not have a Live News catalog slot');
    assert.doesNotMatch(readFileSync(new URL('../src/config/live-video-sources.ts', import.meta.url), 'utf8'), /\bcnbc\b/i);
  });

  it('gives every default Live News channel at least one entry', () => {
    for (const id of defaultNewsIds) {
      assert.ok((LIVE_NEWS_SOURCES as Record<string, readonly string[]>)[id]?.length, `default channel live-news/${id} has no entries`);
    }
  });

  it('keeps stream addresses out of the Live News channel list and panel', () => {
    assert.doesNotMatch(newsChannels, /\.m3u8/, 'HLS stream URLs belong in src/config/live-video-sources.ts');
    assert.doesNotMatch(newsChannels, /fallbackVideoId:\s*'/, 'video ids belong in src/config/live-video-sources.ts');
  });

  it('never plays a slate clip as a live channel', () => {
    // CNN's cnn_slate playlist is a ~10-minute VOD (#EXT-X-ENDLIST) that played under a LIVE label.
    const slates = Object.entries(LIVE_NEWS_SOURCES).filter(([, entries]) => entries.some((entry) => /cnn_slate|[/_-]slate[/_.-]/i.test(entry)));
    assert.deepEqual(slates, []);
  });

  it('lists a channel at most once in a slot', () => {
    for (const [slot, entries] of Object.entries(LIVE_NEWS_SOURCES)) {
      const channels = entries.map((entry) => parseSourceEntry(entry)).flatMap((parsed) => (parsed.ok && parsed.candidate.kind === 'channel' ? [parsed.candidate.channelId] : []));
      assert.equal(new Set(channels).size, channels.length, `${slot} lists a channel twice`);
    }
  });

  // Broadcasters that restart their stream under a new video id list only their channel (#8545): the audit and the
  // refresh play whatever the channel has live, so no pinned id can rot. Each id was read from the broadcaster's
  // @handle page and from the owner of the id it replaced, and its /live page resolved to the news stream
  // (2026-09-24). Changing one means re-checking it with `npm run live-video:check -- <channel URL>`.
  const CHANNEL_ONLY_SLOTS: Record<string, string> = {
    'cbc-news': 'UCuFFtHWoLl5fauMMD5Ww2jA',
    'cnn-turk': 'UCV6zcRug6Hqp1UX_FdyUeBg',
    'cnn-brasil': 'UCvdwhh_fDyWccR42-rReZLw',
    'noticias-caracol': 'UC2Xq2PK-got3Rtz9ZJ32hLQ',
    t13: 'UCsRnhjcUCR78Q3Ud6OXCTNg',
    'abp-news': 'UCRWFSbif-RFENbBrSiez1DA',
    'channels-tv': 'UCEXGDNclvmg6RW0vipJYsTQ',
    'france-info': 'UCO6K_kkdP-lnSCiO3tPx7WA',
  };
  // Rotating ids whose channel's featured live was not the news stream when checked (2026-09-24), and channels whose
  // featured live is another stream (#8574): they keep a pinned id and list no channel.
  const PINNED_NOT_CHANNEL = ['milenio', 'cti-news', 'wion', 'ann-news', 'ntv-news', 'tbs-news'];

  it('lists only the verified channel for broadcasters that restart their stream', () => {
    const news = LIVE_NEWS_SOURCES as Record<string, readonly string[]>;
    for (const [slot, channelId] of Object.entries(CHANNEL_ONLY_SLOTS)) {
      const youtube = (news[slot] ?? []).map((entry) => parseSourceEntry(entry)).filter((parsed) => parsed.ok && parsed.candidate.kind !== 'hls');
      assert.ok(youtube.length > 0, `live-news/${slot} lists no YouTube entry`);
      const [first] = youtube;
      assert.ok(first?.ok && first.candidate.kind === 'channel' && first.candidate.channelId === channelId, `live-news/${slot} must list channel ${channelId} as its first YouTube entry`);
      assert.ok(youtube.every((parsed) => parsed.ok && parsed.candidate.kind !== 'video'), `live-news/${slot} must not pin a video id: the channel restarts its stream`);
    }
  });

  it('lists no channel for slots whose channel features another stream', () => {
    const news = LIVE_NEWS_SOURCES as Record<string, readonly string[]>;
    for (const slot of PINNED_NOT_CHANNEL) {
      const entries = news[slot] ?? [];
      assert.ok(entries.length > 0, `live-news/${slot} has no entries`);
      for (const entry of entries) {
        const parsed = parseSourceEntry(entry);
        assert.ok(!(parsed.ok && parsed.candidate.kind === 'channel'), `live-news/${slot} lists ${entry}, whose featured live is not the news stream`);
      }
    }
  });

  it('uses channel live embeds as audit canaries', () => {
    assert.equal(AUDIT_CANARIES.length, 2);
    for (const entry of AUDIT_CANARIES) {
      const parsed = parseSourceEntry(entry);
      assert.ok(parsed.ok && parsed.candidate.kind === 'channel', `${entry} must be a channel URL`);
    }
  });

  it('keeps the Fox News preview and lists LiveNOW from FOX as its own channel', () => {
    assert.deepEqual([...LIVE_NEWS_SOURCES['fox-news']], [
      'https://247preview.foxnews.com/hls/live/2020027/fncv3preview/primary.m3u8',
    ]);
    assert.deepEqual([...LIVE_NEWS_SOURCES['livenow-fox']], [
      'https://cdn-uw2-prod.tsv2.amagi.tv/linear/amg00488-foxdigital-livenowbyfox-lgus/playlist.m3u8',
    ]);
    const parsed = parseSourceEntry(LIVE_NEWS_SOURCES['livenow-fox'][0]);
    assert.ok(parsed.ok && parsed.candidate.kind === 'hls', 'LiveNOW from FOX must be an HLS candidate');
    assert.match(newsChannels, /id:\s*'livenow-fox',\s*name:\s*'LiveNOW from FOX'/);
  });
});
