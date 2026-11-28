import type { ThemeName } from '@/types/world-overview';
import type { IMPACT_KINDS as API_IMPACT_KINDS } from '../../shared/impact-links';

export type ImpactKind = typeof API_IMPACT_KINDS[number];

// Arrow paths in a 12×12 box, facing right. The map and key share the same marks.
export const IMPACT_STYLES = {
  conflict: { label: '충돌', detail: '무력 충돌', dark: '#f43f5e', light: '#be123c', dash: '', end: 'M1 1L12 6L1 11L4 6Z', filled: true },
  sanctions: { label: '제재', detail: '제재·수출통제', dark: '#f59e0b', light: '#b45309', dash: '10 5', end: 'M1 2L8 6L1 10Z M11 1V11', filled: true },
  tariffs: { label: '관세', detail: '관세·무역조치', dark: '#38bdf8', light: '#0369a1', dash: '4 3 9 3', end: 'M1 2L5 6L1 10 M6 2L10 6L6 10', filled: false },
  energy: { label: '에너지', detail: '에너지·공급망', dark: '#a3e635', light: '#4d7c0f', dash: '8 3 2 3', end: 'M0 6L3 3L6 6L3 9Z M7 2L12 6L7 10Z', filled: true },
  tension: { label: '긴장', detail: '외교 긴장', dark: '#f472b6', light: '#be185d', dash: '2.5 4.5', end: 'M3 1L9 6L3 11', filled: false },
  financial: { label: '금융', detail: '금융 스트레스', dark: '#a78bfa', light: '#6d28d9', dash: '8 3 2 2 2 3', end: 'M0 3H5V9H0Z M7 2L12 6L7 10Z', filled: true },
  support: { label: '지지', detail: '외교 지지·동맹', dark: '#2dd4bf', light: '#0f766e', dash: '', end: 'M0 6a3 3 0 1 1 6 0a3 3 0 1 1-6 0 M7 2L12 6L7 10Z', filled: true },
} satisfies Record<ImpactKind, { label: string; detail: string; dark: string; light: string; dash: string; end: string; filled: boolean }>;
export const IMPACT_KINDS = Object.keys(IMPACT_STYLES) as ImpactKind[];

export function isImpactKind(value: string): value is ImpactKind {
  return Object.prototype.hasOwnProperty.call(IMPACT_STYLES, value);
}

type Rgba = [number, number, number, number];
export const PRESSURE_FILL: Record<ThemeName, Rgba[]> = {
  light: [[242, 244, 239, 255], [220, 229, 223, 255], [236, 214, 158, 255], [223, 138, 82, 255], [192, 47, 68, 255]],
  dark: [[21, 28, 25, 255], [31, 45, 39, 255], [88, 68, 32, 255], [140, 59, 28, 255], [166, 34, 54, 255]],
};
export const PRESSURE_RIM: Record<ThemeName, Rgba[]> = {
  light: [[180, 192, 188, 255], [180, 192, 188, 255], [180, 83, 9, 255], [194, 65, 12, 255], [159, 18, 57, 255]],
  dark: [[11, 14, 13, 255], [11, 14, 13, 255], [184, 135, 43, 255], [251, 146, 60, 255], [251, 113, 133, 255]],
};
export const PRESSURE_RIM_WIDTH = [0.7, 0.8, 1.2, 1.7, 2.2];
