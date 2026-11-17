// Single-process replacement for "Redis + redis-rest-proxy" in personal mode.
// Speaks the same Upstash-style REST surface the collectors and API handlers
// already use (GET/POST /{command}/..., POST /, /pipeline, /multi-exec), keeps
// the data in memory, and snapshots it to one NDJSON file. Loopback only.
//
// Scope: one owner, one machine. It is not a general Redis: only the commands
// below exist, and EVAL runs only scripts that have a native equivalent here.
import http from 'node:http';
import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { COMPARE_AND_DELETE_SCRIPT } = require('../shared/compare-and-delete-script.cjs');

// Exact texts of scripts/_seed-utils.mjs SEED_LOCK_RENEW_SCRIPT and
// SEED_LOCK_FENCED_SET_SCRIPT. Not imported: that module is a 2k-line seeder
// runtime. tests/embedded-store.test.mjs asserts these stay byte-identical.
export const SEED_LOCK_RENEW_SCRIPT = [
  "local current = redis.call('GET', KEYS[1])",
  'if current ~= ARGV[1] then',
  "  return {0, current or ''}",
  'end',
  "redis.call('PEXPIRE', KEYS[1], ARGV[2])",
  "return {1, ''}",
].join('\n');
export const SEED_LOCK_FENCED_SET_SCRIPT = [
  "local current = redis.call('GET', KEYS[1])",
  'if current ~= ARGV[1] then',
  "  return {0, current or ''}",
  'end',
  "redis.call('PEXPIRE', KEYS[1], ARGV[2])",
  "if ARGV[4] == '' then",
  "  redis.call('SET', KEYS[2], ARGV[3])",
  'else',
  "  redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])",
  'end',
  "return {1, ''}",
].join('\n');
const LEGACY_COMPARE_AND_DELETE_SCRIPT =
  'if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end';

export const UPSTASH_SLIDING_WINDOW_SHA = '977fb636fb5ceb7e98a96d1b3a1272ba018efdae';

const WRONGTYPE ='WRONGTYPE Operation against a key holding the wrong kind of value';

function toInt(value, name = 'value') {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`ERR ${name} is not an integer or out of range`);
  return n;
}

function toFloat(value) {
  const text = String(value).toLowerCase();
  if (text === '+inf' || text === 'inf') return Infinity;
  if (text === '-inf') return -Infinity;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error('ERR value is not a valid float');
  return n;
}

// Blocking-command timeout in seconds (fractions allowed); 0 waits forever.
function blockTimeoutMs(raw) {
  const seconds = Number(raw);
  if (raw === undefined || !Number.isFinite(seconds)) throw new Error('ERR timeout is not a float or out of range');
  return seconds * 1000;
}

