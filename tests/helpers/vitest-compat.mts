/**
 * A small `expect`/`vi` surface on top of node:test and node:assert, so the
 * server suites that used to run under the removed root vitest config run in
 * the ordinary `tsx --test` unit profile. It covers only what those suites use.
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const ASYMMETRIC = Symbol('asymmetric');

interface Asymmetric {
  [ASYMMETRIC]: true;
  matches(actual: unknown): boolean;
  toString(): string;
}

function asymmetric(name: string, matches: (actual: unknown) => boolean): Asymmetric {
  return { [ASYMMETRIC]: true, matches, toString: () => name };
}

function isAsymmetric(value: unknown): value is Asymmetric {
  return typeof value === 'object' && value !== null && (value as Asymmetric)[ASYMMETRIC] === true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** vitest `toEqual`: recursive, ignores own properties whose value is undefined. */
function equals(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected.matches(actual);
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== 'object' || typeof expected !== 'object' || actual === null || expected === null) return false;
  if (actual instanceof Date && expected instanceof Date) return actual.getTime() === expected.getTime();
  if (actual instanceof RegExp && expected instanceof RegExp) return String(actual) === String(expected);
  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((item, i) => equals(item, expected[i]));
  }
  if (actual instanceof Map && expected instanceof Map) {
    if (actual.size !== expected.size) return false;
    for (const [key, value] of expected) if (!actual.has(key) || !equals(actual.get(key), value)) return false;
    return true;
  }
  if (actual instanceof Set && expected instanceof Set) {
    if (actual.size !== expected.size) return false;
    for (const value of expected) if (!actual.has(value)) return false;
    return true;
  }
  if (!Array.isArray(actual) && (!isPlainObject(actual) || !isPlainObject(expected))) {
    // Only Date, RegExp, Map and Set have class-aware comparison here. Any other
    // class instance would be compared by its own enumerable keys and could pass
    // spuriously, so refuse instead of guessing.
    throw new TypeError(
      `vitest-compat equals() cannot compare class instances (${Object.prototype.toString.call(actual)} vs ${Object.prototype.toString.call(expected)})`,
    );
  }
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
  for (const key of keys) {
    if (a[key] === undefined && e[key] === undefined) continue;
    if (!equals(a[key], e[key])) return false;
  }
  return true;
}

/** vitest `toMatchObject`: every expected property matches; arrays match element-wise. */
function matchesObject(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected.matches(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length
      && expected.every((item, i) => matchesObject(actual[i], item));
  }
  if (isPlainObject(expected)) {
    if (typeof actual !== 'object' || actual === null) return false;
    const a = actual as Record<string, unknown>;
    return Object.keys(expected).every((key) => key in a && matchesObject(a[key], expected[key]));
  }
  return equals(actual, expected);
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (isAsymmetric(v) ? v.toString() : v), 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function isMockFn(value: unknown): value is MockFn {
  return typeof value === 'function' && Array.isArray((value as MockFn).mock?.calls);
}

function throwsMatching(error: unknown, expected?: unknown): boolean {
  if (expected === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof expected === 'string') return message.includes(expected);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === 'function') return error instanceof (expected as new (...a: unknown[]) => unknown);
  if (isPlainObject(expected)) return matchesObject(error, expected);
  return false;
}

type Matchers = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toStrictEqual(expected: unknown): void;
  toMatchObject(expected: unknown): void;
  toHaveLength(length: number): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toContain(item: unknown): void;
  toMatch(pattern: RegExp | string): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toHaveProperty(key: string, value?: unknown): void;
  toBeInstanceOf(ctor: abstract new (...args: never[]) => unknown): void;
  toThrow(expected?: unknown): void;
  toHaveBeenCalled(): void;
  toHaveBeenCalledTimes(n: number): void;
  toHaveBeenCalledWith(...args: unknown[]): void;
};

