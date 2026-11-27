import { describe, expect, it } from 'vitest';

import {
  VARIANT_SWITCHER_DASHBOARD_URLS,
  variantSwitcherHref,
} from '@/app/panel-layout';

describe('variant switcher navigation', () => {
  it('sends every non-local variant switcher target to its dashboard route', () => {
    for (const [variant, expected] of Object.entries(VARIANT_SWITCHER_DASHBOARD_URLS)) {
      expect(
        variantSwitcherHref(
          variant as keyof typeof VARIANT_SWITCHER_DASHBOARD_URLS,
          variant === 'full' ? 'finance' : 'full',
          false,
        ),
      ).toBe(expected);
      expect(new URL(expected).pathname).toBe('/dashboard');
    }
  });

  it('does not navigate for local development or the active variant', () => {
    expect(variantSwitcherHref('finance', 'full', true)).toBe('#');
    expect(variantSwitcherHref('finance', 'finance', false)).toBe('#');
  });
});
