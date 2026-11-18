/**
 * Direct-account handoff coverage for the shared Convex client.
 *
 * The entitlement and billing watches are user-scoped on the server even
 * though their query args are empty. They therefore must not attach until the
 * singleton WebSocket has confirmed the newly selected Clerk identity.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, it } from 'node:test';

import {
  __setConvexAuthTimersForTests,
  __setConvexClientFactoryForTests,
  __setConvexClientForTests,
  getConvexClient,
  invalidateConvexAuthForSignOut,
  rebindConvexAuthForWatchHandoff,
  waitForConvexAuth,
  waitForConvexAuthForUser,
} from '../src/services/convex-client.ts';
import { assertAccountStillCurrent, settleAccountOperation } from '../src/services/account-operation.ts';
import {
  __setClerkInstanceForTests,
  getClerkToken,
  getCurrentClerkUser,
} from '../src/services/clerk.ts';
import { startAccountAuthHandoff } from '../src/app/account-auth-handoff.ts';
import { getConvexApi } from '../src/services/convex-client.ts';

/**
 * A signed-in Convex mutation with the same account guards every account
 * write uses: the probe the same-user recovery cases drive. (The billing
 * call they used to drive is retired.)
 */
async function accountMutationProbe(): Promise<unknown> {
  const userId = getCurrentClerkUser()?.id;
  if (!userId) throw new Error('Sign in to run the probe.');
  const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
  if (!client || !api) throw new Error('Convex unavailable');
  if (!await waitForConvexAuthForUser(userId)) {
    assertAccountStillCurrent(userId, 'running the probe');
    throw new Error('Authentication unavailable while running the probe. Try again.');
  }
  assertAccountStillCurrent(userId, 'running the probe');
  const result = await settleAccountOperation(userId, 'running the probe', () => client.mutation(
    (api as never as { probe: unknown }).probe as never,
    {},
  )) as { status: unknown };
  assertAccountStillCurrent(userId, 'running the probe');
  return result.status;
}

type TokenFetcher = (args?: { forceRefreshToken?: boolean }) => Promise<string | null>;
type AuthCallback = (isAuthenticated: boolean) => void;

class FakeConvexClient {
  readonly authConfigs: Array<{
    fetchToken: TokenFetcher;
    onChange: AuthCallback;
  }> = [];
  readonly watchAttachments: unknown[] = [];
  readonly mutations: unknown[][] = [];
  readonly queries: unknown[][] = [];
  readonly actions: unknown[][] = [];
  mutationResult: Promise<unknown> | null = null;
  queryResult: Promise<unknown> | null = null;
  actionResult: Promise<unknown> | null = null;

  setAuth(fetchToken: TokenFetcher, onChange: AuthCallback): void {
    this.authConfigs.push({ fetchToken, onChange });
  }

  onUpdate(...args: unknown[]): (() => void) & { unsubscribe: () => void } {
    this.watchAttachments.push(args);
    const unsubscribe = () => {};
    return Object.assign(unsubscribe, { unsubscribe });
  }

  mutation(...args: unknown[]): Promise<unknown> {
    this.mutations.push(args);
    if (this.mutationResult) return this.mutationResult;
    const input = args[1] as { name?: string; keyPrefix?: string } | undefined;
    return Promise.resolve({
      id: 'key_1',
      name: input?.name ?? '',
      keyPrefix: input?.keyPrefix ?? '',
    });
  }

  query(...args: unknown[]): Promise<unknown> {
    this.queries.push(args);
    return this.queryResult ?? Promise.resolve([]);
  }

  action(...args: unknown[]): Promise<unknown> {
    this.actions.push(args);
    return this.actionResult ?? Promise.resolve({});
  }
}

