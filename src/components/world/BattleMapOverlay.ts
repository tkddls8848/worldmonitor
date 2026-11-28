import { IMPACT_STYLES, type ImpactKind } from '@/config/battle-map';
import { countryEventLabel, countryEventValue, impactCountry, impactDate, impactHeadline, type BattleArc, type BattleCrest, type BattleEventMarker } from '@/services/battle-map-view';
import type { CountryImpactEvent } from '@/services/impact-links';

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

export function impactMark(kind: ImpactKind): SVGPathElement {
  const style = IMPACT_STYLES[kind];
  return svg('path', { d: style.end, fill: style.filled ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 1.4 });
}

type Point = { x: number; y: number };
type Project = (lat: number, lon: number) => Point | null;
const WIDTHS = [1.4, 2.2, 3.2, 4.4];
const BOWS = [0.14, 0.18, 0.21, 0.24];

export function battleCurve(source: Point, target: Point, level: number, offset: number) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  // Always bow to the left of travel, opening opposed arcs in opposite directions.
  const bow = BOWS[level]! + offset;
  const cx = (source.x + target.x) / 2 + dy * bow;
  const cy = (source.y + target.y) / 2 - dx * bow;
  // Keep the transparent hit stroke away from endpoints. A thick stroke
  // reaching a small country can intercept every click on its polygon.
  const t = Math.min(0.3, 14 / Math.max(1, Math.hypot(dx, dy)));
  const at = (start: number, control: number, end: number, fraction: number) =>
    (1 - fraction) ** 2 * start + 2 * (1 - fraction) * fraction * control + fraction ** 2 * end;
  const sx = at(source.x, cx, target.x, t);
  const sy = at(source.y, cy, target.y, t);
  const ex = at(source.x, cx, target.x, 1 - t);
  const ey = at(source.y, cy, target.y, 1 - t);
  const hx = sx + (1 - 2 * t) * ((1 - t) * (cx - source.x) + t * (target.x - cx));
  const hy = sy + (1 - 2 * t) * ((1 - t) * (cy - source.y) + t * (target.y - cy));
  return {
    d: `M${source.x},${source.y}Q${cx},${cy} ${target.x},${target.y}`,
    hit: `M${sx},${sy}Q${hx},${hy} ${ex},${ey}`,
    x: target.x, y: target.y,
    angle: Math.atan2(target.y - cy, target.x - cx) * 180 / Math.PI,
    mx: (source.x + 2 * cx + target.x) / 4, my: (source.y + 2 * cy + target.y) / 4,
  };
}

export class BattleMapOverlay {
  readonly element = svg('svg', { class: 'bm-map-overlay', 'aria-label': '지도 영향선' });
  private markers: Array<(project: Project, worldWidth: number, width: number) => void> = [];
  private frame: number | null = null;

  constructor(private projector: () => Project | null) {}

