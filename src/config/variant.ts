/**
 * Every variant a user can switch to.
 */
export const SITE_VARIANTS = ['full', 'tech', 'finance',  'commodity', 'energy'] as const;

export type SiteVariant = (typeof SITE_VARIANTS)[number];

export function isSiteVariant(value: string | null | undefined): value is SiteVariant {
  return typeof value === 'string' && (SITE_VARIANTS as readonly string[]).includes(value);
}

const buildVariant = (() => {
  try {
    return import.meta.env.VITE_VARIANT || 'full';
  } catch {
    return 'full';
  }
})();

function loadStoredVariant(): string | null {
  try {
    return localStorage.getItem('worldmonitor-variant');
  } catch {
    return null;
  }
}

export const SITE_VARIANT: string = (() => {
  if (typeof window === 'undefined') return buildVariant;

  // window.location, not bare `location`: node-based tests stub `window`
  // without a global `location`, and this module must stay importable there.
  const h = window.location?.hostname;
  if (!h) return buildVariant;
  if (h.startsWith('tech.')) return 'tech';
  if (h.startsWith('finance.')) return 'finance';
  if (h.startsWith('commodity.')) return 'commodity';
  if (h.startsWith('energy.')) return 'energy';

  if (h === 'localhost' || h === '127.0.0.1') {
    const stored = loadStoredVariant();
    if (isSiteVariant(stored)) return stored;
    return buildVariant;
  }

  return 'full';
})();
