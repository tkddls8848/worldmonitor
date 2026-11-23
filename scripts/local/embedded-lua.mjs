// Runs a Redis Lua script against the embedded personal store.
//
// The store re-expresses its hottest scripts natively; every other EVAL used
// to fail with "not supported", which broke each collector or handler that
// publishes through a script (physical premiums, procurement receipts, bundle
// turns, PizzINT history, forecast evidence, ...). This executes the script
// text itself on fengari (Lua 5.3 in JavaScript) with the Redis scripting API
// bound to the store's own commands. JavaScript is single-threaded and the
// script runs synchronously, so it is as atomic as a script in Redis.
//
// Redis embeds Lua 5.1. The differences these scripts can reach are bridged:
// integral numbers stay integers (so tostring(n) prints "2", not "2.0"),
// numeric command arguments are formatted the way Redis formats them, and
// unpack / table.getn / math.pow / loadstring exist as globals.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Commands whose Redis reply is a status (+OK), which scripts see as {ok=...}.
const STATUS_COMMANDS = new Set(['SET', 'TYPE', 'RENAME', 'LSET', 'LTRIM', 'MSET', 'HMSET', 'PING', 'SETEX', 'PSETEX']);

let fengari;
function loadFengari() {
  if (fengari !== undefined) return fengari;
  try {
    fengari = require('fengari');
  } catch {
    fengari = null; // a production-only install omits it; EVAL then fails as before
  }
  return fengari;
}

export function luaAvailable() {
  return loadFengari() !== null;
}