  setView(arcs: BattleArc[], crests: BattleCrest[], events: BattleEventMarker[], actions: {
    selectLink(arc: BattleArc): void;
    selectCountry(code: string): void;
    selectEvent(event: CountryImpactEvent, trigger: SVGElement): void;
  }): void {
    this.markers = [];
    this.element.replaceChildren();
    const pairOffsets = new Map<string, number>();
    for (const arc of arcs) {
      const key = `${arc.link.actor}:${arc.link.target}`;
      const index = pairOffsets.get(key) ?? 0;
      pairOffsets.set(key, index + 1);
      const { link, kind } = arc;
      const group = svg('g', {
        class: 'bm-arc', 'data-kind': kind, 'data-link-id': link.id,
        role: 'button', tabindex: 0, 'aria-label': impactHeadline(link), opacity: arc.opacity, 'data-undirected': String(link.undirected === true),
      });
      const title = svg('title');
      title.textContent = `${impactHeadline(link)} · 강도 ${link.magnitude} · 자료 기준 ${impactDate(link.lastSeen)} · 근거 ${link.evidence.length}건`;
      const width = WIDTHS[arc.level]! + (arc.emphasized ? 0.8 : 0);
      const hit = svg('path', { class: 'bm-arc-hit', 'stroke-width': Math.max(10, width + 6) });
      const casing = svg('path', { class: 'bm-arc-casing', 'stroke-width': width + 2.4 });
      const core = svg('path', { class: 'bm-arc-core', 'stroke-width': width, 'stroke-dasharray': IMPACT_STYLES[kind].dash || 'none' });
      const tracer = arc.animated ? svg('path', { class: 'bm-arc-tracer', pathLength: 100, 'stroke-width': width + 1 }) : null;
      const mark = link.undirected ? null : impactMark(kind);
      mark?.classList.add('bm-arc-arrow');
      const bundleCount = arc.bundle.length - 1;
      const bundle = bundleCount > 0 && index === 0 ? this.badge(`+${bundleCount}`, 'bm-bundle') : null;
      group.append(title, hit, casing, core, ...(tracer ? [tracer] : []), ...(mark ? [mark] : []), ...(bundle ? [bundle] : []));
      this.activate(group, () => actions.selectLink(arc));
      this.element.append(group);
      this.markers.push((project, worldWidth, mapWidth) => {
        const from = project(arc.from[1], arc.from[0]);
        const to = project(arc.to[1], arc.to[0]);
        if (!from || !to) return;
        // Choose the visible copies of the endpoints so intercontinental links
        // remain connected on the default world view and after panning.
        if (worldWidth > 0) {
          to.x += Math.round((mapWidth / 2 - to.x) / worldWidth) * worldWidth;
          from.x += Math.round((mapWidth / 2 - from.x) / worldWidth) * worldWidth;
        }
        const curve = battleCurve(from, to, arc.level, (index % 4) * 0.08);
        hit.setAttribute('d', curve.hit);
        for (const path of [casing, core, tracer]) path?.setAttribute('d', curve.d);
        const scale = 0.85 + arc.level * 0.15;
        mark?.setAttribute('transform', `translate(${curve.x} ${curve.y}) rotate(${curve.angle}) scale(${scale}) translate(-10 -6)`);
        bundle?.setAttribute('transform', `translate(${curve.mx} ${curve.my})`);
      });
    }
    for (const crest of crests) {
      const node = svg('g', { class: 'bm-crest', opacity: crest.dimmed ? 0.36 : 1 });
      node.append(svg('path', { d: 'M0 -6L6 0L0 6L-6 0Z M2 0a2 2 0 1 1-4 0a2 2 0 1 1 4 0' }));
      if (crest.label) {
        const label = svg('text', { x: 8, y: 3 });
        label.textContent = `${crest.code}↗${crest.count}`;
        node.append(label);
      }
      node.addEventListener('click', () => actions.selectCountry(crest.code));
      this.element.append(node);
      this.markers.push((project) => {
        const point = project(crest.at[1], crest.at[0]);
        if (point) node.setAttribute('transform', `translate(${point.x} ${point.y})`);
      });
    }
    for (const { event, at, offset } of events) {
      const label = `${impactCountry(event.country)} · ${countryEventLabel(event)} · ${countryEventValue(event)}`;
      const node = svg('g', {
        class: 'bm-country-event', 'data-kind': event.kind, 'data-event-id': event.id,
        role: 'button', tabindex: 0, 'aria-label': label,
      });
      const title = svg('title');
      title.textContent = `${label} · 자료 기준 ${impactDate(event.lastSeen)}`;
      const marker = svg('circle', { r: 4 });
      const count = svg('text', { x: 6, y: 3 });
      count.textContent = event.kind === 'conflict' ? String(event.eventCount) : `${event.kind === 'energy' ? '에너지' : '금융'} ${event.magnitude}`;
      node.append(title, svg('circle', { class: 'bm-country-event-hit', r: 8 }), marker, count);
      this.activate(node, () => actions.selectEvent(event, node));
      this.element.append(node);
      this.markers.push((project) => {
        const point = project(at[1], at[0]);
        if (point) node.setAttribute('transform', `translate(${point.x} ${point.y + 11 + offset})`);
      });
    }
    this.reproject();
  }

  private activate(group: SVGGElement, select: () => void): void {
    group.addEventListener('click', select);
    group.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      select();
    });
  }

  private badge(text: string, className: string): SVGGElement {
    const group = svg('g', { class: className });
    const label = svg('text', { 'text-anchor': 'middle', y: 3.5 });
    label.textContent = text;
    group.append(svg('rect', { x: -10, y: -7, width: 20, height: 14, rx: 3 }), label);
    return group;
  }

  reproject(): void {
    if (this.frame !== null || !this.markers.length) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      const project = this.projector();
      if (!project || !this.element.clientWidth) return;
      const width = this.element.clientWidth;
      const worldWidth = Math.abs((project(0, 179.999)?.x ?? 0) - (project(0, -179.999)?.x ?? 0));
      for (const place of this.markers) place(project, worldWidth, width);
    });
  }

  destroy(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.element.remove();
  }
}
