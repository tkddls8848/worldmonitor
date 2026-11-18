import { subscribeAuthState } from './auth-state';
import { safeStorageRemove } from '@/utils/safe-storage';
import { DESKTOP_CLOUD_ACCESS_HINT_KEY as CLOUD_ACCESS_HINT_KEY } from './desktop-cloud-access-hint';

/**
 * The credential a desktop request carries to the cloud through the sidecar:
 * the signed-in user's Clerk bearer, or nothing when no session answers in
 * time. There is no paid plan to check first.
 */
export const DESKTOP_CLOUD_TOKEN_WAIT_MS = 8_000;

async function sessionToken(): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { getClerkToken } = await import('./clerk');
    return await Promise.race([
      getClerkToken(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), DESKTOP_CLOUD_TOKEN_WAIT_MS); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getDesktopCloudAuthorization(): Promise<string | null> {
  const token = await sessionToken();
  return token ? `Bearer ${token}` : null;
}

/** Clears the legacy launch hint when the account signs out. */
export function watchDesktopCloudAccess(_reload: () => void): () => void {
  return subscribeAuthState((session) => {
    if (!session.isPending && session.user === null) safeStorageRemove(CLOUD_ACCESS_HINT_KEY);
  });
}