// Runs `script` with KEYS/ARGV and returns the reply as the Upstash REST layer
// would see it. `exec(args)` runs one store command and may throw.
export function runLuaScript(script, keys, argv, exec) {
  const f = loadFengari();
  if (!f) throw new Error('ERR EVAL needs the fengari package (npm install) in the embedded personal store');
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = f;
  const NULL = {}; // cjson.null sentinel (light userdata)
  const L = lauxlib.luaL_newstate();

  const str = (value) => to_luastring(String(value));
  const jsString = (index) => to_jsstring(lua.lua_tolstring(L, index));

  // fengari integers are 32-bit. Larger values (millisecond timestamps) stay
  // floats, which is what every number is in Redis's Lua 5.1 anyway.
  function pushNumber(value) {
    if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) lua.lua_pushinteger(L, value);
    else lua.lua_pushnumber(L, value);
  }

  // A store reply as redis.call returns it to Lua.
  function pushReply(value, status = false) {
    if (value === null || value === undefined) lua.lua_pushboolean(L, false);
    else if (typeof value === 'number') pushNumber(value);
    else if (typeof value === 'boolean') value ? lua.lua_pushinteger(L, 1) : lua.lua_pushboolean(L, false);
    else if (Array.isArray(value)) {
      lua.lua_createtable(L, value.length, 0);
      value.forEach((item, i) => { pushReply(item); lua.lua_rawseti(L, -2, i + 1); });
    } else if (status) {
      lua.lua_createtable(L, 0, 1);
      lua.lua_pushstring(L, str(value));
      lua.lua_setfield(L, -2, str('ok'));
    } else lua.lua_pushstring(L, str(value));
  }

  // A decoded JSON value as cjson.decode returns it.
  function pushJson(value) {
    if (value === null) lua.lua_pushlightuserdata(L, NULL);
    else if (typeof value === 'number') pushNumber(value);
    else if (typeof value === 'boolean') lua.lua_pushboolean(L, value);
    else if (typeof value === 'string') lua.lua_pushstring(L, str(value));
    else if (Array.isArray(value)) {
      lua.lua_createtable(L, value.length, 0);
      value.forEach((item, i) => { pushJson(item); lua.lua_rawseti(L, -2, i + 1); });
    } else {
      const entries = Object.entries(value);
      lua.lua_createtable(L, 0, entries.length);
      for (const [key, item] of entries) { pushJson(item); lua.lua_setfield(L, -2, str(key)); }
    }
  }

  // The table at `index` as a sequence (1..n, nothing else), or null.
  function sequenceLength(index) {
    let count = 0;
    let max = 0;
    let sequence = true;
    lua.lua_pushnil(L);
    while (lua.lua_next(L, index) !== 0) {
      count += 1;
      if (lua.lua_type(L, -2) === lua.LUA_TNUMBER && lua.lua_isinteger(L, -2)) {
        const n = lua.lua_tointeger(L, -2);
        if (n >= 1) max = Math.max(max, n); else sequence = false;
      } else sequence = false;
      lua.lua_pop(L, 1);
    }
    return sequence && count > 0 && max === count ? count : null;
  }

  // The Lua value at `index` as JSON for cjson.encode.
  function toJson(index, depth = 0) {
    if (depth > 64) throw new Error('Cannot serialise, excessive nesting');
    const abs = lua.lua_absindex(L, index);
    switch (lua.lua_type(L, abs)) {
      case lua.LUA_TNIL: return null;
      case lua.LUA_TBOOLEAN: return lua.lua_toboolean(L, abs);
      case lua.LUA_TNUMBER: return lua.lua_isinteger(L, abs) ? lua.lua_tointeger(L, abs) : lua.lua_tonumber(L, abs);
      case lua.LUA_TSTRING: return jsString(abs);
      case lua.LUA_TLIGHTUSERDATA: return null;
      case lua.LUA_TTABLE: {
        const length = sequenceLength(abs);
        if (length !== null) {
          const out = [];
          for (let i = 1; i <= length; i += 1) { lua.lua_rawgeti(L, abs, i); out.push(toJson(-1, depth + 1)); lua.lua_pop(L, 1); }
          return out;
        }
        const out = {};
        lua.lua_pushnil(L);
        while (lua.lua_next(L, abs) !== 0) {
          const keyType = lua.lua_type(L, -2);
          if (keyType !== lua.LUA_TSTRING && keyType !== lua.LUA_TNUMBER) throw new Error('Cannot serialise table key');
          lua.lua_pushvalue(L, -2); // tolstring on a numeric key would change it in place
          const key = jsString(-1);
          lua.lua_pop(L, 1);
          out[key] = toJson(-1, depth + 1);
          lua.lua_pop(L, 1);
        }
        return out;
      }
      default: throw new Error(`Cannot serialise ${to_jsstring(lua.lua_typename(L, lua.lua_type(L, abs)))}`);
    }
  }

  // The script's return value as a Redis reply.
  function toReply(index) {
    const abs = lua.lua_absindex(L, index);
    switch (lua.lua_type(L, abs)) {
      case lua.LUA_TNUMBER: return Math.trunc(lua.lua_tonumber(L, abs));
      case lua.LUA_TSTRING: return jsString(abs);
      case lua.LUA_TBOOLEAN: return lua.lua_toboolean(L, abs) ? 1 : null;
      case lua.LUA_TTABLE: {
        lua.lua_getfield(L, abs, str('err'));
        if (lua.lua_type(L, -1) === lua.LUA_TSTRING) throw new Error(jsString(-1));
        lua.lua_pop(L, 1);
        lua.lua_getfield(L, abs, str('ok'));
        if (lua.lua_type(L, -1) === lua.LUA_TSTRING) return jsString(-1);
        lua.lua_pop(L, 1);
        const out = [];
        for (let i = 1; ; i += 1) {
          lua.lua_rawgeti(L, abs, i);
          if (lua.lua_type(L, -1) === lua.LUA_TNIL) { lua.lua_pop(L, 1); break; }
          out.push(toReply(-1));
          lua.lua_pop(L, 1);
        }
        return out;
      }
      default: return null;
    }
  }

  // Arguments of redis.call, formatted as Redis would send them.
  function commandArgs() {
    const top = lua.lua_gettop(L);
    if (top === 0) return { error: 'Please specify at least one argument for redis.call()' };
    const args = [];
    for (let i = 1; i <= top; i += 1) {
      const type = lua.lua_type(L, i);
      if (type === lua.LUA_TSTRING) args.push(jsString(i));
      else if (type === lua.LUA_TNUMBER) args.push(lua.lua_isinteger(L, i) ? String(lua.lua_tointeger(L, i)) : String(lua.lua_tonumber(L, i)));
      else return { error: 'Lua redis() command arguments must be strings or integers' };
    }
    return { args };
  }

  function redisCall(protectedCall) {
    return () => {
      const { args, error: argError } = commandArgs();
      let reply;
      let error = argError;
      if (!error) {
        try { reply = exec(args); } catch (caught) { error = caught?.message ?? String(caught); }
      }
      if (error) {
        if (!protectedCall) return lauxlib.luaL_error(L, str(error));
        lua.lua_createtable(L, 0, 1);
        lua.lua_pushstring(L, str(error));
        lua.lua_setfield(L, -2, str('err'));
        return 1;
      }
      pushReply(reply, STATUS_COMMANDS.has(args[0].toUpperCase()) && typeof reply === 'string');
      return 1;
    };
  }

  const fn = (table, name, impl) => { lua.lua_pushjsfunction(L, impl); lua.lua_setfield(L, table, str(name)); };
  const replyTable = (field) => () => {
    lua.lua_createtable(L, 0, 1);
    lua.lua_pushstring(L, str(jsString(1)));
    lua.lua_setfield(L, -2, str(field));
    return 1;
  };

  try {
    lualib.luaL_openlibs(L);

    lua.lua_createtable(L, 0, 6);
    const redisTable = lua.lua_gettop(L);
    fn(redisTable, 'call', redisCall(false));
    fn(redisTable, 'pcall', redisCall(true));
    fn(redisTable, 'error_reply', replyTable('err'));
    fn(redisTable, 'status_reply', replyTable('ok'));
    fn(redisTable, 'log', () => 0);
    for (const [name, value] of [['LOG_DEBUG', 0], ['LOG_VERBOSE', 1], ['LOG_NOTICE', 2], ['LOG_WARNING', 3]]) {
      lua.lua_pushinteger(L, value); lua.lua_setfield(L, redisTable, str(name));
    }
    lua.lua_setglobal(L, str('redis'));

    lua.lua_createtable(L, 0, 3);
    const cjsonTable = lua.lua_gettop(L);
    fn(cjsonTable, 'decode', () => {
      const text = lua.lua_type(L, 1) === lua.LUA_TSTRING ? jsString(1) : null;
      let value;
      let error = null;
      try { value = JSON.parse(text ?? ''); } catch (caught) { error = `Expected value but found invalid token: ${caught.message}`; }
      if (error) return lauxlib.luaL_error(L, str(error));
      pushJson(value);
      return 1;
    });
    fn(cjsonTable, 'encode', () => {
      let text;
      let error = null;
      try { text = JSON.stringify(toJson(1)); } catch (caught) { error = caught.message; }
      if (error) return lauxlib.luaL_error(L, str(error));
      lua.lua_pushstring(L, str(text));
      return 1;
    });
    lua.lua_pushlightuserdata(L, NULL);
    lua.lua_setfield(L, cjsonTable, str('null'));
    lua.lua_setglobal(L, str('cjson'));

    for (const [name, values] of [['KEYS', keys], ['ARGV', argv]]) {
      lua.lua_createtable(L, values.length, 0);
      values.forEach((value, i) => { lua.lua_pushstring(L, str(value)); lua.lua_rawseti(L, -2, i + 1); });
      lua.lua_setglobal(L, str(name));
    }

    const compat = 'unpack = table.unpack; table.getn = function(t) return #t end; '
      + 'math.pow = function(a, b) return a ^ b end; loadstring = load';
    if (lauxlib.luaL_dostring(L, str(compat)) !== lua.LUA_OK) throw new Error('ERR Lua compatibility shim failed');

    if (lauxlib.luaL_loadstring(L, str(script)) !== lua.LUA_OK) {
      throw new Error(`ERR Error compiling script: ${jsString(-1)}`);
    }
    if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
      const message = lua.lua_type(L, -1) === lua.LUA_TTABLE ? toReplyError(-1) : jsString(-1);
      throw new Error(message.startsWith('ERR') || /^[A-Z_]+ /.test(message) ? message : `ERR Error running script: ${message}`);
    }
    return toReply(-1);
  } finally {
    lua.lua_close(L);
  }

  // error({err = ...}) inside a script raises a table.
  function toReplyError(index) {
    lua.lua_getfield(L, index, str('err'));
    const message = lua.lua_type(L, -1) === lua.LUA_TSTRING ? jsString(-1) : 'script error';
    lua.lua_pop(L, 1);
    return message;
  }
}
