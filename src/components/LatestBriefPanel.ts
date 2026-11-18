/**
 * LatestBriefPanel — dashboard surface for the WorldMonitor Brief.
 *
 * Reads `/api/latest-brief` and renders one of three states:
 *
 *   - ready      → cover-card thumbnail + greeting + thread count +
 *                  "Read brief →" CTA that opens the signed magazine
 *                  URL in a new tab.
 *   - composing  → soft empty state. The composer hasn't produced
 *                  today's brief yet; the panel auto-refreshes on
 *                  the next user-visible interaction.
 *
 * The signed URL is generated server-side in `api/latest-brief.ts`
 * so the token never lives in the client bundle. The panel only
 * displays + links to it.
 */

import { Panel } from './Panel';
import { trackBriefThreadOpen } from '@/services/analytics';
import { h, rawHtml, replaceChildren, clearChildren, trustedHtml, type TrustedHtml } from '@/utils/dom-utils';

interface LatestBriefReady {
  status: 'ready';
  issueDate: string;
  dateLong: string;
  greeting: string;
  threadCount: number;
  magazineUrl: string;
}

interface LatestBriefComposing {
  status: 'composing';
  issueDate: string;
}

type LatestBriefResponse = LatestBriefReady | LatestBriefComposing;

const LATEST_BRIEF_ENDPOINT = '/api/latest-brief';

const WM_LOGO_SVG: TrustedHtml = trustedHtml(
  (
    '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" aria-hidden="true">'
    + '<circle cx="32" cy="32" r="28"/>'
    + '<ellipse cx="32" cy="32" rx="5" ry="28"/>'
    + '<ellipse cx="32" cy="32" rx="14" ry="28"/>'
    + '<ellipse cx="32" cy="32" rx="22" ry="28"/>'
    + '<ellipse cx="32" cy="32" rx="28" ry="5"/>'
    + '<ellipse cx="32" cy="32" rx="28" ry="14"/>'
    + '<path d="M 6 32 L 20 32 L 24 24 L 30 40 L 36 22 L 42 38 L 46 32 L 56 32" stroke-width="2.4"/>'
    + '<circle cx="57" cy="32" r="1.8" fill="currentColor" stroke="none"/>'
    + '</svg>'
  ),
  'Static WorldMonitor logo SVG defined in source',
);

// Composing-state poll interval. 60s balances "responsive when the
// composer finishes between digest ticks" against "don't hammer
// Upstash with 401-path checks from backgrounded tabs".
const COMPOSING_POLL_MS = 60_000;

export class LatestBriefPanel extends Panel {
  private refreshing = false;
  private refreshQueued = false;
  private inflightAbort: AbortController | null = null;
  private composingPollId: ReturnType<typeof setTimeout> | null = null;
  private onVisibility: (() => void) | null = null;