function makeMatchers(actual: unknown, negate: boolean): Matchers {
  const check = (pass: boolean, message: () => string) => {
    if (pass === negate) assert.fail(`${negate ? 'not ' : ''}${message()}`);
  };
  const calls = () => {
    if (!isMockFn(actual)) assert.fail('expected a mock function');
    return actual.mock.calls;
  };
  return {
    toBe: (expected) => check(Object.is(actual, expected), () => `expected ${describeValue(actual)} to be ${describeValue(expected)}`),
    toEqual: (expected) => check(equals(actual, expected), () => `expected ${describeValue(actual)} to equal ${describeValue(expected)}`),
    toStrictEqual: (expected) => {
      let pass = true;
      try {
        assert.deepStrictEqual(actual, expected);
      } catch {
        pass = false;
      }
      check(pass, () => `expected ${describeValue(actual)} to strictly equal ${describeValue(expected)}`);
    },
    toMatchObject: (expected) => check(matchesObject(actual, expected), () => `expected ${describeValue(actual)} to match ${describeValue(expected)}`),
    toHaveLength: (length) => check((actual as { length?: number })?.length === length, () => `expected length ${(actual as { length?: number })?.length} to be ${length}`),
    toBeNull: () => check(actual === null, () => `expected ${describeValue(actual)} to be null`),
    toBeUndefined: () => check(actual === undefined, () => `expected ${describeValue(actual)} to be undefined`),
    toBeDefined: () => check(actual !== undefined, () => 'expected a defined value'),
    toBeTruthy: () => check(Boolean(actual), () => `expected ${describeValue(actual)} to be truthy`),
    toBeFalsy: () => check(!actual, () => `expected ${describeValue(actual)} to be falsy`),
    toContain: (item) => check(
      typeof actual === 'string' ? actual.includes(String(item)) : Array.isArray(actual) && actual.includes(item),
      () => `expected ${describeValue(actual)} to contain ${describeValue(item)}`,
    ),
    toMatch: (pattern) => check(
      typeof actual === 'string' && (typeof pattern === 'string' ? actual.includes(pattern) : pattern.test(actual)),
      () => `expected ${describeValue(actual)} to match ${String(pattern)}`,
    ),
    toBeGreaterThan: (n) => check((actual as number) > n, () => `expected ${actual} > ${n}`),
    toBeGreaterThanOrEqual: (n) => check((actual as number) >= n, () => `expected ${actual} >= ${n}`),
    toBeLessThan: (n) => check((actual as number) < n, () => `expected ${actual} < ${n}`),
    toBeLessThanOrEqual: (n) => check((actual as number) <= n, () => `expected ${actual} <= ${n}`),
    toHaveProperty: (key, ...rest) => {
      const has = typeof actual === 'object' && actual !== null && key in (actual as object);
      const pass = rest.length === 0 ? has : has && equals((actual as Record<string, unknown>)[key], rest[0]);
      check(pass, () => `expected ${describeValue(actual)} to have property ${key}`);
    },
    toBeInstanceOf: (ctor) => check(actual instanceof (ctor as new (...a: unknown[]) => unknown), () => `expected instance of ${ctor.name}`),
    toThrow: (expected) => {
      let threw = false;
      let error: unknown;
      try {
        (actual as () => unknown)();
      } catch (err) {
        threw = true;
        error = err;
      }
      check(threw && throwsMatching(error, expected), () => `expected function to throw ${expected === undefined ? '' : String(expected)}`);
    },
    toHaveBeenCalled: () => check(calls().length > 0, () => 'expected mock to have been called'),
    toHaveBeenCalledTimes: (n) => check(calls().length === n, () => `expected ${n} calls, got ${calls().length}`),
    toHaveBeenCalledWith: (...args) => check(
      calls().some((call) => equals(call, args)),
      () => `expected a call with ${describeValue(args)}; calls were ${describeValue(calls())}`,
    ),
  };
}

type PromiseMatchers = { [K in keyof Matchers]: (...args: Parameters<Matchers[K]>) => Promise<void> };

