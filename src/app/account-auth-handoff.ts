export interface AccountAuthHandoffEffects {
  rebindConvexAuthForWatchHandoff: (
    isCurrent: () => boolean,
    attachWatches: () => void,
  ) => Promise<boolean>;
  cloudPrefsSignIn: (userId: string) => void | Promise<void>;
}

/**
 * Start the authenticated handoff for a newly signed-in account.
 *
 * The rebind effect is deliberately invoked before cloud preferences. Its
 * production implementation invalidates the old Clerk token synchronously
 * before its first await, after which Convex and cloud prefs may safely share
 * the new account's in-flight token fetch.
 */
export function startAccountAuthHandoff(input: {
  userId: string;
  isCurrent: () => boolean;
  effects: AccountAuthHandoffEffects;
}): Promise<boolean> {
  const { userId, isCurrent, effects } = input;
  const handoff = effects.rebindConvexAuthForWatchHandoff(isCurrent, () => {});
  void effects.cloudPrefsSignIn(userId);
  return handoff;
}
