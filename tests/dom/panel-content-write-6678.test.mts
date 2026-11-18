/**
 * #6678 moved the success writes of ServiceStatusPanel and DefensePatentsPanel
 * onto `Panel.setContentNodes()`. The migration is deliberately RUNG-NEUTRAL:
 * each panel's LOADING render must not reset the error backoff it is climbing,
 * or a flapping upstream would retry every 15s forever instead of backing off.
 *
 * (The personal build has no panel lock, so the locked-panel cases this file
 * used to hold are gone; the backoff guard does not depend on the lock.)
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

import { DefensePatentsPanel } from '@/components/DefensePatentsPanel';
import { ServiceStatusPanel } from '@/components/ServiceStatusPanel';

/** Base-class state these tests reach into. */
interface PanelInternals {
  element: HTMLElement;
  content: HTMLElement;
  retryAttempt: number;
}

/** Per-panel fields the render() call sites branch on. */
interface RenderFlags {
  loading: boolean;
  error: string | null;
}

function internals(panel: object): PanelInternals {
  return panel as unknown as PanelInternals;
}

function flags(panel: object): RenderFlags {
  return panel as unknown as RenderFlags;
}

function mount(panel: object): void {
  document.body.appendChild(internals(panel).element);
}

/** The countdown line rendered by `showError`, e.g. "Retrying (15s)". */
function countdownText(panel: object): string | null {
  return internals(panel).content.querySelector('.panel-error-countdown')?.textContent ?? null;
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('loading branches keep the backoff rung after the success migration', () => {
  /** Drive the real error site once: rung 0 is consumed, `retryAttempt` becomes 1. */
  function driveFirstFailure(panel: object): void {
    flags(panel).loading = false;
    flags(panel).error = 'boom';
    (panel as unknown as { render(): void }).render();
    // Non-vacuity: prove we really are at rung 1 before the loading render, so a
    // later "(30s)" cannot be an accident of the panel never having failed.
    expect(countdownText(panel)).toMatch(/\(15s\)/);
    expect(internals(panel).retryAttempt).toBe(1);
  }

  /** Drive the real error site again; the countdown reports the rung it re-entered at. */
  function driveSecondFailure(panel: object): string | null {
    flags(panel).loading = false;
    flags(panel).error = 'boom';
    (panel as unknown as { render(): void }).render();
    return countdownText(panel);
  }

  /**
   * `loadingSelector` is non-vacuity, not decoration: without it, DELETING the
   * loading branch outright leaves both cases below green — the rung would
   * survive a render that painted nothing at all, which is not the invariant.
   */
  function driveLoading(panel: object, loadingSelector: string): void {
    flags(panel).loading = true;
    (panel as unknown as { render(): void }).render();
    expect(internals(panel).content.querySelector(loadingSelector)).not.toBeNull();
  }

  it('ServiceStatusPanel keeps the rung across its loading render', () => {
    const panel = new ServiceStatusPanel();
    mount(panel);

    driveFirstFailure(panel);
    driveLoading(panel, '.service-status-loading');

    // 30s, not 15s: the loading render must not have reset the backoff.
    expect(driveSecondFailure(panel)).toMatch(/\(30s\)/);

    panel.destroy();
  });

  it('DefensePatentsPanel keeps the rung across its loading render', () => {
    vi.spyOn(
      DefensePatentsPanel.prototype as unknown as { fetchPatents(): Promise<void> },
      'fetchPatents',
    ).mockResolvedValue(undefined);

    const panel = new DefensePatentsPanel();
    mount(panel);

    driveFirstFailure(panel);
    driveLoading(panel, '.defense-patents-loading');

    expect(driveSecondFailure(panel)).toMatch(/\(30s\)/);

    panel.destroy();
  });
});