function promiseMatchers(actual: unknown, mode: 'resolves' | 'rejects'): PromiseMatchers {
  return new Proxy({} as PromiseMatchers, {
    get: (_target, name: string) => async (...args: unknown[]) => {
      let value: unknown;
      if (mode === 'resolves') {
        value = await (actual as Promise<unknown>);
      } else {
        try {
          await (actual as Promise<unknown>);
        } catch (error) {
          value = error;
          if (name === 'toThrow') {
            if (!throwsMatching(error, args[0])) assert.fail(`expected rejection matching ${String(args[0])}, got ${String(error)}`);
            return;
          }
          (makeMatchers(value, false) as Record<string, (...a: unknown[]) => void>)[name]!(...args);
          return;
        }
        assert.fail('expected promise to reject');
      }
      (makeMatchers(value, false) as Record<string, (...a: unknown[]) => void>)[name]!(...args);
    },
  });
}

type Expectation = Matchers & { not: Matchers; resolves: PromiseMatchers; rejects: PromiseMatchers };

export function expect(actual: unknown): Expectation {
  return Object.assign(makeMatchers(actual, false), {
    not: makeMatchers(actual, true),
    resolves: promiseMatchers(actual, 'resolves'),
    rejects: promiseMatchers(actual, 'rejects'),
  });
}

expect.any = (ctor: unknown) => asymmetric(`Any<${(ctor as { name?: string }).name}>`, (actual) => {
  if (ctor === String) return typeof actual === 'string' || actual instanceof String;
  if (ctor === Number) return typeof actual === 'number' || actual instanceof Number;
  if (ctor === Boolean) return typeof actual === 'boolean';
  if (ctor === Function) return typeof actual === 'function';
  if (ctor === Object) return typeof actual === 'object' && actual !== null;
  return actual instanceof (ctor as new (...a: unknown[]) => unknown);
});
expect.objectContaining = (expected: Record<string, unknown>) =>
  asymmetric('ObjectContaining', (actual) => matchesObject(actual, expected));
expect.stringContaining = (expected: string) =>
  asymmetric('StringContaining', (actual) => typeof actual === 'string' && actual.includes(expected));

// ---------------------------------------------------------------------------
// vi
// ---------------------------------------------------------------------------

type AnyFn = (...args: any[]) => any;

export interface MockFn<T extends AnyFn = AnyFn> {
  (...args: Parameters<T>): ReturnType<T>;
  mock: { calls: Parameters<T>[]; results: Array<{ type: 'return' | 'throw'; value: unknown }> };
  mockImplementation(impl: T): MockFn<T>;
  mockImplementationOnce(impl: T): MockFn<T>;
  mockReturnValue(value: ReturnType<T>): MockFn<T>;
  mockReturnValueOnce(value: ReturnType<T>): MockFn<T>;
  mockResolvedValue(value: Awaited<ReturnType<T>>): MockFn<T>;
  mockResolvedValueOnce(value: Awaited<ReturnType<T>>): MockFn<T>;
  mockRejectedValue(value: unknown): MockFn<T>;
  mockRejectedValueOnce(value: unknown): MockFn<T>;
  mockClear(): MockFn<T>;
  mockReset(): MockFn<T>;
  mockRestore(): void;
}

const allMocks = new Set<MockFn>();
const restorers = new Map<MockFn, () => void>();