  constructor() {
    super({
      id: 'latest-brief',
      title: 'Latest Brief',
      infoTooltip:
        "Your personalised daily editorial magazine. One brief per day, assembled from the news-intelligence layer and delivered via email, Telegram, Slack, and here.",
    });

    this.renderLoading();
    // visibilitychange drives a refresh when the user returns to
    // the tab. Addresses the "composing → stays composing forever"
    // case where the composer completed while the tab was hidden.
    this.onVisibility = () => {
      if (document.visibilityState === 'visible') void this.refresh();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    void this.refresh();
  }

  /**
   * Called by the dashboard when the panel first mounts or is
   * revisited. A refresh while one is already in flight queues a
   * single follow-up pass instead of being silently dropped — the
   * user-facing state always reflects the most recent intent
   * (e.g. retry after error, fresh fetch after a visibility change).
   */
  public async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    if (!this.element.isConnected) {
      this.runWhenConnected(() => { void this.refresh(); });
      return;
    }
    this.clearComposingPoll();
    this.refreshing = true;
    const controller = new AbortController();
    this.inflightAbort = controller;
    try {
      const data = await this.fetchLatest(controller.signal);
      this.clearErrorState();
      if (data.status === 'ready') {
        this.renderReady(data);
      } else {
        this.renderComposing(data);
      }
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
      const message = err instanceof Error ? err.message : 'Brief unavailable — try again shortly.';
      this.showError(message, () => { void this.refresh(); });
    } finally {
      this.refreshing = false;
      this.inflightAbort = null;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  private async fetchLatest(signal: AbortSignal): Promise<LatestBriefResponse> {
    // The personal server always answers with the owner's brief.
    const res = await fetch(LATEST_BRIEF_ENDPOINT, { signal });
    if (!res.ok) {
      throw new Error(`Brief service unavailable (${res.status})`);
    }
    const body = (await res.json()) as LatestBriefResponse;
    if (!body || (body.status !== 'ready' && body.status !== 'composing')) {
      throw new Error('Unexpected response from brief service');
    }
    return body;
  }

  private renderLoading(): void {
    clearChildren(this.content);
    this.content.appendChild(
      h('div', { className: 'latest-brief-empty' },
        h('div', { className: 'latest-brief-empty-title' }, 'Loading your brief…'),
      ),
    );
  }

  private scheduleComposingPoll(): void {
    this.clearComposingPoll();
    this.composingPollId = setTimeout(() => {
      this.composingPollId = null;
      void this.refresh();
    }, COMPOSING_POLL_MS);
  }

  private clearComposingPoll(): void {
    if (this.composingPollId !== null) {
      clearTimeout(this.composingPollId);
      this.composingPollId = null;
    }
  }

  private renderComposing(data: LatestBriefComposing): void {
    // setContentNodes below replaces all content — no manual clear needed.
    // While we're stuck on composing, re-poll every minute so the
    // panel transitions to ready on the next cron tick without
    // requiring a full page reload.
    this.scheduleComposingPoll();
    // h()'s applyProps has no special-case for innerHTML — passing
    // it as a prop sets a literal DOM attribute named "innerHTML"
    // rather than parsing HTML. Use rawHtml() which returns a
    // DocumentFragment.
    const logoDiv = h('div', { className: 'latest-brief-logo' });
    logoDiv.appendChild(rawHtml(WM_LOGO_SVG));
    this.setContentNodes(
      h('div', { className: 'latest-brief-card latest-brief-card--composing' },
        logoDiv,
        h('div', { className: 'latest-brief-empty-title' }, 'Your brief is composing.'),
        h('div', { className: 'latest-brief-empty-body' },
          `The editorial team at WorldMonitor is writing your ${data.issueDate} brief. Check back in a moment.`,
        ),
      ),
    );
  }

  private renderReady(data: LatestBriefReady): void {
    const threadLabel = data.threadCount === 1 ? '1 thread' : `${data.threadCount} threads`;

    const coverLogo = h('div', { className: 'latest-brief-cover-logo' });
    coverLogo.appendChild(rawHtml(WM_LOGO_SVG));

    const coverCard = h('a', {
      className: 'latest-brief-card latest-brief-card--ready',
      href: data.magazineUrl,
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': `Open today's brief — ${threadLabel}`,
      // U11 telemetry: dashboard → magazine pull-through. The cover
      // card is the panel's only click site; the per-story `country` /
      // `severity` properties are only meaningful inside the magazine
      // (which has its own per-story tracker), so the dashboard event
      // carries nulls for those and `source: 'dashboard'`.
      onclick: () => {
        try {
          trackBriefThreadOpen({
            country: null,
            followed: false,
            severity: null,
            source: 'dashboard',
          });
        } catch {
          // Analytics outage must NOT break the click — the anchor
          // navigates regardless of this handler.
        }
      },
    },
      h('div', { className: 'latest-brief-cover' },
        coverLogo,
        h('div', { className: 'latest-brief-cover-issue' }, data.dateLong),
        h('div', { className: 'latest-brief-cover-title' }, 'WorldMonitor'),
        h('div', { className: 'latest-brief-cover-title' }, 'Brief.'),
        h('div', { className: 'latest-brief-cover-kicker' }, threadLabel),
      ),
      h('div', { className: 'latest-brief-meta' },
        h('div', { className: 'latest-brief-greeting' }, data.greeting),
        h('div', { className: 'latest-brief-cta' }, 'Read brief →'),
      ),
    );

    replaceChildren(this.content, coverCard);
  }

  public override destroy(): void {
    this.clearComposingPoll();
    this.inflightAbort?.abort();
    this.inflightAbort = null;
    if (this.onVisibility) {
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.onVisibility = null;
    }
    super.destroy();
  }
}
