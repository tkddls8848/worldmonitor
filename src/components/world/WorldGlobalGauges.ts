import type { GlobalIndicatorGauge } from '@/types/global-indicators';

export function renderGlobalGauges(section: HTMLElement, gauges: readonly GlobalIndicatorGauge[], title: string): void {
  section.replaceChildren();
  section.hidden = gauges.length === 0;
  if (section.hidden) return;
  section.setAttribute('aria-label', title);
  for (const gauge of gauges) {
    const link = document.createElement('a');
    link.className = 'wfs-ticker-item';
    link.dataset.gauge = gauge.id;
    link.href = gauge.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const label = document.createElement('span');
    label.className = 'wfs-ticker-label';
    label.textContent = gauge.label;
    const level = document.createElement('strong');
    level.className = 'num';
    level.textContent = gauge.value;
    const period = document.createElement('span');
    period.className = 'wfs-ticker-label';
    period.textContent = gauge.period;
    link.append(label, level, period);
    section.append(link);
  }
}
