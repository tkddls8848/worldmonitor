/**
 * Plan & billing danger zone: signed-in users can delete the current Clerk
 * subject after typing DELETE. Invitees see the control even without Manage
 * Billing. Anonymous dashboards have no account to delete.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import i18next from 'i18next';

import { initTestI18n } from './helpers/i18n.mts';
import en from '@/locales/en.json';
import enShell from '@/locales/en.shell.json';
import type { UnifiedSettingsConfig } from '@/components/UnifiedSettings';
import type { AuthSession } from '@/services/auth-state';

let session: AuthSession = signedIn('user_self');
const authSubscribers: Array<(state: AuthSession) => void> = [];
let entitled = true;

const deletionMocks = vi.hoisted(() => ({
  request: vi.fn(),
}));
const signOutMock = vi.hoisted(() => vi.fn(async () => {}));
const toastMock = vi.hoisted(() => vi.fn());

const storageValues = new Map<string, string>();
const storage: Storage = {
  get length() { return storageValues.size; },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => [...storageValues.keys()][index] ?? null,
  removeItem: (key) => { storageValues.delete(key); },
  setItem: (key, value) => { storageValues.set(key, value); },
};

vi.mock('@/services/desktop-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/desktop-runtime')>()),
  isDesktopRuntime: () => false,
}));

vi.mock('@/services/auth-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth-state')>()),
  getAuthState: () => session,
  subscribeAuthState: (cb: (state: AuthSession) => void) => {
    authSubscribers.push(cb);
    return () => {
      const i = authSubscribers.indexOf(cb);
      if (i >= 0) authSubscribers.splice(i, 1);
    };
  },
}));

/** Drive an account switch the way the real auth store would. */
function switchAccountTo(next: AuthSession): void {
  session = next;
  for (const cb of [...authSubscribers]) cb(next);
}

vi.mock('@/services/clerk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/clerk')>()),
  isClerkAuthEnabled: () => true,
  signOut: () => signOutMock(),
  getCurrentClerkUser: () => session.user,
}));

vi.mock('@/services/account-deletion', () => ({
  requestOwnAccountDeletion: (...args: unknown[]) => deletionMocks.request(...args),
}));

vi.mock('@/utils/toast', () => ({
  showToast: (...args: unknown[]) => toastMock(...args),
}));



vi.mock('@/services/widget-store', () => ({
  isProUser: () => entitled,
}));

vi.mock('@/services/preferences-content', () => ({
  renderPreferenceSection: () => ({ html: '', attach: () => () => {} }),
}));

vi.mock('@/services/notifications-settings', () => ({
  renderNotificationsSettings: () => ({ html: '', attach: () => () => {} }),
}));

vi.mock('@/config/feeds', () => ({
  CANONICAL_FEEDS: {},
  INTEL_SOURCES: [],
  SOURCE_REGION_MAP: {},
}));

vi.mock('@/config/panels', () => ({
  PANEL_CATEGORY_MAP: {},
  ALL_PANELS: {},
  VARIANT_DEFAULTS: { full: [] },
  getEffectivePanelConfig: () => ({ name: '', enabled: false }),
  getVariantPanelCategories: () => [],
  isPanelEntitled: () => true,
  FREE_MAX_PANELS: 3,
  countFreePanelCapUsage: () => 0,
  isFreePanelCapCounted: () => false,
}));

vi.mock('@/config/variant', () => ({
  SITE_VARIANT: 'full',
}));






const { UnifiedSettings } = await import('@/components/UnifiedSettings');

let settings: InstanceType<typeof UnifiedSettings>;

function signedIn(id: string): AuthSession {
  return {
    user: { id, name: `User ${id}`, email: `${id}@example.com`, role: 'pro' },
    isPending: false,
  };
}

function anonymous(): AuthSession {
  return { user: null, isPending: false };
}

function config(): UnifiedSettingsConfig {
  return {
    getPanelSettings: () => ({}),
    savePanelSettings: () => {},
    getDisabledSources: () => new Set(),
    toggleSource: () => {},
    setSourcesEnabled: () => {},
    getAllSourceNames: () => [],
    getLocalizedPanelName: (_key, fallback) => fallback,
    resetLayout: () => {},
    isDesktopApp: false,
  };
}

function typePhrase(value: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('[data-deletion-phrase]');
  expect(input).not.toBeNull();
  input!.value = value;
  input!.dispatchEvent(new Event('input', { bubbles: true }));
  return input!;
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  storageValues.clear();
  vi.stubGlobal('localStorage', storage);
  authSubscribers.length = 0;
  session = signedIn('user_self');
  entitled = true;
  deletionMocks.request.mockReset();
  deletionMocks.request.mockResolvedValue({ status: 'complete', userIdHash: 'abc' });
  signOutMock.mockReset();
  toastMock.mockReset();
  settings = new UnifiedSettings(config());
});

