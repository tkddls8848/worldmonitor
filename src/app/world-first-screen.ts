import type { AppContext } from '@/app/app-context';

export interface WorldFirstScreenSlots {
  root: HTMLElement;
  masthead: HTMLElement;
  dispatch: HTMLElement;
  stage: HTMLElement;
  shelf: HTMLElement;
}

export function mountWorldFirstScreen(
  _ctx: AppContext,
  _slots: WorldFirstScreenSlots,
  _hooks: { openFullView(): void },
): { destroy(): void; onEnter(): void } {
  return { destroy() {}, onEnter() {} };
}
