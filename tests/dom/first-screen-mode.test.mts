import { afterEach, describe, expect, it } from 'vitest';
import {
  getFirstScreenMode,
  getWorldFields,
  setFirstScreenMode,
  setWorldFields,
} from '@/services/world-first-screen-prefs';

const MODE_KEY = 'worldmonitor-first-screen-mode';
const FIELDS_KEY = 'worldmonitor-world-fields';

afterEach(() => {
  localStorage.removeItem(MODE_KEY);
  localStorage.removeItem(FIELDS_KEY);
});

describe('first screen preferences', () => {
  it('defaults to world mode and the default fields', () => {
    expect(getFirstScreenMode()).toBe('world');
    expect(getWorldFields()).toEqual(['military', 'geopolitics']);
  });

  it('validates stored mode and filters invalid fields', () => {
    localStorage.setItem(MODE_KEY, JSON.stringify('unexpected'));
    localStorage.setItem(FIELDS_KEY, JSON.stringify(['politics', 'invalid', 3, 'military']));
    expect(getFirstScreenMode()).toBe('world');
    expect(getWorldFields()).toEqual(['politics', 'military']);
  });

  it('persists mode and only allowed fields', () => {
    setFirstScreenMode('full');
    setWorldFields(['finance', 'military']);
    expect(getFirstScreenMode()).toBe('full');
    expect(getWorldFields()).toEqual(['finance', 'military']);
  });
});