afterEach(() => {
  settings?.destroy();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('UnifiedSettings opened before the full English catalogue loads', () => {
  const RAW_KEY = /\b(?:settings|auth|components|common)\.[A-Za-z0-9_.-]+\b/g;
  const rawKeysIn = (root: Element) => (root.textContent ?? '').match(RAW_KEY) ?? [];

  beforeEach(() => {
    i18next.removeResourceBundle('en', 'translation');
    i18next.addResourceBundle('en', 'translation', enShell as Record<string, unknown>, true, true);
  });

  afterEach(() => {
    i18next.addResourceBundle('en', 'translation', en as Record<string, unknown>, true, true);
  });

  it('replaces raw keys on the open Account page and the home rows once the catalogue arrives', async () => {
    const { I18N_RESOURCES_LOADED_EVENT } = await import('@/services/i18n');
    settings.open('account');
    const overlay = document.querySelector<HTMLElement>('#unifiedSettingsModal')!;
    const page = overlay.querySelector<HTMLElement>('[data-settings-page="account"]')!;
    expect(rawKeysIn(overlay).length).toBeGreaterThan(0);

    i18next.addResourceBundle('en', 'translation', en as Record<string, unknown>, true, true);
    window.dispatchEvent(new CustomEvent(I18N_RESOURCES_LOADED_EVENT, { detail: { language: 'en' } }));

    expect(rawKeysIn(overlay)).toEqual([]);
    expect(overlay.querySelector('[data-settings-page="account"]')).toBe(page);
    expect(page.querySelector('.billing-settings-intro h3')?.textContent?.trim()).toBe('Plan & billing');
    expect(page.querySelector('.billing-settings-intro p')?.textContent?.trim()).toBe(en.settings.account.intro);
  });

});

describe('UnifiedSettings sign out', () => {
  const signOutRow = () => document.querySelector<HTMLButtonElement>('[data-settings-signout]');

  it('offers Sign out at the foot of the Account page, above Delete account', () => {
    settings.open('account');
    const row = signOutRow()!;
    const deletion = document.querySelector('[data-account-deletion]')!;
    expect(row.textContent?.trim()).toBe('Sign out');
    expect(row.compareDocumentPosition(deletion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('signs out once, then shows the signed-out home list', () => {
    settings.open('account');
    signOutRow()!.click();
    signOutRow()!.click();
    expect(signOutMock).toHaveBeenCalledTimes(1);

    switchAccountTo(anonymous());

    expect(document.querySelector('[data-settings-page="account"]')).toBeNull();
    expect(document.querySelector<HTMLElement>('[data-settings-home]')!.hidden).toBe(false);
    expect(document.querySelector('[data-settings-signin]')).not.toBeNull();
  });

  it('reports a failed sign-out and lets the user try again', async () => {
    signOutMock.mockRejectedValueOnce(new Error('network'));
    settings.open('account');
    signOutRow()!.click();

    await vi.waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledWith('Could not sign out. Try again.');
    expect(signOutRow()!.disabled).toBe(false);
  });
});

describe('UnifiedSettings account deletion', () => {
  it('shows the danger zone when signed in and hides it when anonymous', () => {
    settings.open('account');
    expect(document.querySelector('[data-account-deletion]')).not.toBeNull();
    settings.destroy();

    session = anonymous();
    entitled = false;
    settings = new UnifiedSettings(config());
    settings.open();
    expect(document.querySelector('[data-settings-nav="account"]')).toBeNull();
    expect(document.querySelector('[data-settings-signin]')).not.toBeNull();
    expect(document.querySelector('[data-account-deletion]')).toBeNull();
  });

  it('shows Delete account for an invitee without Manage Billing', () => {
    entitled = true;
    settings.open('account');
    expect(document.querySelector('.manage-billing-btn')).toBeNull();
    expect(document.querySelector('[data-delete-account]')).not.toBeNull();
  });

  it('keeps confirm disabled for empty and wrong phrases', () => {
    settings.open('account');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    const confirm = document.querySelector<HTMLButtonElement>('[data-deletion-confirm]');
    expect(confirm?.disabled).toBe(true);
    typePhrase('');
    expect(confirm?.disabled).toBe(true);
    typePhrase('delete');
    expect(confirm?.disabled).toBe(true);
    typePhrase('DEL');
    expect(confirm?.disabled).toBe(true);
    expect(deletionMocks.request).not.toHaveBeenCalled();
  });

  it('signs out after a successful typed confirmation', async () => {
    settings.open('account');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    typePhrase('DELETE');
    const confirm = document.querySelector<HTMLButtonElement>('[data-deletion-confirm]');
    expect(confirm?.disabled).toBe(false);
    confirm!.click();
    await vi.waitFor(() => {
      expect(deletionMocks.request).toHaveBeenCalledTimes(1);
      expect(signOutMock).toHaveBeenCalledTimes(1);
    });
    expect(document.getElementById('unifiedSettingsModal')?.classList.contains('active')).toBe(false);
    expect(toastMock).toHaveBeenCalledWith(
      expect.stringMatching(/Sign out on other devices/i),
    );
  });

  it('keeps the dialog busy after Escape until the deletion request settles', async () => {
    let resolveRequest!: (value: { status: string; userIdHash: string }) => void;
    deletionMocks.request.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    settings.open('account');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    typePhrase('DELETE');
    const confirm = document.querySelector<HTMLButtonElement>('[data-deletion-confirm]')!;
    confirm.click();
    expect(deletionMocks.request).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    expect(document.querySelector('[data-deletion-confirm]')).toBe(confirm);
    expect(confirm.disabled).toBe(true);
    confirm.click();
    expect(deletionMocks.request).toHaveBeenCalledTimes(1);
    expect(signOutMock).not.toHaveBeenCalled();

    resolveRequest({ status: 'complete', userIdHash: 'abc' });
    await vi.waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    expect(document.querySelector('[data-deletion-confirm]')).toBeNull();
  });

  it('does not sign out when the account changes mid-request', async () => {
    deletionMocks.request.mockRejectedValue(
      new Error('Account changed while deleting the account. Try again.'),
    );
    settings.open('account');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    typePhrase('DELETE');
    document.querySelector<HTMLButtonElement>('[data-deletion-confirm]')!.click();
    await vi.waitFor(() => {
      expect(deletionMocks.request).toHaveBeenCalledTimes(1);
    });
    expect(signOutMock).not.toHaveBeenCalled();
    expect(document.getElementById('unifiedSettingsModal')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('[data-deletion-confirm]')).toBeNull();
  });

  it('stacks the type-DELETE dialog above the settings overlay', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/main.css'), 'utf8');
    const overlayZ = Number(css.match(/\.modal-overlay \{[^}]*z-index:\s*(\d+)/)?.[1]);
    const dialogZ = Number(
      css.match(/\.account-deletion-dialog-overlay \{[^}]*z-index:\s*(\d+)/)?.[1],
    );
    expect(overlayZ).toBeGreaterThan(0);
    expect(dialogZ).toBeGreaterThan(overlayZ);
  });

  it('keeps confirm disabled for same-length near-miss phrases', () => {
    settings.open('account');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    const confirm = document.querySelector<HTMLButtonElement>('[data-deletion-confirm]');
    // The gate is a strict equality on the trimmed value. A future change to
    // prefix or includes matching would let each of these through.
    for (const phrase of ['DELETEX', 'DELETE!', 'XDELETE', 'DELETE DELETE', 'DELET']) {
      typePhrase(phrase);
      expect(confirm?.disabled, `phrase ${phrase} must not enable confirm`).toBe(true);
    }
    // Surrounding whitespace is trimmed, so this one is a real confirmation.
    typePhrase('  DELETE  ');
    expect(confirm?.disabled).toBe(false);
    expect(deletionMocks.request).not.toHaveBeenCalled();
  });

  it('traps focus inside the dialog and restores it on close', () => {
    settings.open('account');
    const trigger = document.querySelector<HTMLButtonElement>('[data-delete-account]')!;
    trigger.focus();
    trigger.click();
    const overlay = document.querySelector('.account-deletion-dialog-overlay')!;
    // aria-modal is a promise to the keyboard; without a trap Tab walks out of
    // a destructive dialog into the still-interactive settings modal behind it.
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(overlay.contains(document.activeElement)).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-deletion-cancel]')!.click();
    expect(document.querySelector('.account-deletion-dialog-overlay')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('survives a back gesture mid-deletion without clearing the busy latch', async () => {
    let resolveRequest!: (value: { status: string; userIdHash: string }) => void;
    deletionMocks.request.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    settings.open('account');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    typePhrase('DELETE');
    const confirm = document.querySelector<HTMLButtonElement>('[data-deletion-confirm]')!;
    confirm.click();
    expect(deletionMocks.request).toHaveBeenCalledTimes(1);

    // The mobile back gesture reaches close('history') through popstate — a
    // path neither the click handler nor escapeHandler covers. It used to run
    // teardownSettings -> closeDeletionDialog, clearing deletionBusy mid-await
    // and re-permitting a second confirmation against the same account.
    settings.close('history');
    expect(document.querySelector('[data-deletion-confirm]')).toBe(confirm);
    expect(confirm.disabled).toBe(true);

    document.querySelector<HTMLButtonElement>('[data-delete-account]')?.click();
    confirm.click();
    expect(deletionMocks.request).toHaveBeenCalledTimes(1);
    expect(signOutMock).not.toHaveBeenCalled();

    resolveRequest({ status: 'complete', userIdHash: 'abc' });
    await vi.waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
  });

  it('closes the dialog when the signed-in account changes underneath it', () => {
    settings.open('account');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    expect(document.querySelector('.account-deletion-dialog-overlay')).not.toBeNull();

    // A deletion confirmed for user A must never be applied to user B, so the
    // dialog is torn down on any real identity change.
    switchAccountTo(signedIn('user_other'));
    expect(document.querySelector('.account-deletion-dialog-overlay')).toBeNull();
    expect(deletionMocks.request).not.toHaveBeenCalled();
  });

  it('still reports a failure when the account switched away mid-deletion', async () => {
    let rejectRequest!: (err: Error) => void;
    deletionMocks.request.mockReturnValue(new Promise((_resolve, reject) => {
      rejectRequest = reject;
    }));
    settings.open('account');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    typePhrase('DELETE');
    document.querySelector<HTMLButtonElement>('[data-deletion-confirm]')!.click();
    expect(deletionMocks.request).toHaveBeenCalledTimes(1);

    // The dialog is the only surface that renders deletionError, so once an
    // account switch removes it the failure has nowhere to go but a toast.
    switchAccountTo(signedIn('user_other'));
    expect(document.querySelector('.account-deletion-dialog-overlay')).toBeNull();

    rejectRequest(new Error('Convex unavailable'));
    await vi.waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/Convex unavailable/));
    });
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it('does not leave Confirm one click away when the poll gives up', async () => {
    deletionMocks.request.mockRejectedValue(
      new Error('Account deletion is still running. Reload in a moment to check.'),
    );
    settings.open('account');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    typePhrase('DELETE');
    document.querySelector<HTMLButtonElement>('[data-deletion-confirm]')!.click();

    await vi.waitFor(() => {
      expect(document.querySelector('[data-deletion-error]')?.textContent)
        .toMatch(/still running/i);
    });
    // The server is still working, so a reflex re-submit must not be possible
    // without deliberately re-typing the phrase...
    const confirm = document.querySelector<HTMLButtonElement>('[data-deletion-confirm]')!;
    expect(confirm.disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[data-deletion-phrase]')!.value).toBe('');
    // ...but the dialog must still be dismissable, not latched forever.
    document.querySelector<HTMLButtonElement>('[data-deletion-cancel]')!.click();
    expect(document.querySelector('.account-deletion-dialog-overlay')).toBeNull();
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it('does not toast "Account changed" after the switch already closed the dialog', async () => {
    let rejectRequest!: (err: Error) => void;
    deletionMocks.request.mockReturnValue(new Promise((_resolve, reject) => {
      rejectRequest = reject;
    }));
    settings.open('account');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    typePhrase('DELETE');
    document.querySelector<HTMLButtonElement>('[data-deletion-confirm]')!.click();

    // The switch itself already removed the dialog, so by the time the
    // abandoned request rejects the user has moved on -- a late "Account
    // changed... Try again." is about a request they no longer remember.
    switchAccountTo(signedIn('user_other'));
    expect(document.querySelector('.account-deletion-dialog-overlay')).toBeNull();

    rejectRequest(new Error('Account changed while deleting the account. Try again.'));
    await vi.waitFor(() => {
      expect(deletionMocks.request).toHaveBeenCalledTimes(1);
    });
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/Account changed/),
    );
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it('shows a retryable error and keeps the session on failure', async () => {
    deletionMocks.request.mockRejectedValue(new Error('Convex unavailable'));
    settings.open('account');
    document.querySelector<HTMLButtonElement>('[data-delete-account]')!.click();
    typePhrase('DELETE');
    document.querySelector<HTMLButtonElement>('[data-deletion-confirm]')!.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-deletion-error]')?.textContent).toBe('Convex unavailable');
    });
    expect(signOutMock).not.toHaveBeenCalled();
    expect(document.getElementById('unifiedSettingsModal')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('[data-deletion-confirm]')).not.toBeNull();
  });
});
