// A signed-in desktop reaches the cloud with the user's Clerk bearer; a
// signed-out desktop forwards nothing. There is no plan to check first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clerkToken = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
vi.mock('@/services/clerk', () => ({ getClerkToken: clerkToken }));
type Session = { user: { id: string } | null; isPending: boolean };
const auth = vi.hoisted(() => ({
  session: { user: null, isPending: true } as { user: { id: string } | null; isPending: boolean },
  listeners: new Set<(session: { user: { id: string } | null; isPending: boolean }) => void>(),
}));
vi.mock('@/services/auth-state', () => ({
  subscribeAuthState: (listener: (session: Session) => void) => {
    auth.listeners.add(listener);
    listener(auth.session);
    return () => auth.listeners.delete(listener);
  },
}));

function emitAuth(session: Session) {
  auth.session = session;
  for (const listener of [...auth.listeners]) listener(session);
}

const HINT_KEY = 'wm-desktop-cloud-access';

beforeEach(() => {
  vi.resetModules();
  auth.session = { user: null, isPending: true };
  auth.listeners.clear();
  clerkToken.mockReset();
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe('getDesktopCloudAuthorization', () => {
  it('returns the Clerk bearer for a signed-in user', async () => {
    clerkToken.mockResolvedValue('clerk-jwt');
    const { getDesktopCloudAuthorization } = await import('@/services/desktop-cloud-auth');
    expect(await getDesktopCloudAuthorization()).toBe('Bearer clerk-jwt');
  });

  it('forwards nothing when Clerk has no session', async () => {
    clerkToken.mockResolvedValue(null);
    const { getDesktopCloudAuthorization } = await import('@/services/desktop-cloud-auth');
    expect(await getDesktopCloudAuthorization()).toBeNull();
  });

  it('forwards nothing when the token lookup fails', async () => {
    clerkToken.mockRejectedValue(new Error('clerk unavailable'));
    const { getDesktopCloudAuthorization } = await import('@/services/desktop-cloud-auth');
    expect(await getDesktopCloudAuthorization()).toBeNull();
  });

  it('gives up on a Clerk load that never settles', async () => {
    vi.useFakeTimers();
    clerkToken.mockReturnValue(new Promise(() => {}));
    const { getDesktopCloudAuthorization, DESKTOP_CLOUD_TOKEN_WAIT_MS } = await import('@/services/desktop-cloud-auth');
    const pending = getDesktopCloudAuthorization();
    await vi.advanceTimersByTimeAsync(DESKTOP_CLOUD_TOKEN_WAIT_MS);
    expect(await pending).toBeNull();
  });
});

describe('watchDesktopCloudAccess', () => {
  it('forgets the legacy launch hint on sign-out and stops listening when torn down', async () => {
    localStorage.setItem(HINT_KEY, '1');
    const { watchDesktopCloudAccess } = await import('@/services/desktop-cloud-auth');
    const stop = watchDesktopCloudAccess(() => {});
    expect(localStorage.getItem(HINT_KEY)).toBe('1');
    emitAuth({ user: null, isPending: false });
    expect(localStorage.getItem(HINT_KEY)).toBeNull();
    stop();
    expect(auth.listeners.size).toBe(0);
  });
});