const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitForCondition(
  condition: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() >= deadline) {
      assert.fail(message);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

async function waitForCalls(calls: unknown[][], expected: number): Promise<void> {
  await waitForCondition(
    () => calls.length >= expected,
    `expected ${expected} call(s), received ${calls.length}`,
  );
  assert.equal(calls.length, expected);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolvePromise: (value: T) => void = () => {};
  let rejectPromise: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/**
 * Manual scheduler for convex-client's auth timers (#5841). The bounded auth
 * wait and the transient-rebind retry delay fire ONLY when a test fires them,
 * so these paths are driven deterministically instead of by elapsed wall time
 * — the two timing-shaped cases below used to red the merge-blocking `unit`
 * job whenever CI scheduling latency starved a real 1 ms retry hop, a real
 * 5 ms bounded wait, or the 1 s polling deadline that watched them.
 */
function installManualAuthTimers(): {
  pending: () => Array<{ ms: number }>;
  fireNext: () => void;
} {
  type ManualTimer = { fn: () => void; ms: number; cancelled: boolean; fired: boolean };
  const timers: ManualTimer[] = [];
  __setConvexAuthTimersForTests({
    setTimeout: (fn, ms) => {
      const timer: ManualTimer = { fn, ms, cancelled: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (id) => {
      const timer = id as ManualTimer | null;
      if (timer) timer.cancelled = true;
    },
  });
  return {
    pending: () => timers.filter((t) => !t.cancelled && !t.fired).map((t) => ({ ms: t.ms })),
    fireNext: () => {
      const timer = timers.find((t) => !t.cancelled && !t.fired);
      assert.ok(timer, 'expected a live auth timer to fire');
      timer.fired = true;
      timer.fn();
    },
  };
}

function installFakeClient(): FakeConvexClient {
  const fake = new FakeConvexClient();
  __setConvexClientForTests(fake);
  assert.equal(fake.authConfigs.length, 1, 'test install should model the initial A auth binding');
  return fake;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  __setConvexClientFactoryForTests(null);
  __setConvexClientForTests(null);
  __setClerkInstanceForTests(null);
  __setConvexAuthTimersForTests(null);
});

describe('generation-scoped Convex auth handoff', () => {
  it('does not let A readiness satisfy B and attaches B watches only after B server confirmation', async () => {
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(true);
    assert.equal(await waitForConvexAuth(50), true, 'A starts from an already-confirmed socket');

    const attached: string[] = [];
    const handoff = rebindConvexAuthForWatchHandoff(
      () => true,
      () => attached.push('B'),
      1_000,
      [],
    );
    await flushMicrotasks();

    assert.equal(fake.authConfigs.length, 2, 'B must install a fresh Convex auth config');
    assert.deepEqual(attached, [], 'A readiness must not attach B watches');

    // Even a late callback from A cannot resolve B's generation.
    fake.authConfigs[0].onChange(true);
    await flushMicrotasks();
    assert.deepEqual(attached, [], 'an old auth callback must not resolve the B barrier');

    fake.authConfigs[1].onChange(true);
    assert.equal(await handoff, true);
    assert.deepEqual(attached, ['B'], 'B watches attach after B is confirmed by the server');
  });

  it('supersedes an overlapping B rebind so only current C can attach watches', async () => {
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(true);

    let currentUserId = 'B';
    const attached: string[] = [];
    const handoffB = rebindConvexAuthForWatchHandoff(
      () => currentUserId === 'B',
      () => attached.push('B'),
      1_000,
    );
    await flushMicrotasks();
    assert.equal(fake.authConfigs.length, 2);

    currentUserId = 'C';
    const handoffC = rebindConvexAuthForWatchHandoff(
      () => currentUserId === 'C',
      () => attached.push('C'),
      1_000,
    );
    await flushMicrotasks();
    assert.equal(fake.authConfigs.length, 3);

    // B's server response arrives after C became current. Its callback belongs
    // to a superseded auth generation and must be inert.
    fake.authConfigs[1].onChange(true);
    assert.equal(await handoffB, false);
    assert.deepEqual(attached, []);

    fake.authConfigs[2].onChange(true);
    assert.equal(await handoffC, true);
    assert.deepEqual(attached, ['C']);
  });

  it('does not attach watches when app teardown precedes delayed auth confirmation', async () => {
    const fake = installFakeClient();
    const appState = { isDestroyed: false };
    const attached: string[] = [];
    const handoff = rebindConvexAuthForWatchHandoff(
      () => !appState.isDestroyed,
      () => attached.push('watch'),
      1_000,
      [],
    );
    await flushMicrotasks();
    assert.equal(fake.authConfigs.length, 2);
    appState.isDestroyed = true;
    fake.authConfigs[1].onChange(true);
    assert.equal(await handoff, false);
    assert.deepEqual(attached, []);
    assert.deepEqual(fake.watchAttachments, []);
  });

  it('treats a same-config true then false callback as unauthenticated', async () => {
    const fake = installFakeClient();
    const attached: string[] = [];
    const handoff = rebindConvexAuthForWatchHandoff(
      () => true,
      () => attached.push('B'),
      1_000,
      [],
    );
    await flushMicrotasks();

    fake.authConfigs[1].onChange(true);
    fake.authConfigs[1].onChange(false);

    assert.equal(await handoff, false);
    assert.deepEqual(attached, []);
    assert.equal(await waitForConvexAuth(10), false);
  });

  it('fails closed on terminal auth failure while the identity remains current', async () => {
    const fake = installFakeClient();
    const attached: string[] = [];
    const handoff = rebindConvexAuthForWatchHandoff(
      () => true,
      () => attached.push('B'),
      1_000,
      [],
    );
    await flushMicrotasks();

    fake.authConfigs[1].onChange(false);

    assert.equal(await handoff, false);
    assert.deepEqual(attached, []);
  });

  it('retries a transient terminal token failure for the current identity', async () => {
    const fake = installFakeClient();
    const timers = installManualAuthTimers();
    const attached: string[] = [];
    let current = true;
    const handoff = rebindConvexAuthForWatchHandoff(
      () => current,
      () => attached.push('B'),
      1_000,
      [1],
    );
    try {
      await flushMicrotasks();

      fake.authConfigs[1].onChange(false);
      await flushMicrotasks();

      // The terminal failure settles the barrier, so the bounded wait resolves
      // without its timeout; what remains live is exactly the retry delay.
      assert.deepEqual(timers.pending(), [{ ms: 1 }], 'one live retry-delay timer');
      timers.fireNext();
      await flushMicrotasks();

      assert.equal(fake.authConfigs.length, 3, 'current B installs one bounded retry config');
      fake.authConfigs[2].onChange(true);
      assert.equal(await handoff, true);
      assert.deepEqual(attached, ['B']);
    } finally {
      current = false;
      __setConvexClientForTests(null);
      await handoff;
    }
  });

  it('recovers current-user watches after a bounded wait times out', async () => {
    const fake = installFakeClient();
    const timers = installManualAuthTimers();
    const attached: string[] = [];
    const handoff = rebindConvexAuthForWatchHandoff(
      () => true,
      () => attached.push('B'),
      5,
      [],
    );
    await flushMicrotasks();

    // The bounded wait expires only when the TEST fires it — never by
    // elapsed wall time.
    assert.deepEqual(timers.pending(), [{ ms: 5 }], 'one live bounded-wait timer');
    timers.fireNext();

    assert.equal(await handoff, false);
    assert.deepEqual(attached, []);

    fake.authConfigs[1].onChange(true);
    await flushMicrotasks();
    assert.deepEqual(attached, ['B']);
  });

  it('does not attach after auth succeeds for an identity that signed out', async () => {
    const fake = installFakeClient();
    let current = true;
    const attached: string[] = [];
    const handoff = rebindConvexAuthForWatchHandoff(
      () => current,
      () => attached.push('B'),
      1_000,
    );
    await flushMicrotasks();

    current = false;
    fake.authConfigs[1].onChange(true);

    assert.equal(await handoff, false);
    assert.deepEqual(attached, []);
  });

  it('invalidates the old token before, but not during, the new token fetch', async () => {
    const fake = installFakeClient();
    const token = deferred<string | null>();
    let tokenFetches = 0;
    __setClerkInstanceForTests({
      session: {
        getToken: async () => {
          tokenFetches += 1;
          return token.promise;
        },
      },
      user: {
        id: 'B',
      },
    } as never);

    const handoff = rebindConvexAuthForWatchHandoff(
      () => true,
      () => {},
      1_000,
    );
    const cloudPrefsToken = getClerkToken();
    await flushMicrotasks();

    assert.equal(fake.authConfigs.length, 2);
    const convexToken = fake.authConfigs[1].fetchToken();
    token.resolve('token-b');

    assert.equal(await cloudPrefsToken, 'token-b');
    assert.equal(await convexToken, 'token-b');
    assert.equal(tokenFetches, 1, 'Convex and cloud prefs should share B token fetch');

    fake.authConfigs[1].onChange(true);
    assert.equal(await handoff, true);
  });

  it('invalidates cached, in-flight, and Convex credentials on sign-out', async () => {
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(true);
    const oldAuthCallback = fake.authConfigs[0].onChange;
    const token = deferred<string | null>();
    __setClerkInstanceForTests({
      session: {
        getToken: async () => token.promise,
      },
      user: {
        id: 'B',
      },
    } as never);

    const inFlightToken = getClerkToken();
    invalidateConvexAuthForSignOut();
    assert.equal(fake.authConfigs.length, 2);

    // Model Clerk completing the same observed sign-out transition.
    __setClerkInstanceForTests(null);
    token.resolve('token-b');
    assert.equal(await inFlightToken, null);
    assert.equal(await getClerkToken(), null);

    // The old server callback is inert, and the dedicated replacement config
    // can never fetch the departing session.
    oldAuthCallback(true);
    assert.equal(await fake.authConfigs[1].fetchToken(), null);
    fake.authConfigs[1].onChange(false);
    assert.equal(await waitForConvexAuth(10), false);
  });

  it('checks the initiating account immediately before dispatch', async () => {
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-b' },
      user: { id: 'B' },
    } as never);
    let dispatched = false;

    await assert.rejects(
      settleAccountOperation('A', 'running the operation', async () => {
        dispatched = true;
      }),
      /Account changed while running the operation/,
    );
    assert.equal(dispatched, false);
  });

  it('masks an A-specific rejection when the operation rejects after B is selected', async () => {
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-a' },
      user: { id: 'A' },
    } as never);
    const operation = deferred<string>();
    const rejected = assert.rejects(
      settleAccountOperation('A', 'loading private account data', () => operation.promise),
      /Account changed while loading private account data/,
    );

    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-b' },
      user: { id: 'B' },
    } as never);
    operation.reject(new Error('A-specific backend detail'));

    await rejected;
  });

  it('preserves the original rejection while the initiating account remains current', async () => {
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-a' },
      user: { id: 'A' },
    } as never);
    const operation = deferred<string>();
    const original = new Error('same-account backend detail');
    const rejected = assert.rejects(
      settleAccountOperation('A', 'loading private account data', () => operation.promise),
      (err) => err === original,
    );

    operation.reject(original);
    await rejected;
  });

});

