/**
 * Left-rail summary card for the Route Explorer. Always visible across
 * all tabs, shows transit/freight/risk at a glance plus the destination
 *
 * Sprint 3: route summary and risk.
 * Sprint 4 will add dependency flags from get-route-impact.
 */

import type { GetRouteExplorerLaneResponse, DependencyFlag } from '@/generated/server/worldmonitor/supply_chain/v1/service_server';
import {
  formatTransitRange,
  formatFreightRange,
  formatDisruptionScore,
  disruptionScoreClass,
  warRiskTierLabel,
  warRiskTierClass,
  escapeHtml,
} from '../tabs/route-utils';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';


export class LeftRail {
  public readonly element: HTMLElement;

  constructor() {
    this.element = document.createElement('aside');
    this.element.className = 're-leftrail';
    this.element.setAttribute('aria-label', 'Lane summary');
    this.renderPlaceholder();
  }

  public updateLane(data: GetRouteExplorerLaneResponse | null, mode?: 'loading' | 'error'): void {
    if (mode === 'loading') { this.renderLoading(); return; }
    if (mode === 'error') { this.renderError(); return; }
    if (!data || data.noModeledLane) { this.renderNoLane(); return; }
    this.renderSummary(data);
  }

  private renderPlaceholder(): void {
    setTrustedHtml(this.element, trustedHtml('<div class="re-leftrail__placeholder">Pick a country pair and product to see the lane summary.</div>', "legacy direct innerHTML migration"));
  }

  private renderNoLane(): void {
    setTrustedHtml(this.element, trustedHtml('<div class="re-leftrail__empty">No modeled lane for this pair.</div>', "legacy direct innerHTML migration"));
  }

  private renderLoading(): void {
    setTrustedHtml(this.element, trustedHtml('<div class="re-leftrail__placeholder">Loading lane data\u2026</div>', "legacy direct innerHTML migration"));
  }

  private renderError(): void {
    setTrustedHtml(this.element, trustedHtml('<div class="re-leftrail__empty">Failed to load lane data.</div>', "legacy direct innerHTML migration"));
  }

  private static readonly FLAG_LABELS: Record<string, string> = {
    DEPENDENCY_FLAG_SINGLE_SOURCE_CRITICAL: 'Single Source Critical',
    DEPENDENCY_FLAG_SINGLE_CORRIDOR_CRITICAL: 'Single Corridor Critical',
    DEPENDENCY_FLAG_COMPOUND_RISK: 'Compound Risk',
    DEPENDENCY_FLAG_DIVERSIFIABLE: 'Diversifiable',
  };

  public updateDependencyFlags(flags: DependencyFlag[]): void {
    const el = this.element.querySelector('.re-leftrail__card--flags');
    if (!el) return;
    if (flags.length === 0) {
      setTrustedHtml(el, trustedHtml('<h3 class="re-leftrail__title">Dependency Flags</h3><div class="re-leftrail__placeholder-text">No critical dependencies identified</div>', "legacy direct innerHTML migration"));
      return;
    }
    const flagHtml = flags.map((f) =>
      `<span class="re-leftrail__flag re-leftrail__flag--${f.toLowerCase().replace(/^dependency_flag_/, '')}">${escapeHtml(LeftRail.FLAG_LABELS[f] ?? f)}</span>`,
    ).join('');
    setTrustedHtml(el, trustedHtml(`<h3 class="re-leftrail__title">Dependency Flags</h3><div class="re-leftrail__flags">${flagHtml}</div>`, "legacy direct innerHTML migration"));
  }

  private renderSummary(data: GetRouteExplorerLaneResponse): void {
    const riskCls = warRiskTierClass(data.warRiskTier);
    const disruptCls = disruptionScoreClass(data.disruptionScore);

    setTrustedHtml(this.element, trustedHtml([
      '<div class="re-leftrail__card">',
      '  <h3 class="re-leftrail__title">Route Summary</h3>',
      '  <div class="re-leftrail__row">',
      '    <span class="re-leftrail__label">Transit</span>',
      `    <span class="re-leftrail__value">${formatTransitRange(data.estTransitDaysRange)}</span>`,
      '  </div>',
      '  <div class="re-leftrail__row">',
      '    <span class="re-leftrail__label">Freight (est.)</span>',
      `    <span class="re-leftrail__value">${formatFreightRange(data.estFreightUsdPerTeuRange, data.cargoType)}</span>`,
      '  </div>',
      '  <div class="re-leftrail__row">',
      '    <span class="re-leftrail__label">War Risk</span>',
      `    <span class="re-leftrail__value ${riskCls}">${escapeHtml(warRiskTierLabel(data.warRiskTier))}</span>`,
      '  </div>',
      '  <div class="re-leftrail__row">',
      '    <span class="re-leftrail__label">Disruption</span>',
      `    <span class="re-leftrail__value ${disruptCls}">${formatDisruptionScore(data.disruptionScore)}</span>`,
      '  </div>',
      '</div>',
      '<div class="re-leftrail__card re-leftrail__card--flags">',
      '  <h3 class="re-leftrail__title">Dependency Flags</h3>',
      '  <div class="re-leftrail__placeholder-text">Available in Sprint 4 (Impact tab)</div>',
      '</div>',
    ].join('\n'), "legacy direct innerHTML migration"));
  }
}
