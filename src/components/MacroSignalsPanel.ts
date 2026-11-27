import { Panel } from './Panel';
import { createLazyClient, getRpcBaseUrl, rpcFetch } from '@/services/rpc-client';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import { t } from '@/services/i18n';

import type { GetMacroSignalsResponse } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { getHydratedData } from '@/services/bootstrap';
import { EconomicServiceClient } from '@/services/generated-rpc-clients';

interface MacroSignalData {
  timestamp: string;
  verdict: string;
  bullishCount: number;
  totalCount: number;
  signals: {
    liquidity: { status: string; value: number | null; sparkline: number[] };
    macroRegime: { status: string; qqqRoc20: number | null; xlpRoc20: number | null };
  };
  meta: { qqqSparkline: number[]; qqqReturn5: number | null };
  unavailable?: boolean;
}

const getEconomicClient = createLazyClient(() => new EconomicServiceClient(getRpcBaseUrl(), { fetch: rpcFetch }));

/** Map proto response (optional fields = undefined) to MacroSignalData (null for absent values). */
function mapProtoToData(r: GetMacroSignalsResponse): MacroSignalData {
  const s = r.signals;
  return {
    timestamp: r.timestamp,
    verdict: r.verdict,
    bullishCount: r.bullishCount,
    totalCount: r.totalCount,
    signals: {
      liquidity: {
        status: s?.liquidity?.status ?? 'UNKNOWN',
        value: s?.liquidity?.value ?? null,
        sparkline: s?.liquidity?.sparkline ?? [],
      },
      macroRegime: {
        status: s?.macroRegime?.status ?? 'UNKNOWN',
        qqqRoc20: s?.macroRegime?.qqqRoc20 ?? null,
        xlpRoc20: s?.macroRegime?.xlpRoc20 ?? null,
      },
    },
    meta: { qqqSparkline: r.meta?.qqqSparkline ?? [], qqqReturn5: r.meta?.qqqReturn5 ?? null },
    unavailable: r.unavailable,
  };
}

function sparklineSvg(data: number[], width = 80, height = 24, color = '#4fc3f7'): string {
  if (!data || data.length < 2) return '';
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="signal-sparkline" aria-hidden="true"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function statusBadgeClass(status: string): string {
  const s = status.toUpperCase();
  if (['BULLISH', 'RISK-ON', 'GROWING', 'PROFITABLE', 'ALIGNED', 'NORMAL', 'EXTREME GREED', 'GREED'].includes(s)) return 'badge-bullish';
  if (['BEARISH', 'DEFENSIVE', 'DECLINING', 'SQUEEZE', 'PASSIVE GAP', 'EXTREME FEAR', 'FEAR'].includes(s)) return 'badge-bearish';
  return 'badge-neutral';
}

function formatNum(v: number | null, suffix = '%'): string {
  if (v === null) return 'N/A';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}${suffix}`;
}

export class MacroSignalsPanel extends Panel {
  private data: MacroSignalData | null = null;
  private loading = true;
  private error: string | null = null;
  private lastTimestamp = '';

  constructor() {
    super({ id: 'macro-signals', title: t('panels.macroSignals'), showCount: false, infoTooltip: t('components.macroSignals.infoTooltip') });
  }

  public async fetchData(): Promise<boolean> {
    const hydrated = getHydratedData('macroSignals') as GetMacroSignalsResponse | undefined;
    if (hydrated?.signals && hydrated.totalCount > 0) {
      this.data = mapProtoToData(hydrated);
      this.lastTimestamp = this.data.timestamp;
      this.error = null;
      this.loading = false;
      this.renderPanel();
      void this.refreshFromRpc();
      return true;
    }
    return this.refreshFromRpc();
  }

  private async refreshFromRpc(): Promise<boolean> {
    try {
      const res = await getEconomicClient().getMacroSignals({});
      if (!this.element?.isConnected) return false;
      this.data = mapProtoToData(res);
      this.error = null;
    } catch (err) {
      if (this.isAbortError(err)) return false;
      if (!this.element?.isConnected) return false;
      if (!this.data) {
        console.warn('[MacroSignals] Fetch error:', err);
        this.error = t('common.noDataShort');
      } else {
        return false;
      }
    }
    this.loading = false;
    this.renderPanel();
    const ts = this.data?.timestamp ?? '';
    const changed = ts !== this.lastTimestamp;
    this.lastTimestamp = ts;
    return changed;
  }

  private renderPanel(): void {
    if (this.loading) {
      this.showLoading(t('common.computingSignals'));
      return;
    }

    if (this.error || !this.data) {
      this.showError(this.error || t('common.noDataShort'), () => void this.fetchData());
      return;
    }

    if (this.data.unavailable) {
      this.showError(t('common.upstreamUnavailable'), () => void this.fetchData());
      return;
    }

    const d = this.data;
    const s = d.signals;

    const verdictClass = d.verdict === 'BUY' ? 'verdict-buy' : d.verdict === 'CASH' ? 'verdict-cash' : 'verdict-unknown';

    const html = `
      <div class="macro-signals-container">
        <div class="macro-verdict ${verdictClass}">
          <span class="verdict-label">${t('components.macroSignals.overall')}</span>
          <span class="verdict-value">${d.verdict === 'BUY' ? t('components.macroSignals.verdict.buy') : d.verdict === 'CASH' ? t('components.macroSignals.verdict.cash') : escapeHtml(d.verdict)}</span>
          <span class="verdict-detail">${t('components.macroSignals.bullish', { count: String(d.bullishCount), total: String(d.totalCount) })}</span>
        </div>
        <div class="signals-grid">
          ${this.renderSignalCard(t('components.macroSignals.signals.liquidity'), s.liquidity.status, formatNum(s.liquidity.value), sparklineSvg(s.liquidity.sparkline, 60, 20, '#4fc3f7'), 'JPY 30d ROC', 'https://www.tradingview.com/symbols/JPYUSD/')}
          ${this.renderSignalCard(t('components.macroSignals.signals.regime'), s.macroRegime.status, `QQQ ${formatNum(s.macroRegime.qqqRoc20)} / XLP ${formatNum(s.macroRegime.xlpRoc20)}`, sparklineSvg(d.meta.qqqSparkline, 60, 20, '#ab47bc'), `20d ROC · QQQ 5d: ${formatNum(d.meta.qqqReturn5)}`, 'https://www.tradingview.com/symbols/QQQ/')}
        </div>
      </div>
    `;

    this.setSafeContent(unsafeRawHtml(html, 'legacy Panel.setContent() migration'));
  }

  private renderSignalCard(name: string, status: string, value: string, sparkline: string, detail: string, link: string | null): string {
    const badgeClass = statusBadgeClass(status);
    return `
      <div class="signal-card${link ? ' signal-card-linked' : ''}">
        <div class="signal-header">
          ${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener" class="signal-name signal-card-link">${escapeHtml(name)}</a>` : `<span class="signal-name">${escapeHtml(name)}</span>`}
          <span class="signal-badge ${badgeClass}">${escapeHtml(status)}</span>
        </div>
        <div class="signal-body">
          ${sparkline ? `<div class="signal-sparkline-wrap">${sparkline}</div>` : ''}
          ${value ? `<span class="signal-value">${value}</span>` : ''}
        </div>
        ${detail ? `<div class="signal-detail">${escapeHtml(detail)}</div>` : ''}
      </div>
    `;
  }

}