describe('cold Convex singleton initialization', () => {
  it('constructs one client and installs one auth config for concurrent callers', async () => {
    const fake = new FakeConvexClient();
    const releaseFactory = deferred<void>();
    let factoryCalls = 0;
    __setConvexClientFactoryForTests(async () => {
      factoryCalls += 1;
      await releaseFactory.promise;
      return fake as never;
    });

    const first = getConvexClient();
    const second = getConvexClient();
    assert.equal(factoryCalls, 1);

    releaseFactory.resolve();
    const [firstClient, secondClient] = await Promise.all([first, second]);

    assert.equal(factoryCalls, 1);
    assert.strictEqual(firstClient, secondClient);
    assert.strictEqual(firstClient, fake);
    assert.equal(fake.authConfigs.length, 1);
  });

  it('keeps only the latest account rebind when cold initialization resolves out of order', async () => {
    const fake = new FakeConvexClient();
    const releaseFactory = deferred<void>();
    __setConvexClientFactoryForTests(async () => {
      await releaseFactory.promise;
      return fake as never;
    });

    let currentUserId = 'B';
    const attached: string[] = [];
    const handoffB = rebindConvexAuthForWatchHandoff(
      () => currentUserId === 'B',
      () => attached.push('B'),
      1_000,
      [],
    );
    currentUserId = 'C';
    const handoffC = rebindConvexAuthForWatchHandoff(
      () => currentUserId === 'C',
      () => attached.push('C'),
      1_000,
      [],
    );

    releaseFactory.resolve();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(await handoffB, false);
    assert.equal(fake.authConfigs.length, 2, 'initial config plus latest C rebind only');
    fake.authConfigs[1].onChange(true);
    assert.equal(await handoffC, true);
    assert.deepEqual(attached, ['C']);
  });

  it('installs only a null-token auth config when sign-out wins cold creation', async () => {
    const fake = new FakeConvexClient();
    const releaseFactory = deferred<void>();
    __setClerkInstanceForTests({
      session: { getToken: async () => 'token-b' },
      user: { id: 'B' },
    } as never);
    __setConvexClientFactoryForTests(async () => {
      await releaseFactory.promise;
      return fake as never;
    });

    let current = true;
    const attached: string[] = [];
    const handoff = rebindConvexAuthForWatchHandoff(
      () => current,
      () => attached.push('B'),
      1_000,
      [],
    );

    current = false;
    invalidateConvexAuthForSignOut();
    __setClerkInstanceForTests(null);
    releaseFactory.resolve();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(await handoff, false);
    assert.deepEqual(attached, []);
    assert.equal(fake.authConfigs.length, 1, 'cold client must install only signed-out auth');
    assert.equal(await fake.authConfigs[0].fetchToken(), null);
  });
});

