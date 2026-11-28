import type { ThemeName } from '@/types/world-overview';
import type { IMPACT_KINDS as API_IMPACT_KINDS } from '../../shared/impact-links';

export type ImpactKind = typeof API_IMPACT_KINDS[number];

// Arrow paths in a 12×12 box, facing right. The map and key share the same marks.
export const IMPACT_STYLES = {
  conflict: { label: '충돌', detail: '무력 충돌', dash: '', end: 'M1 1L12 6L1 11L4 6Z', filled: true },
  sanctions: { label: '제재', detail: '제재·수출통제', dash: '10 5', end: 'M1 2L8 6L1 10Z M11 1V11', filled: true },
  tariffs: { label: '관세', detail: '관세·무역조치', dash: '4 3 9 3', end: 'M1 2L5 6L1 10 M6 2L10 6L6 10', filled: false },
  energy: { label: '에너지', detail: '에너지·공급망', dash: '8 3 2 3', end: 'M0 6L3 3L6 6L3 9Z M7 2L12 6L7 10Z', filled: true },
  tension: { label: '긴장', detail: '외교 긴장', dash: '2.5 4.5', end: 'M3 1L9 6L3 11', filled: false },
  financial: { label: '금융', detail: '금융 스트레스', dash: '8 3 2 2 2 3', end: 'M0 3H5V9H0Z M7 2L12 6L7 10Z', filled: true },
  support: { label: '지지', detail: '외교 지지·동맹', dash: '', end: 'M0 6a3 3 0 1 1 6 0a3 3 0 1 1-6 0 M7 2L12 6L7 10Z', filled: true },
} satisfies Record<ImpactKind, { label: string; detail: string; dash: string; end: string; filled: boolean }>;
export const IMPACT_KINDS = Object.keys(IMPACT_STYLES) as ImpactKind[];
export const COUNTRY_EVENT_LABELS: Partial<Record<ImpactKind, string>> = {
  conflict: '국내 무력 사건',
  energy: '국내 에너지 충격',
  financial: '국내 금융 스트레스',
};

export function isImpactKind(value: string): value is ImpactKind {
  return Object.prototype.hasOwnProperty.call(IMPACT_STYLES, value);
}

type Rgba = [number, number, number, number];
export const PRESSURE_FILL: Record<ThemeName, Rgba[]> = {
  light: [[242, 244, 237, 255], [241, 222, 162, 255], [232, 177, 112, 255], [211, 113, 80, 255], [192, 47, 68, 255]],
  dark: [[42, 55, 51, 255], [94, 78, 40, 255], [134, 88, 43, 255], [157, 66, 35, 255], [166, 34, 54, 255]],
};
export const PRESSURE_RIM: Record<ThemeName, Rgba[]> = {
  light: [[143, 163, 155, 255], [168, 130, 63, 255], [180, 83, 9, 255], [194, 65, 12, 255], [159, 18, 57, 255]],
  dark: [[91, 114, 105, 255], [159, 132, 65, 255], [208, 145, 74, 255], [251, 146, 60, 255], [251, 113, 133, 255]],
};
export const PRESSURE_RIM_WIDTH = [0.7, 0.8, 1.2, 1.7, 2.2];
