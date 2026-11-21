import type { BottomTrayPanelId } from '@/config/inspector-domains';

export interface BottomMediaTrayCallbacks {
  onRequestPanelElement: (panelId: BottomTrayPanelId) => Promise<HTMLElement | null>;
  onReleasePanelElement: (panelId: BottomTrayPanelId, el: HTMLElement) => void;
  onToggleWideGrid: () => boolean;
  onOpenTabsManager: () => void;
}

function isKo(): boolean {
  return typeof document !== 'undefined' && document.documentElement.lang?.startsWith('ko');
}

/**
 * Collapsible 34px bottom dock bar & slide-up tray for heavy media / assistant
 * panels (Live News, Live Webcams, WM AI Analyst) and multi-column grid toggle.
 * Stays collapsed on first load so live streams never hijack the initial screen.
 */
export class BottomMediaTray {
  private readonly root: HTMLElement;
  private readonly drawer: HTMLElement;
  private readonly drawerTitle: HTMLElement;
  private readonly drawerBody: HTMLElement;
  private readonly wideGridBtn: HTMLButtonElement;
  private readonly triggerButtons = new Map<BottomTrayPanelId, HTMLButtonElement>();
  private activePanelId: BottomTrayPanelId | null = null;
  private hostedEl: HTMLElement | null = null;
  private maximized = false;
  private readonly callbacks: BottomMediaTrayCallbacks;
  private readonly boundOpenEvent: (e: Event) => void;
  private readonly boundKeydown: (e: KeyboardEvent) => void;

  constructor(callbacks: BottomMediaTrayCallbacks) {
    this.callbacks = callbacks;

    this.root = document.createElement('div');
    this.root.className = 'bottom-media-tray';
    this.root.id = 'bottomMediaTray';

    // Slide-up drawer (hidden by default)
    this.drawer = document.createElement('section');
    this.drawer.className = 'bottom-tray-drawer';
    this.drawer.setAttribute('aria-label', isKo() ? '미디어 및 확장 트레이' : 'Media and tool tray');
    this.drawer.hidden = true;

    const drawerHeader = document.createElement('div');
    drawerHeader.className = 'bottom-tray-drawer-header';

    this.drawerTitle = document.createElement('span');
    this.drawerTitle.className = 'bottom-tray-drawer-title';

    const drawerActions = document.createElement('div');
    drawerActions.className = 'bottom-tray-drawer-actions';

    const maxBtn = document.createElement('button');
    maxBtn.type = 'button';
    maxBtn.className = 'bottom-tray-action-btn';
    maxBtn.textContent = '⛶';
    maxBtn.title = isKo() ? '트레이 크게 보기' : 'Expand tray';
    maxBtn.setAttribute('aria-label', maxBtn.title);
    maxBtn.addEventListener('click', () => {
      this.maximized = !this.maximized;
      this.drawer.classList.toggle('maximized', this.maximized);
      window.dispatchEvent(new Event('resize'));
    });

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'bottom-tray-action-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = isKo() ? '트레이 닫기' : 'Close tray';
    closeBtn.setAttribute('aria-label', closeBtn.title);
    closeBtn.addEventListener('click', () => this.close());

    drawerActions.append(maxBtn, closeBtn);
    drawerHeader.append(this.drawerTitle, drawerActions);

    this.drawerBody = document.createElement('div');
    this.drawerBody.className = 'bottom-tray-drawer-body';

    this.drawer.append(drawerHeader, this.drawerBody);

    // Compact 34px dock bar
    const bar = document.createElement('div');
    bar.className = 'bottom-tray-bar';

    const leftGroup = document.createElement('div');
    leftGroup.className = 'bottom-tray-triggers';

    const triggers: Array<{ id: BottomTrayPanelId; icon: string; labelKo: string; labelEn: string }> = [
      { id: 'live-news', icon: '📺', labelKo: '실시간 뉴스', labelEn: 'Live News' },
      { id: 'live-webcams', icon: '📷', labelKo: '라이브 웹캠', labelEn: 'Live Webcams' },
      { id: 'chat-analyst', icon: '💬', labelKo: 'AI 애널리스트', labelEn: 'AI Analyst' },
    ];

    const ko = isKo();
    for (const item of triggers) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bottom-tray-trigger';
      btn.dataset.trayPanel = item.id;
      btn.setAttribute('aria-expanded', 'false');
      const iconSpan = document.createElement('span');
      iconSpan.setAttribute('aria-hidden', 'true');
      iconSpan.textContent = item.icon;
      const textSpan = document.createElement('span');
      textSpan.textContent = ko ? item.labelKo : item.labelEn;
      btn.append(iconSpan, textSpan);
      btn.addEventListener('click', () => {
        if (this.activePanelId === item.id) {
          this.close();
        } else {
          void this.open(item.id, ko ? item.labelKo : item.labelEn);
        }
      });
      this.triggerButtons.set(item.id, btn);
      leftGroup.appendChild(btn);
    }