describe('App account-switch controller', () => {
  it('starts rebind before cloud prefs and resolves with the rebind result', async () => {
    const events: string[] = [];
    const completion = deferred<boolean>();

    const handoff = startAccountAuthHandoff({
      userId: 'B',
      isCurrent: () => true,
      effects: {
        rebindConvexAuthForWatchHandoff: (isCurrent) => {
          events.push('rebind');
          assert.equal(isCurrent(), true);
          return completion.promise;
        },
        cloudPrefsSignIn: (userId) => {
          events.push(`cloud-prefs:${userId}`);
        },
      },
    });

    assert.deepEqual(events, ['rebind', 'cloud-prefs:B']);
    completion.resolve(false);
    assert.equal(await handoff, false);
  });

  it('wires App through the tested account-handoff controller', async () => {
    const app = await readFile(new URL('../src/App.ts', import.meta.url), 'utf8');
    const branch = app.match(
      /if \(userId !== null && userId !== _prevUserId\) \{[\s\S]*?\/\/ Claim any anonymous purchase/,
    )?.[0];
    assert.ok(branch, 'expected the signed-in identity-change branch');
    assert.match(branch, /startAccountAuthHandoff\(\{/);
    assert.match(branch, /!this\.state\.isDestroyed[\s\S]*?handoffGeneration === _convexWatchHandoffGeneration/);
    assert.match(branch, /getAuthState\(\)\.user\?\.id === userId/);
    assert.match(branch, /rebindConvexAuthForWatchHandoff,/);
    assert.match(branch, /cloudPrefsSignIn: \(nextUserId\)/);
    assert.match(
      app,
      /else if \(userId === null && _prevUserId !== null\) \{[\s\S]*?invalidateConvexAuthForSignOut\(\);/,
    );
  });
});


// Sentry WORLDMONITOR-1CP: a signed-in Pro user's activation open failed three
// times inside a second with "Account changed while opening Pro activation",
// though the account never changed. The Convex SDK had reported auth false (a
// null scheduled token, or a failed reauth), the failure barrier was terminal,
// and only a Clerk user change ever rebound auth.
describe('same-user Convex auth recovery after a terminal failure', () => {
  const signIn = (id: string) => __setClerkInstanceForTests({
    session: { getToken: async () => `token-${id}` },
    user: { id },
  } as never);
  const openActivation = () => accountMutationProbe();

  it('reinstalls auth for the same user and lets a billing call through', async () => {
    signIn('A');
    const timers = installManualAuthTimers();
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(true);
    fake.mutationResult = Promise.resolve({ status: 'opened' });

    fake.authConfigs[0].onChange(false);
    await waitForCondition(() => fake.authConfigs.length === 2, 'failure should reinstall auth for A');

    const opening = openActivation();
    await flushMicrotasks();
    assert.equal(fake.mutations.length, 0, 'the mutation waits for the reinstalled config');
    fake.authConfigs[1].onChange(true);

    assert.equal(await opening, 'opened');
    assert.equal(fake.mutations.length, 1);
    assert.equal(fake.authConfigs.length, 2, 'the waiter shares the in-flight reinstall');
    assert.deepEqual(timers.pending().map((t) => t.ms), [1_000], 'only the cooldown remains');
  });

  it('recovers on demand when the failure arrives during an identity handoff', async () => {
    signIn('A');
    installManualAuthTimers();
    const fake = installFakeClient();
    fake.mutationResult = Promise.resolve({ status: 'opened' });
    const handoff = rebindConvexAuthForWatchHandoff(() => true, () => {}, 1_000, []);
    await flushMicrotasks();
    assert.equal(fake.authConfigs.length, 2);

    fake.authConfigs[1].onChange(false);
    assert.equal(await handoff, false);

    // The exhausted handoff hands its failed config to same-user recovery,
    // and the waiter shares that reinstall instead of starting another.
    await waitForCondition(() => fake.authConfigs.length === 3, 'handoff exit should reinstall auth');
    const opening = openActivation();
    await flushMicrotasks();
    assert.equal(fake.authConfigs.length, 3);
    fake.authConfigs[2].onChange(true);
    assert.equal(await opening, 'opened');
  });

  it("does not let an older account's sleeping handoff block the current user's recovery", async () => {
    let current = 'A';
    signIn('A');
    installManualAuthTimers();
    const fake = installFakeClient();
    const handoffA = rebindConvexAuthForWatchHandoff(() => current === 'A', () => {}, 1_000, [60_000]);
    await flushMicrotasks();
    fake.authConfigs[1].onChange(false);
    await flushMicrotasks();
    assert.equal(fake.authConfigs.length, 2, "A's handoff sleeps before its retry");

    current = 'B';
    signIn('B');
    const handoffB = rebindConvexAuthForWatchHandoff(() => current === 'B', () => {}, 1_000, []);
    await flushMicrotasks();
    fake.authConfigs[2].onChange(true);
    assert.equal(await handoffB, true);

    fake.authConfigs[2].onChange(false);
    await waitForCondition(() => fake.authConfigs.length === 4, "B's failure should reinstall auth for B");
    void handoffA;
  });

  it('a waiter that sees the failed placeholder during a handoff still runs its own recovery', async () => {
    signIn('A');
    installManualAuthTimers();
    const fake = installFakeClient();
    fake.mutationResult = Promise.resolve({ status: 'opened' });
    void rebindConvexAuthForWatchHandoff(() => true, () => {}, 1_000, [60_000]);
    await flushMicrotasks();
    assert.equal(fake.authConfigs.length, 2);

    const opening = openActivation();
    await flushMicrotasks();
    fake.authConfigs[1].onChange(false);
    await waitForCondition(() => fake.authConfigs.length === 3, 'the waiter should start one same-user recovery');
    fake.authConfigs[2].onChange(true);
    assert.equal(await opening, 'opened');
    assert.equal(fake.authConfigs.length, 3);
  });

  it('keeps one deadline across the original wait and the recovered config', async (t) => {
    signIn('A');
    const timers = installManualAuthTimers();
    const fake = installFakeClient();
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);

    const waiting = waitForConvexAuthForUser('A', 1_000);
    await flushMicrotasks();
    assert.deepEqual(timers.pending().map((timer) => timer.ms), [1_000]);

    now += 800;
    fake.authConfigs[0].onChange(false);
    await waitForCondition(() => fake.authConfigs.length === 2, 'failure should reinstall auth');
    await flushMicrotasks();
    assert.ok(
      timers.pending().some((timer) => timer.ms === 200),
      `the recovered wait gets the remaining 200 ms, saw ${JSON.stringify(timers.pending().map((x) => x.ms))}`,
    );
    fake.authConfigs[1].onChange(true);
    assert.equal(await waiting, true);
  });

  it('bounds reinstalls when the token stays unavailable', async () => {
    signIn('A');
    const timers = installManualAuthTimers();
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(false);

    // Proactive attempts: immediately, then after each cooldown, four in all.
    let expected = 2;
    for (const cooldownMs of [1_000, 5_000, 15_000, 30_000]) {
      await waitForCondition(() => fake.authConfigs.length === expected, 'one reinstall per cooldown');
      fake.authConfigs[expected - 1].onChange(false);
      await flushMicrotasks();
      assert.equal(fake.authConfigs.length, expected, 'no reinstall during the cooldown');
      assert.deepEqual(timers.pending().map((t) => t.ms), [cooldownMs]);
      timers.fireNext();
      await flushMicrotasks();
      expected += 1;
    }
    assert.equal(fake.authConfigs.length, 5, 'proactive recovery stops after four attempts');
    assert.deepEqual(timers.pending(), []);

    // A user action may still try once, and then the last cooldown applies.
    const first = openActivation();
    await waitForCondition(() => fake.authConfigs.length === 6, 'a user action reinstalls once');
    fake.authConfigs[5].onChange(false);
    await assert.rejects(first, /^Error: Authentication unavailable while running the probe\. Try again\.$/);

    await assert.rejects(openActivation(), /Authentication unavailable while running the probe/);
    assert.equal(fake.authConfigs.length, 6, 'a second action inside the cooldown does not reinstall');
    assert.equal(fake.mutations.length, 0);
  });

  it('does not resurrect auth when sign-out lands during recovery', async () => {
    signIn('A');
    const timers = installManualAuthTimers();
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(true);
    fake.authConfigs[0].onChange(false);

    invalidateConvexAuthForSignOut();
    __setClerkInstanceForTests(null);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(fake.authConfigs.length, 2, 'only the signed-out config is installed');
    assert.equal(await fake.authConfigs[1].fetchToken(), null);
    while (timers.pending().length > 0) timers.fireNext();
    await flushMicrotasks();
    assert.equal(fake.authConfigs.length, 2, 'an expiring cooldown cannot restart recovery');
    fake.authConfigs[1].onChange(false);
    await flushMicrotasks();
    assert.equal(fake.authConfigs.length, 2, 'the signed-out config failing does not start recovery');
    assert.equal(await waitForConvexAuth(10), false);
  });

  it('cannot satisfy the old user when the account switches during recovery', async () => {
    signIn('A');
    installManualAuthTimers();
    const fake = installFakeClient();
    fake.authConfigs[0].onChange(true);
    fake.authConfigs[0].onChange(false);
    await waitForCondition(() => fake.authConfigs.length === 2, 'A recovery reinstall');

    const opening = assert.rejects(openActivation(), /Account changed while running the probe/);
    await flushMicrotasks();

    signIn('B');
    const handoff = rebindConvexAuthForWatchHandoff(() => true, () => {}, 1_000, []);
    await flushMicrotasks();
    assert.equal(fake.authConfigs.length, 3);
    fake.authConfigs[1].onChange(true);
    fake.authConfigs[2].onChange(true);

    assert.equal(await handoff, true);
    await opening;
    assert.equal(fake.mutations.length, 0, 'no mutation is dispatched for A under B');
  });
});
