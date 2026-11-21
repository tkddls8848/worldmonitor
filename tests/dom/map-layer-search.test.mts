import { beforeEach, describe, expect, it } from 'vitest';

import {
  bindLayerSearch,
  LAYER_REGISTRY,
  LAYER_SYNONYMS,
} from '@/config/map-layer-definitions';

describe('layer picker synonym search', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="layer-picker">
        <input class="layer-search" />
        <div class="layer-toggle-row">
          <label class="layer-toggle" data-layer="reservoirLevels">Water Levels</label>
        </div>
        <div class="layer-toggle-row">
          <label class="layer-toggle" data-layer="conflicts">Conflict Zones</label>
        </div>
      </div>
    `;
  });

  it('keeps the label short and maps hydropower to the water-level layer', () => {
    expect(LAYER_REGISTRY.reservoirLevels.fallbackLabel).toBe('Water Levels');
    expect(LAYER_SYNONYMS.hydropower).toContain('reservoirLevels');
  });

  it('finds Water Levels when the picker is searched for hydropower', () => {
    const picker = document.querySelector<HTMLElement>('#layer-picker');
    const search = picker?.querySelector<HTMLInputElement>('.layer-search');
    const reservoirs = picker?.querySelector<HTMLElement>('[data-layer="reservoirLevels"]')?.closest<HTMLElement>('.layer-toggle-row');
    const conflicts = picker?.querySelector<HTMLElement>('[data-layer="conflicts"]')?.closest<HTMLElement>('.layer-toggle-row');

    expect(picker).not.toBeNull();
    expect(search).not.toBeNull();
    expect(reservoirs).not.toBeNull();
    expect(conflicts).not.toBeNull();

    bindLayerSearch(picker!);
    search!.value = 'hydropower';
    search!.dispatchEvent(new Event('input'));

    expect(reservoirs!.style.display).toBe('');
    expect(conflicts!.style.display).toBe('none');
  });
});