function fn<T extends AnyFn = AnyFn>(impl?: T): MockFn<T> {
  let base: AnyFn | undefined = impl;
  const once: AnyFn[] = [];
  const mockFn = function (this: unknown, ...args: unknown[]) {
    mockFn.mock.calls.push(args as Parameters<T>);
    const current = once.length > 0 ? once.shift() : base;
    try {
      const value = current ? current.apply(this, args) : undefined;
      mockFn.mock.results.push({ type: 'return', value });
      return value;
    } catch (error) {
      mockFn.mock.results.push({ type: 'throw', value: error });
      throw error;
    }
  } as unknown as MockFn<T>;
  mockFn.mock = { calls: [], results: [] };
  mockFn.mockImplementation = (next) => { base = next; return mockFn; };
  mockFn.mockImplementationOnce = (next) => { once.push(next); return mockFn; };
  mockFn.mockReturnValue = (value) => { base = () => value; return mockFn; };
  mockFn.mockReturnValueOnce = (value) => { once.push(() => value); return mockFn; };
  mockFn.mockResolvedValue = (value) => { base = () => Promise.resolve(value); return mockFn; };
  mockFn.mockResolvedValueOnce = (value) => { once.push(() => Promise.resolve(value)); return mockFn; };
  mockFn.mockRejectedValue = (value) => { base = () => Promise.reject(value); return mockFn; };
  mockFn.mockRejectedValueOnce = (value) => { once.push(() => Promise.reject(value)); return mockFn; };
  mockFn.mockClear = () => { mockFn.mock.calls.length = 0; mockFn.mock.results.length = 0; return mockFn; };
  mockFn.mockReset = () => { mockFn.mockClear(); once.length = 0; base = undefined; return mockFn; };
  mockFn.mockRestore = () => { mockFn.mockReset(); restorers.get(mockFn as MockFn)?.(); restorers.delete(mockFn as MockFn); };
  allMocks.add(mockFn as MockFn);
  return mockFn;
}

function spyOn<O extends object, K extends keyof O>(object: O, method: K): MockFn {
  const original = object[method] as unknown as AnyFn;
  const spy = fn((...args: unknown[]) => original.apply(object, args));
  Object.defineProperty(object, method, { configurable: true, writable: true, value: spy });
  restorers.set(spy, () => {
    Object.defineProperty(object, method, { configurable: true, writable: true, value: original });
  });
  return spy;
}

const stubbedEnv = new Map<string, string | undefined>();
const stubbedGlobals = new Map<string, PropertyDescriptor | undefined>();
let fakeTimersOn = false;

export const vi = {
  fn,
  spyOn,
  mocked: <T>(value: T) => value as T & MockFn,
  hoisted: <T>(factory: () => T): T => factory(),
  clearAllMocks: () => { for (const m of allMocks) m.mockClear(); },
  resetAllMocks: () => { for (const m of allMocks) m.mockReset(); },
  restoreAllMocks: () => {
    for (const [spy, restore] of restorers) { restore(); allMocks.delete(spy); }
    restorers.clear();
  },
  stubEnv: (name: string, value: string | undefined) => {
    if (!stubbedEnv.has(name)) stubbedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  },
  unstubAllEnvs: () => {
    for (const [name, value] of stubbedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    stubbedEnv.clear();
  },
  stubGlobal: (name: string, value: unknown) => {
    if (!stubbedGlobals.has(name)) stubbedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  },
  unstubAllGlobals: () => {
    for (const [name, descriptor] of stubbedGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    stubbedGlobals.clear();
  },
  /** Fakes the clock only (Date). Real timers keep running so awaited work still settles. */
  useFakeTimers: () => {
    if (fakeTimersOn) mock.timers.reset();
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    fakeTimersOn = true;
  },
  setSystemTime: (time: number | Date) => {
    const ms = typeof time === 'number' ? time : time.getTime();
    if (!fakeTimersOn) {
      mock.timers.enable({ apis: ['Date'], now: ms });
      fakeTimersOn = true;
    } else {
      mock.timers.setTime(ms);
    }
  },
  useRealTimers: () => {
    if (fakeTimersOn) mock.timers.reset();
    fakeTimersOn = false;
  },
};

/** `test.each(values)(title, fn)`: one node:test case per value, `%s` replaced by the value. */
export function eachTest<T>(values: readonly T[]) {
  return (title: string, fn: (value: T) => unknown) => {
    for (const value of values) test(title.replace('%s', String(value)), () => fn(value));
  };
}

/** `it.each(rows)(title, fn)` with array rows spread into `fn`; `%s`/`%i` take the row values in order. */
export function eachIt<T extends readonly unknown[]>(rows: readonly T[]) {
  return (title: string, fn: (...args: T) => unknown) => {
    for (const row of rows) {
      let i = 0;
      const name = title.replace(/%[sid]/g, () => String(row[i++]));
      test(name, () => fn(...row));
    }
  };
}