function globToRegExp(glob) {
  let out = '^';
  for (const ch of String(glob)) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`, 's');
}

// Score bound of ZRANGEBYSCORE-style arguments: "(5" is exclusive.
function scoreBound(raw) {
  const text = String(raw);
  return text.startsWith('(') ? { value: toFloat(text.slice(1)), open: true } : { value: toFloat(text), open: false };
}

function sliceRange(length, startRaw, stopRaw) {
  let start = toInt(startRaw);
  let stop = toInt(stopRaw);
  if (start < 0) start = Math.max(0, length + start);
  if (stop < 0) stop = length + stop;
  return [start, Math.min(stop, length - 1)];
}

export function createEngine({ now = () => Date.now() } = {}) {
  /** @type {Map<string, { type: string, value: any, expiresAt: number | null }>} */
  const data = new Map();
  let version = 0; // bumped on every mutation; the persister watches it

  const touch = () => { version += 1; };
  const live = (key) => {
    const entry = data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      data.delete(key);
      touch();
      return undefined;
    }
    return entry;
  };
  const typed = (key, type) => {
    const entry = live(key);
    if (entry && entry.type !== type) throw new Error(WRONGTYPE);
    return entry;
  };
  const ensure = (key, type, make) => {
    let entry = typed(key, type);
    if (!entry) {
      entry = { type, value: make(), expiresAt: null };
      data.set(key, entry);
    }
    touch();
    return entry;
  };
  const dropIfEmpty = (key, entry) => {
    const size = entry.value.size ?? entry.value.length;
    if (size === 0) data.delete(key);
  };
  const setExpiry = (key, at) => {
    const entry = live(key);
    if (!entry) return 0;
    entry.expiresAt = at;
    touch();
    if (at <= now()) data.delete(key);
    return 1;
  };
  const sortedZset = (entry) => [...entry.value.entries()]
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const zsetReply = (pairs, withScores) => withScores
    ? pairs.flatMap(([member, score]) => [member, String(score)])
    : pairs.map(([member]) => member);
  const zByScore = (entry, minRaw, maxRaw) => {
    if (!entry) return [];
    const min = scoreBound(minRaw);
    const max = scoreBound(maxRaw);
    return sortedZset(entry).filter(([, score]) => (min.open ? score > min.value : score >= min.value)
      && (max.open ? score < max.value : score <= max.value));
  };
  const applyLimit = (pairs, args) => {
    const index = args.findIndex((arg) => String(arg).toUpperCase() === 'LIMIT');
    if (index === -1) return pairs;
    const offset = toInt(args[index + 1]);
    const count = toInt(args[index + 2]);
    return count < 0 ? pairs.slice(offset) : pairs.slice(offset, offset + count);
  };
  const hasFlag = (args, flag) => args.some((arg) => String(arg).toUpperCase() === flag);

  // Options arrive as rest arguments. An array literal that starts with a
  // bare option word reads as a Redis command to the command-parity test
  // (tests/redis-rest-proxy-command-parity.test.mjs), which scans scripts/.
  function set(key, value, ...options) {
    let expiresAt = null;
    let nx = false;
    let xx = false;
    let keepTtl = false;
    let returnOld = false;
    for (let i = 0; i < options.length; i += 1) {
      const flag = String(options[i]).toUpperCase();
      if (flag === 'NX') nx = true;
      else if (flag === 'XX') xx = true;
      else if (flag === 'KEEPTTL') keepTtl = true;
      else if (flag === 'GET') returnOld = true;
      else if (flag === 'EX') expiresAt = now() + toInt(options[++i]) * 1000;
      else if (flag === 'PX') expiresAt = now() + toInt(options[++i]);
      else if (flag === 'EXAT') expiresAt = toInt(options[++i]) * 1000;
      else if (flag === 'PXAT') expiresAt = toInt(options[++i]);
      else throw new Error('ERR syntax error');
    }
    const existing = live(key);
    if (returnOld && existing && existing.type !== 'string') throw new Error(WRONGTYPE);
    const old = existing ? existing.value : null;
    if ((nx && existing) || (xx && !existing)) return returnOld ? old : null;
    data.set(key, { type: 'string', value, expiresAt: keepTtl && existing ? existing.expiresAt : expiresAt });
    touch();
    return returnOld ? old : 'OK';
  }

  const listEnd = (raw) => {
    const end = String(raw).toUpperCase();
    if (end !== 'LEFT' && end !== 'RIGHT') throw new Error('ERR syntax error');
    return end;
  };

  // Non-blocking core of LMOVE and BLMOVE. The HTTP layer below makes BLMOVE
  // wait; inside a pipeline or transaction it answers at once, as in Redis.
  function lmove(source, destination, fromRaw, toRaw) {
    const from = listEnd(fromRaw);
    const to = listEnd(toRaw);
    const src = typed(source, 'list');
    if (!src || src.value.length === 0) return null;
    typed(destination, 'list'); // WRONGTYPE before anything moves
    const value = from === 'LEFT' ? src.value.shift() : src.value.pop();
    touch();
    if (source !== destination) dropIfEmpty(source, src);
    const dst = ensure(destination, 'list', () => []);
    if (to === 'LEFT') dst.value.unshift(value);
    else dst.value.push(value);
    return value;
  }

  function incrBy(key, delta) {
    const entry = typed(key, 'string');
    const next = (entry ? toInt(entry.value) : 0) + delta;
    if (entry) entry.value = String(next);
    else data.set(key, { type: 'string', value: String(next), expiresAt: null });
    touch();
    return next;
  }

  const commands = {
    PING: () => 'PONG',
    ECHO: ([message]) => message,
    DBSIZE: () => { let n = 0; for (const key of [...data.keys()]) if (live(key)) n += 1; return n; },
    INFO: () => '# Server\r\nredis_mode:embedded\r\n',

    GET: ([key]) => typed(key, 'string')?.value ?? null,
    SET: ([key, value, ...options]) => set(key, value, ...options),
    SETNX: ([key, value]) => (set(key, value, 'NX') === 'OK' ? 1 : 0),
    SETEX: ([key, seconds, value]) => set(key, value, 'EX', seconds),
    PSETEX: ([key, ms, value]) => set(key, value, 'PX', ms),
    GETSET: ([key, value]) => set(key, value, 'GET'),
    GETDEL: ([key]) => {
      const entry = typed(key, 'string');
      if (!entry) return null;
      data.delete(key);
      touch();
      return entry.value;
    },
    MGET: (keys) => keys.map((key) => { const entry = live(key); return entry && entry.type === 'string' ? entry.value : null; }),
    MSET: (pairs) => { for (let i = 0; i < pairs.length; i += 2) set(pairs[i], pairs[i + 1]); return 'OK'; },
    APPEND: ([key, value]) => {
      const entry = typed(key, 'string');
      const next = (entry ? entry.value : '') + value;
      set(key, next, 'KEEPTTL');
      return Buffer.byteLength(next);
    },
    STRLEN: ([key]) => Buffer.byteLength(typed(key, 'string')?.value ?? ''),
    INCR: ([key]) => incrBy(key, 1),
    DECR: ([key]) => incrBy(key, -1),
    INCRBY: ([key, delta]) => incrBy(key, toInt(delta)),
    DECRBY: ([key, delta]) => incrBy(key, -toInt(delta)),

    DEL: (keys) => { let n = 0; for (const key of keys) if (live(key)) { data.delete(key); n += 1; } if (n) touch(); return n; },
    EXISTS: (keys) => keys.filter((key) => live(key)).length,
    TYPE: ([key]) => live(key)?.type ?? 'none',
    COPY: ([source, destination, ...options]) => {
      const entry = live(source);
      if (!entry || (live(destination) && !hasFlag(options, 'REPLACE'))) return 0;
      data.set(destination, structuredClone(entry));
      touch();
      return 1;
    },
    EXPIRE: ([key, seconds]) => setExpiry(key, now() + toInt(seconds) * 1000),
    PEXPIRE: ([key, ms]) => setExpiry(key, now() + toInt(ms)),
    EXPIREAT: ([key, seconds]) => setExpiry(key, toInt(seconds) * 1000),
    PEXPIREAT: ([key, ms]) => setExpiry(key, toInt(ms)),
    PERSIST: ([key]) => { const entry = live(key); if (!entry || entry.expiresAt === null) return 0; entry.expiresAt = null; touch(); return 1; },
    TTL: ([key]) => { const entry = live(key); if (!entry) return -2; return entry.expiresAt === null ? -1 : Math.ceil((entry.expiresAt - now()) / 1000); },
    PTTL: ([key]) => { const entry = live(key); if (!entry) return -2; return entry.expiresAt === null ? -1 : entry.expiresAt - now(); },
    // One full pass per call: the cursor is always 0 afterwards.
    SCAN: ([, ...options]) => {
      const matchIndex = options.findIndex((arg) => String(arg).toUpperCase() === 'MATCH');
      const pattern = matchIndex === -1 ? null : globToRegExp(options[matchIndex + 1]);
      const keys = [...data.keys()].filter((key) => live(key) && (!pattern || pattern.test(key)));
      return ['0', keys];
    },
    TIME: () => { const ms = now(); return [String(Math.floor(ms / 1000)), String((ms % 1000) * 1000)]; },

    LPUSH: ([key, ...values]) => { const entry = ensure(key, 'list', () => []); entry.value.unshift(...values.reverse()); return entry.value.length; },
    RPUSH: ([key, ...values]) => { const entry = ensure(key, 'list', () => []); entry.value.push(...values); return entry.value.length; },
    LPOP: ([key]) => { const entry = typed(key, 'list'); if (!entry) return null; const value = entry.value.shift(); touch(); dropIfEmpty(key, entry); return value ?? null; },
    RPOP: ([key]) => { const entry = typed(key, 'list'); if (!entry) return null; const value = entry.value.pop(); touch(); dropIfEmpty(key, entry); return value ?? null; },
    LMOVE: ([source, destination, from, to]) => lmove(source, destination, from, to),
    BLMOVE: ([source, destination, from, to, timeout]) => {
      if (blockTimeoutMs(timeout) < 0) throw new Error('ERR timeout is negative');
      return lmove(source, destination, from, to);
    },
    LLEN: ([key]) => typed(key, 'list')?.value.length ?? 0,
    LRANGE: ([key, start, stop]) => {
      const entry = typed(key, 'list');
      if (!entry) return [];
      const [from, to] = sliceRange(entry.value.length, start, stop);
      return entry.value.slice(from, to + 1);
    },
    LTRIM: ([key, start, stop]) => {
      const entry = typed(key, 'list');
      if (!entry) return 'OK';
      const [from, to] = sliceRange(entry.value.length, start, stop);
      entry.value = entry.value.slice(from, to + 1);
      touch();
      dropIfEmpty(key, entry);
      return 'OK';
    },
    LSET: ([key, indexRaw, value]) => {
      const entry = typed(key, 'list');
      if (!entry) throw new Error('ERR no such key');
      let index = toInt(indexRaw);
      if (index < 0) index += entry.value.length;
      if (index < 0 || index >= entry.value.length) throw new Error('ERR index out of range');
      entry.value[index] = value;
      touch();
      return 'OK';
    },
    LREM: ([key, countRaw, value]) => {
      const entry = typed(key, 'list');
      if (!entry) return 0;
      const count = toInt(countRaw);
      let removed = 0;
      const limit = count === 0 ? Infinity : Math.abs(count);
      const list = count < 0 ? [...entry.value].reverse() : entry.value;
      const kept = list.filter((item) => { if (item === value && removed < limit) { removed += 1; return false; } return true; });
      entry.value = count < 0 ? kept.reverse() : kept;
      if (removed) touch();
      dropIfEmpty(key, entry);
      return removed;
    },

    HSET: ([key, ...pairs]) => {
      const entry = ensure(key, 'hash', () => new Map());
      let added = 0;
      for (let i = 0; i < pairs.length; i += 2) { if (!entry.value.has(pairs[i])) added += 1; entry.value.set(pairs[i], pairs[i + 1]); }
      return added;
    },
    HMSET: (args) => { commands.HSET(args); return 'OK'; },
    HSETNX: ([key, field, value]) => { const entry = ensure(key, 'hash', () => new Map()); if (entry.value.has(field)) return 0; entry.value.set(field, value); return 1; },
    HGET: ([key, field]) => typed(key, 'hash')?.value.get(field) ?? null,
    HMGET: ([key, ...fields]) => { const entry = typed(key, 'hash'); return fields.map((field) => entry?.value.get(field) ?? null); },
    HGETALL: ([key]) => [...(typed(key, 'hash')?.value.entries() ?? [])].flat(),
    HKEYS: ([key]) => [...(typed(key, 'hash')?.value.keys() ?? [])],
    HVALS: ([key]) => [...(typed(key, 'hash')?.value.values() ?? [])],
    HLEN: ([key]) => typed(key, 'hash')?.value.size ?? 0,
    HEXISTS: ([key, field]) => (typed(key, 'hash')?.value.has(field) ? 1 : 0),
    HDEL: ([key, ...fields]) => {
      const entry = typed(key, 'hash');
      if (!entry) return 0;
      const removed = fields.filter((field) => entry.value.delete(field)).length;
      if (removed) touch();
      dropIfEmpty(key, entry);
      return removed;
    },
    HINCRBY: ([key, field, delta]) => {
      const entry = ensure(key, 'hash', () => new Map());
      const next = toInt(entry.value.get(field) ?? 0) + toInt(delta);
      entry.value.set(field, String(next));
      return next;
    },

    SADD: ([key, ...members]) => { const entry = ensure(key, 'set', () => new Set()); const before = entry.value.size; for (const member of members) entry.value.add(member); return entry.value.size - before; },
    SREM: ([key, ...members]) => {
      const entry = typed(key, 'set');
      if (!entry) return 0;
      const removed = members.filter((member) => entry.value.delete(member)).length;
      if (removed) touch();
      dropIfEmpty(key, entry);
      return removed;
    },
    SMEMBERS: ([key]) => [...(typed(key, 'set')?.value ?? [])],
    SISMEMBER: ([key, member]) => (typed(key, 'set')?.value.has(member) ? 1 : 0),
    SCARD: ([key]) => typed(key, 'set')?.value.size ?? 0,
    SSCAN: ([key]) => ['0', [...(typed(key, 'set')?.value ?? [])]],

    ZADD: ([key, ...rest]) => {
      const flags = new Set();
      while (rest.length && /^(NX|XX|GT|LT|CH)$/i.test(String(rest[0]))) flags.add(String(rest.shift()).toUpperCase());
      if (rest.length === 0 || rest.length % 2) throw new Error('ERR syntax error');
      const entry = ensure(key, 'zset', () => new Map());
      let added = 0;
      let changed = 0;
      for (let i = 0; i < rest.length; i += 2) {
        const score = toFloat(rest[i]);
        const member = rest[i + 1];
        const current = entry.value.get(member);
        if (current === undefined) { if (flags.has('XX')) continue; entry.value.set(member, score); added += 1; continue; }
        if (flags.has('NX') || (flags.has('GT') && score <= current) || (flags.has('LT') && score >= current)) continue;
        if (current !== score) { entry.value.set(member, score); changed += 1; }
      }
      dropIfEmpty(key, entry);
      return flags.has('CH') ? added + changed : added;
    },
    ZREM: ([key, ...members]) => {
      const entry = typed(key, 'zset');
      if (!entry) return 0;
      const removed = members.filter((member) => entry.value.delete(member)).length;
      if (removed) touch();
      dropIfEmpty(key, entry);
      return removed;
    },
    ZSCORE: ([key, member]) => { const score = typed(key, 'zset')?.value.get(member); return score === undefined ? null : String(score); },
    ZCARD: ([key]) => typed(key, 'zset')?.value.size ?? 0,
    ZRANGE: ([key, start, stop, ...options]) => {
      const entry = typed(key, 'zset');
      if (!entry) return [];
      const withScores = hasFlag(options, 'WITHSCORES');
      const rev = hasFlag(options, 'REV');
      if (hasFlag(options, 'BYSCORE')) {
        const pairs = rev ? zByScore(entry, stop, start).reverse() : zByScore(entry, start, stop);
        return zsetReply(applyLimit(pairs, options), withScores);
      }
      const pairs = rev ? sortedZset(entry).reverse() : sortedZset(entry);
      const [from, to] = sliceRange(pairs.length, start, stop);
      return zsetReply(pairs.slice(from, to + 1), withScores);
    },
    ZREVRANGE: ([key, start, stop, ...options]) => commands.ZRANGE([key, start, stop, 'REV', ...options]),
    ZRANGEBYSCORE: ([key, min, max, ...options]) => zsetReply(applyLimit(zByScore(typed(key, 'zset'), min, max), options), hasFlag(options, 'WITHSCORES')),
    ZREVRANGEBYSCORE: ([key, max, min, ...options]) => zsetReply(applyLimit(zByScore(typed(key, 'zset'), min, max).reverse(), options), hasFlag(options, 'WITHSCORES')),
    ZREMRANGEBYSCORE: ([key, min, max]) => {
      const entry = typed(key, 'zset');
      const pairs = zByScore(entry, min, max);
      for (const [member] of pairs) entry.value.delete(member);
      if (pairs.length) { touch(); dropIfEmpty(key, entry); }
      return pairs.length;
    },
    ZREMRANGEBYRANK: ([key, start, stop]) => {
      const entry = typed(key, 'zset');
      if (!entry) return 0;
      const pairs = sortedZset(entry);
      const [from, to] = sliceRange(pairs.length, start, stop);
      const doomed = pairs.slice(from, to + 1);
      for (const [member] of doomed) entry.value.delete(member);
      if (doomed.length) { touch(); dropIfEmpty(key, entry); }
      return doomed.length;
    },
    ZRANDMEMBER: ([key]) => { const entry = typed(key, 'zset'); if (!entry) return null; const members = [...entry.value.keys()]; return members[Math.floor(Math.random() * members.length)] ?? null; },

    PUBLISH: () => 0,
  };

  // Lua is not available. These are the scripts the seeder runtime needs to
  // publish at all, re-expressed against the commands above.
  const compareAndDelete = ([key], [expected]) => (commands.GET([key]) === expected ? commands.DEL([key]) : 0);
  const scripts = new Map([
    [COMPARE_AND_DELETE_SCRIPT, compareAndDelete],
    [LEGACY_COMPARE_AND_DELETE_SCRIPT, compareAndDelete],
    [SEED_LOCK_RENEW_SCRIPT, ([lock], [owner, ttlMs]) => {
      const current = commands.GET([lock]);
      if (current !== owner) return [0, current ?? ''];
      commands.PEXPIRE([lock, ttlMs]);
      return [1, ''];
    }],
    [SEED_LOCK_FENCED_SET_SCRIPT, ([lock, target], [owner, ttlMs, value, ttlSeconds]) => {
      const current = commands.GET([lock]);
      if (current !== owner) return [0, current ?? ''];
      commands.PEXPIRE([lock, ttlMs]);
      commands.SET(ttlSeconds === '' ? [target, value] : [target, value, 'EX', ttlSeconds]);
      return [1, ''];
    }],
  ]);
  const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');
  const scriptsBySha = new Map([...scripts].map(([text, run]) => [sha1(text), run]));
  // @upstash/ratelimit's single-region sliding window, which guards session
  // minting and the fail-closed routes. The library sends EVALSHA with this
  // digest of its own script text, so the digest identifies the script; an
  // upgrade that changes the text changes the digest and fails loudly
  // (tests/embedded-store.test.mjs drives the real library against this).
  scriptsBySha.set(UPSTASH_SLIDING_WINDOW_SHA, ([currentKey, previousKey, dynamicLimitKey], [tokens, nowMs, windowMs, incrementRaw]) => {
    const dynamic = dynamicLimitKey ? commands.GET([dynamicLimitKey]) : null;
    const limit = Number(dynamic ?? tokens);
    const increment = Number(incrementRaw);
    const window = Number(windowMs);
    const current = Number(commands.GET([currentKey]) ?? 0);
    const previous = Math.floor((1 - (Number(nowMs) % window) / window) * Number(commands.GET([previousKey]) ?? 0));
    if (increment > 0 && previous + current >= limit) return [-1, limit];
    const next = commands.INCRBY([currentKey, String(increment)]);
    if (next === increment) commands.PEXPIRE([currentKey, String(window * 2 + 1000)]);
    return [limit - (next + previous), limit];
  });
  const runScript = (run, numKeysRaw, rest) => {
    const numKeys = toInt(numKeysRaw);
    return run(rest.slice(0, numKeys), rest.slice(numKeys));
  };
  commands.EVAL = ([script, numKeysRaw, ...rest]) => {
    const run = scriptsBySha.get(sha1(script));
    if (!run) {
      // Name the script: the caller usually logs only a failed write.
      const firstLine = script.split('\n').find((line) => line.trim())?.trim().slice(0, 80) ?? '';
      throw new Error(`ERR EVAL script is not supported by the embedded personal store (${firstLine})`);
    }
    return runScript(run, numKeysRaw, rest);
  };
  commands.EVALSHA = ([digest, numKeysRaw, ...rest]) => {
    const run = scriptsBySha.get(String(digest).toLowerCase());
    // The NOSCRIPT prefix makes callers retry with EVAL and the full text.
    if (!run) throw new Error('NOSCRIPT No matching script. Please use EVAL.');
    return runScript(run, numKeysRaw, rest);
  };

  function exec(args) {
    if (!Array.isArray(args) || typeof args[0] !== 'string' || args[0].trim() === '') {
      throw new TypeError('Malformed command: expected an array whose first element is the command name');
    }
    const name = args[0].toUpperCase();
    const run = commands[name];
    if (!run) throw new Error(`ERR unknown command '${name}' in the embedded personal store`);
    return run(args.slice(1).map(String));
  }

  // All-or-nothing: a command that throws rolls the whole batch back.
  function transaction(batch) {
    const backup = new Map([...data].map(([key, entry]) => [key, structuredClone(entry)]));
    try {
      return batch.map((args) => exec(args));
    } catch (error) {
      data.clear();
      for (const [key, entry] of backup) data.set(key, entry);
      throw error;
    }
  }

  function* dump() {
    for (const [key, entry] of data) {
      if (!live(key)) continue;
      const value = entry.type === 'string' || entry.type === 'list' ? entry.value : [...entry.value];
      yield JSON.stringify({ k: key, t: entry.type, v: value, e: entry.expiresAt });
    }
  }

  function restore(line) {
    const { k, t, v, e } = JSON.parse(line);
    if (e !== null && e <= now()) return;
    const value = t === 'hash' || t === 'zset' ? new Map(v) : t === 'set' ? new Set(v) : v;
    data.set(k, { type: t, value, expiresAt: e });
  }

  return { exec, transaction, dump, restore, version: () => version, size: () => data.size };
}

async function loadSnapshot(engine, file) {
  let stream;
  try {
    stream = createReadStream(file, 'utf8');
    await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let loaded = 0;
  for await (const line of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line) continue;
    engine.restore(line);
    loaded += 1;
  }
  return loaded;
}

async function writeSnapshot(engine, file) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const out = createWriteStream(temp, 'utf8');
  try {
    for (const line of engine.dump()) {
      if (!out.write(`${line}\n`)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => { out.once('error', reject); out.end(resolve); });
    await rename(temp, file);
  } catch (error) {
    out.destroy();
    await rm(temp, { force: true });
    throw error;
  }
}

function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error(`Request body too large: limit is ${limit} bytes`), { statusCode: 413 })); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(Object.assign(new Error('Malformed JSON body'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

/**
 * Start the store on a loopback address.
 * @param {{ token: string, file?: string, port?: number, host?: string, saveIntervalMs?: number, maxBodyBytes?: number }} options
 */
export async function startEmbeddedStore({ token, file, port = 8079, host = '127.0.0.1', saveIntervalMs = 15_000, maxBodyBytes = 16 * 1024 * 1024 }) {
  if (!/^[\x21-\x7e]{16,}$/.test(token || '')) throw new Error('The embedded store token must be at least 16 visible ASCII characters');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('The embedded store only binds to a loopback address');
  const engine = createEngine();
  const loaded = file ? await loadSnapshot(engine, file) : 0;
  const expected = crypto.createHash('sha256').update(`Bearer ${token}`).digest();
  const authorized = (req) => crypto.timingSafeEqual(crypto.createHash('sha256').update(req.headers.authorization || '').digest(), expected);
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  // Clients held by a blocking command (the scenario worker's BLMOVE), oldest
  // first. Every request that could have pushed retries them.
  /** @type {Array<{ retry: string[], resolve: (value: unknown) => void, reject: (error: unknown) => void, timer: NodeJS.Timeout | null }>} */
  let waiters = [];
  const release = (waiter) => {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiters = waiters.filter((w) => w !== waiter);
  };
  const wake = () => {
    let moved = true;
    while (moved && waiters.length) {
      moved = false;
      for (const waiter of [...waiters]) {
        let result;
        try { result = engine.exec(waiter.retry); } catch (error) { release(waiter); waiter.reject(error); continue; }
        if (result !== null) { release(waiter); waiter.resolve(result); moved = true; }
      }
    }
  };
  const execSingle = (args, res) => {
    const result = engine.exec(args);
    const name = String(args[0]).toUpperCase();
    // BLMOVE is the one blocking command (the scenario worker's dequeue). The
    // engine answers it without waiting, so a held client retries the same call.
    if (result !== null || name !== 'BLMOVE') return result;
    const timeoutMs = blockTimeoutMs(args.at(-1));
    return new Promise((resolve, reject) => {
      const waiter = { retry: args, resolve, reject, timer: null };
      if (timeoutMs > 0) waiter.timer = setTimeout(() => { release(waiter); resolve(null); }, timeoutMs);
      // A client that gave up must not receive, and so lose, the next element.
      res.once('close', () => { if (waiters.includes(waiter)) { release(waiter); resolve(null); } });
      waiters.push(waiter);
    });
  };

  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) { send(res, 401, { error: 'Unauthorized' }); return; }
    try {
      await handle(req, res);
    } finally {
      wake();
    }
  });
  const handle = async (req, res) => {
    try {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname;
      if (req.method === 'POST' && pathname === '/') { send(res, 200, { result: await execSingle(await readJsonBody(req, maxBodyBytes), res) }); return; }
      if (req.method === 'POST' && pathname === '/pipeline') {
        const batch = await readJsonBody(req, maxBodyBytes);
        send(res, 200, batch.map((args) => { try { return { result: engine.exec(args) }; } catch (error) { return { error: error.message }; } }));
        return;
      }
      if (req.method === 'POST' && pathname === '/multi-exec') {
        const results = engine.transaction(await readJsonBody(req, maxBodyBytes));
        send(res, 200, results.map((result) => ({ result })));
        return;
      }
      if (req.method === 'GET' && pathname === '/') { send(res, 200, 'Welcome to the WorldMonitor embedded store'); return; }
      if (req.method === 'GET' || req.method === 'POST') {
        req.resume();
        send(res, 200, { result: await execSingle(pathname.slice(1).split('/').map(decodeURIComponent), res) });
        return;
      }
      send(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : error instanceof TypeError || error instanceof URIError ? 400 : 500;
      if (status >= 500) console.error(`[embedded-store] ${error.message}`);
      if (!res.headersSent) send(res, status, { error: error.message });
      else res.destroy();
    }
  };

  let savedVersion = engine.version();
  let saving = null;
  const save = async () => {
    if (!file || saving || savedVersion === engine.version()) return saving;
    const target = engine.version();
    saving = writeSnapshot(engine, file)
      .then(() => { savedVersion = target; })
      .catch((error) => console.error(`[embedded-store] snapshot failed: ${error.message}`))
      .finally(() => { saving = null; });
    return saving;
  };
  const timer = setInterval(() => void save(), saveIntervalMs);
  timer.unref();

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return {
    engine,
    loaded,
    port: server.address().port,
    save,
    async close() {
      clearInterval(timer);
      // Blocked clients are disconnected below; nothing may move for them now.
      for (const waiter of waiters) if (waiter.timer) clearTimeout(waiter.timer);
      waiters = [];
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await saving;
      await save();
    },
  };
}
