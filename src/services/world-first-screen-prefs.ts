import { DEFAULT_FIELDS, WORLD_FIELDS } from '../../shared/world-overview.js';
import type { WorldField } from '@/types/world-overview';
import { loadFromStorage, saveToStorage } from '@/utils';

const MODE_KEY = 'worldmonitor-first-screen-mode';
const FIELDS_KEY = 'worldmonitor-world-fields';

export type FirstScreenMode = 'world' | 'full';

export function getFirstScreenMode(): FirstScreenMode {
  const value = loadFromStorage<unknown>(MODE_KEY, 'world');
  return value === 'full' ? 'full' : 'world';
}

export function setFirstScreenMode(mode: FirstScreenMode): void {
  saveToStorage(MODE_KEY, mode);
}

export function getWorldFields(): WorldField[] {
  const value = loadFromStorage<unknown>(FIELDS_KEY, [...DEFAULT_FIELDS]);
  if (!Array.isArray(value)) return [...DEFAULT_FIELDS];
  const allowed = new Set<string>(WORLD_FIELDS);
  return value.filter((field): field is WorldField => typeof field === 'string' && allowed.has(field));
}

export function setWorldFields(fields: readonly WorldField[]): void {
  const allowed = new Set<string>(WORLD_FIELDS);
  saveToStorage(FIELDS_KEY, fields.filter((field) => allowed.has(field)));
}

/** Class on <html> while the world first screen is shown (CSS and click routing read it). */
export const WORLD_MODE_CLASS = 'wm-world-mode';