    const tabsBtn = document.createElement('button');
    tabsBtn.type = 'button';
    tabsBtn.className = 'bottom-tray-trigger bottom-tray-secondary';
    tabsBtn.id = 'bottomTrayTabsBtn';
    const tabsIcon = document.createElement('span');
    tabsIcon.setAttribute('aria-hidden', 'true');
    tabsIcon.textContent = '📑';
    const tabsLabel = document.createElement('span');
    tabsLabel.textContent = ko ? '내 탭 · 전체 패널' : 'Tabs · All Panels';
    tabsBtn.append(tabsIcon, tabsLabel);
    tabsBtn.addEventListener('click', () => this.callbacks.onOpenTabsManager());
    leftGroup.appendChild(tabsBtn);

    this.wideGridBtn = document.createElement('button');
    this.wideGridBtn.type = 'button';
    this.wideGridBtn.className = 'bottom-tray-trigger bottom-tray-secondary';
    this.wideGridBtn.id = 'bottomTrayWideGridBtn';
    this.wideGridBtn.setAttribute('aria-pressed', 'false');
    const gridIcon = document.createElement('span');
    gridIcon.setAttribute('aria-hidden', 'true');
    gridIcon.textContent = '⊞';
    const gridLabel = document.createElement('span');
    gridLabel.textContent = ko ? '다열 격자' : 'Multi-Col Grid';
    this.wideGridBtn.append(gridIcon, gridLabel);
    this.wideGridBtn.addEventListener('click', () => {
      const wide = this.callbacks.onToggleWideGrid();
      this.wideGridBtn.classList.toggle('active', wide);
      this.wideGridBtn.setAttribute('aria-pressed', String(wide));
    });
    leftGroup.appendChild(this.wideGridBtn);

    bar.append(leftGroup);
    this.root.append(this.drawer, bar);

    this.boundOpenEvent = (e: Event) => {
      const panelId = (e as CustomEvent<{ panelId?: BottomTrayPanelId }>).detail?.panelId;
      if (!panelId) return;
      const meta = triggers.find((t) => t.id === panelId);
      if (!meta) return;
      void this.open(panelId, isKo() ? meta.labelKo : meta.labelEn);
    };
    window.addEventListener('wm:open-tray-panel', this.boundOpenEvent);

    this.boundKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.activePanelId) {
        this.close();
      }
    };
    document.addEventListener('keydown', this.boundKeydown);
  }

  public getElement(): HTMLElement {
    return this.root;
  }

  public getActivePanelId(): BottomTrayPanelId | null {
    return this.activePanelId;
  }

  public async open(panelId: BottomTrayPanelId, title: string): Promise<void> {
    if (this.activePanelId && this.activePanelId !== panelId) {
      this.releaseHosted();
    }
    this.activePanelId = panelId;
    this.drawerTitle.textContent = title;
    this.drawer.hidden = false;
    this.syncTriggerStates();

    const el = await this.callbacks.onRequestPanelElement(panelId);
    if (this.activePanelId !== panelId) return;
    if (!el) {
      this.close();
      return;
    }
    this.hostedEl = el;
    el.classList.remove('inspector-tab-hidden', 'hidden');
    el.classList.add('tray-hosted-panel');
    this.drawerBody.replaceChildren(el);
    window.dispatchEvent(new Event('resize'));
  }

  public close(): void {
    this.releaseHosted();
    this.activePanelId = null;
    this.maximized = false;
    this.drawer.classList.remove('maximized');
    this.drawer.hidden = true;
    this.syncTriggerStates();
    window.dispatchEvent(new Event('resize'));
  }

  public destroy(): void {
    this.releaseHosted();
    window.removeEventListener('wm:open-tray-panel', this.boundOpenEvent);
    document.removeEventListener('keydown', this.boundKeydown);
    this.root.remove();
  }

  private releaseHosted(): void {
    if (this.activePanelId && this.hostedEl) {
      this.hostedEl.classList.remove('tray-hosted-panel');
      this.callbacks.onReleasePanelElement(this.activePanelId, this.hostedEl);
    }
    this.hostedEl = null;
    this.drawerBody.replaceChildren();
  }

  private syncTriggerStates(): void {
    for (const [id, btn] of this.triggerButtons) {
      const active = this.activePanelId === id;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-expanded', String(active));
    }
  }
}
