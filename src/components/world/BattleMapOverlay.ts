import { IMPACT_STYLES, type ImpactKind } from '@/config/battle-map';
import { battleStoryLabel, countryEventLabel, countryEventValue, impactCountry, impactDate, impactHeadline, type BattleArc, type BattleCountryLabel, type BattleCrest, type BattleEventMarker } from '@/services/battle-map-view';
import type { CountryImpactEvent } from '@/services/impact-links';
import { nearestWorldCopy, visibleWorldCopies } from '../map/world-copies';

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
type Box = { x: number; y: number; width: number; height: number };
type Project = (lat: number, lon: number) => Point | null;
type Projection = { project: Project; width: number; period: number };
type PlaceLabel = (label: MapLabel, points: Point[]) => (Point & { index: number }) | null;
const WIDTHS = [1.4, 2.2, 3.2, 4.4];
const BOWS = [0.14, 0.18, 0.21, 0.24];

export function battleCurve(source: Point, target: Point, level: number, offset: number, reciprocal = false) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  // Always bow to the left of travel, opening opposed arcs in opposite directions.
  const bow = BOWS[level]! + (offset + (reciprocal ? 14 : 0)) / length;
  const cx = (source.x + target.x) / 2 + dy * bow;
  const cy = (source.y + target.y) / 2 - dx * bow;
  // Keep the transparent hit stroke away from endpoints. A thick stroke
  // reaching a small country can intercept every click on its polygon.
  const t = Math.min(0.3, 14 / length);
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
    left: Math.min(source.x, cx, target.x),
    right: Math.max(source.x, cx, target.x),
    angle: Math.atan2(target.y - cy, target.x - cx) * 180 / Math.PI,
    pointAt: (position: number) => ({ x: at(source.x, cx, target.x, position), y: at(source.y, cy, target.y, position) }),
  };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width + 3 && a.x + a.width + 3 > b.x
    && a.y < b.y + b.height + 3 && a.y + a.height + 3 > b.y;
}

interface MapLabel {
  node: SVGGElement;
  text: SVGTextElement;
  background: SVGRectElement;
}

/** Reuse the primary nodes and mount extra nodes only when their geometry reaches the viewport. */
function repeated<T extends { nodes: SVGElement[] }>(parent: SVGElement, create: (primary: boolean) => T) {
  const copies = [create(true)];
  parent.append(...copies[0]!.nodes);
  let mounted = 1;
  return ({ width, period }: Projection, left: number, right: number, draw: (copy: T, dx: number) => void): void => {
    const center = (left + right) / 2;
    const primary = nearestWorldCopy(center, width / 2, period) - center;
    draw(copies[0]!, primary);
    const offsets = visibleWorldCopies(left + primary, right + primary, width, period).filter((offset) => offset !== 0);
    for (const [index, offset] of offsets.entries()) {
      const copy = copies[index + 1] ?? (copies[index + 1] = create(false));
      if (index + 1 >= mounted) parent.append(...copy.nodes);
      draw(copy, primary + offset * period);
    }
    for (let index = offsets.length + 1; index < mounted; index++) {
      for (const node of copies[index]!.nodes) node.remove();
    }
    mounted = offsets.length + 1;
  };
}

export class BattleMapOverlay {
  readonly element = svg('svg', { class: 'bm-map-overlay', 'aria-label': '지도 영향선' });
  private markers: Array<(projection: Projection) => void> = [];
  private labels: Array<(projection: Projection, place: PlaceLabel) => void> = [];
  private highlightedId: string | null = null;
  private resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.reproject());
  private frame: number | null = null;

  constructor(private projector: () => Project | null) {
    this.resize?.observe(this.element);
  }

  setView(arcs: BattleArc[], countries: BattleCountryLabel[], crests: BattleCrest[], events: BattleEventMarker[], stories: boolean, actions: {
    selectLink(arc: BattleArc): void;
    selectCountry(code: string): void;
    selectEvent(event: CountryImpactEvent, trigger: SVGElement): void;
  }): void {
    this.markers = [];
    this.labels = [];
    this.element.replaceChildren();
    const pairOffsets = new Map<string, number>();
    const pairs = new Set(arcs.map(({ link }) => `${link.actor}:${link.target}`));
    const storyPlacements: typeof this.labels = [];
    const arcsLayer = svg('g');
    const markersLayer = svg('g');
    const storiesLayer = svg('g');
    this.element.append(arcsLayer, markersLayer);
    for (const arc of arcs) {
      const key = `${arc.link.actor}:${arc.link.target}`;
      const index = pairOffsets.get(key) ?? 0;
      pairOffsets.set(key, index + 1);
      const { link, kind } = arc;
      const width = WIDTHS[arc.level]! + (stories ? 1.6 : 0) + (arc.emphasized ? 0.8 : 0);
      const reciprocal = pairs.has(`${link.target}:${link.actor}`);
      const drawArc = repeated(arcsLayer, (primary) => {
        const group = svg('g', {
          class: 'bm-arc', 'data-kind': kind, 'data-link-id': link.id,
          role: 'button', tabindex: primary ? 0 : -1, 'aria-label': impactHeadline(link), opacity: arc.opacity, 'data-undirected': String(link.undirected === true),
        });
        group.classList.toggle('bm-preview-link', this.highlightedId === link.id);
        const title = svg('title');
        title.textContent = `${impactHeadline(link)} · 강도 ${link.magnitude} · 자료 기준 ${impactDate(link.lastSeen)} · 근거 ${link.evidence.length}건`;
        const hit = svg('path', { class: 'bm-arc-hit', 'stroke-width': Math.max(10, width + 6) });
        const casing = svg('path', { class: 'bm-arc-casing', 'stroke-width': width + 2.4 });
        const core = svg('path', { class: 'bm-arc-core', 'stroke-width': width, 'stroke-dasharray': IMPACT_STYLES[kind].dash || 'none' });
        const tracer = arc.animated ? svg('path', { class: 'bm-arc-tracer', pathLength: 100, 'stroke-width': width + 1 }) : null;
        const mark = link.undirected ? null : impactMark(kind);
        mark?.classList.add('bm-arc-arrow');
        group.append(title, hit, casing, core, ...(tracer ? [tracer] : []), ...(mark ? [mark] : []));
        this.activate(group, () => actions.selectLink(arc));
        return { nodes: [group], group, hit, casing, core, tracer, mark };
      });
      let curve: ReturnType<typeof battleCurve> | undefined;
      this.markers.push((projection) => {
        const { project, period } = projection;
        const from = project(arc.from[1], arc.from[0]);
        const to = project(arc.to[1], arc.to[0]);
        if (!from || !to) return;
        // Unwrap the endpoints together before placing the complete arc in each world.
        const target = { ...to, x: nearestWorldCopy(to.x, from.x, period) };
        const shape = battleCurve(from, target, arc.level, index * 16, reciprocal);
        curve = shape;
        drawArc(projection, shape.left - width, shape.right + width, ({ group, hit, casing, core, tracer, mark }, dx) => {
          group.setAttribute('transform', `translate(${dx} 0)`);
          hit.setAttribute('d', shape.hit);
          for (const path of [casing, core, tracer]) path?.setAttribute('d', shape.d);
          const scale = 0.85 + arc.level * 0.15;
          mark?.setAttribute('transform', `translate(${shape.x} ${shape.y}) rotate(${shape.angle}) scale(${scale}) translate(-10 -6)`);
        });
      });
      if (stories) {
        const drawStory = repeated(storiesLayer, () => {
          const story = this.label(battleStoryLabel(link, kind), 'bm-story-label');
          story.node.classList.toggle('bm-preview-link', this.highlightedId === link.id);
          story.node.dataset.kind = kind;
          story.node.dataset.storyFor = link.id;
          story.node.dataset.dimmed = String(arc.opacity === 0.17);
          story.node.addEventListener('click', () => actions.selectLink(arc));
          const leader = svg('line', { class: 'bm-story-leader' });
          story.node.prepend(leader);
          return { nodes: [story.node], story, leader };
        });
        storyPlacements.unshift((projection, place) => {
          if (!curve) return;
          const midpoints = [0.5, 0.63, 0.37, 0.74, 0.26].map(curve.pointAt);
          const xs = midpoints.map((point) => point.x);
          drawStory(projection, Math.min(...xs), Math.max(...xs), ({ story, leader }, dx) => {
            const candidates = [12, -12, 24, -24, 37, -37, 52, -52, 68, -68]
              .flatMap((offset) => midpoints.map((point) => ({ x: point.x + dx, y: point.y - offset, anchor: { x: point.x + dx, y: point.y } })));
            const position = place(story, candidates);
            if (!position) return;
            const { anchor } = candidates[position.index]!;
            leader.setAttribute('x1', String(anchor.x - position.x));
            leader.setAttribute('y1', String(anchor.y - position.y));
          });
        });
      }
    }
    for (const crest of crests) {
      const drawCrest = repeated(markersLayer, () => {
        const node = svg('g', { class: 'bm-crest', opacity: crest.dimmed ? 0.36 : 1 });
        const title = svg('title');
        title.textContent = `${impactCountry(crest.code)} · 발신 압박 ${crest.count}건`;
        node.append(title, svg('path', { d: 'M0 -6L6 0L0 6L-6 0Z M2 0a2 2 0 1 1-4 0a2 2 0 1 1 4 0' }));
        node.addEventListener('click', () => actions.selectCountry(crest.code));
        return { nodes: [node], node };
      });
      this.markers.push((projection) => {
        const point = projection.project(crest.at[1], crest.at[0]);
        if (point) drawCrest(projection, point.x - 6, point.x + 6, ({ node }, dx) => {
          node.setAttribute('transform', `translate(${point.x + dx} ${point.y})`);
        });
      });
    }
    for (const { event, at, offset } of events) {
      const drawEvent = repeated(markersLayer, (primary) => {
        const label = `${impactCountry(event.country)} · ${countryEventLabel(event)} · ${countryEventValue(event)}`;
        const node = svg('g', {
          class: 'bm-country-event', 'data-kind': event.kind, 'data-event-id': event.id,
          role: 'button', tabindex: primary ? 0 : -1, 'aria-label': label,
        });
        const title = svg('title');
        title.textContent = `${label} · 자료 기준 ${impactDate(event.lastSeen)}`;
        const marker = svg('circle', { r: 4 });
        const count = svg('text', { x: 6, y: 3 });
        count.textContent = event.kind === 'conflict' ? String(event.eventCount) : `${event.kind === 'energy' ? '에너지' : '금융'} ${event.magnitude}`;
        node.append(title, svg('circle', { class: 'bm-country-event-hit', r: 8 }), marker, count);
        this.activate(node, () => actions.selectEvent(event, node));
        return { nodes: [node], node };
      });
      this.markers.push((projection) => {
        const point = projection.project(at[1], at[0]);
        if (point) drawEvent(projection, point.x - 8, point.x + 48, ({ node }, dx) => {
          node.setAttribute('transform', `translate(${point.x + dx} ${point.y + 11 + offset})`);
        });
      });
    }
    this.element.append(storiesLayer);
    const countriesLayer = svg('g');
    this.element.append(countriesLayer);
    for (const { code, at } of countries) {
      const drawCountry = repeated(countriesLayer, () => {
        const label = this.label(code === 'KR' ? '한국' : impactCountry(code), 'bm-country-label');
        label.node.dataset.country = code;
        const leader = svg('line', { class: 'bm-country-leader' });
        return { nodes: [leader, label.node], label, leader };
      });
      this.labels.push((projection, place) => {
        const anchor = projection.project(at[1], at[0]);
        if (!anchor) return;
        drawCountry(projection, anchor.x, anchor.x, ({ label, leader }, dx) => {
          const point = { x: anchor.x + dx, y: anchor.y };
          const position = place(label, [15, 27, 40, 58].flatMap((distance) =>
            [[0, -distance], [0, distance], [distance, -distance], [-distance, -distance],
              [distance, distance], [-distance, distance]].map(([dx, dy]) => ({ x: point.x + dx!, y: point.y + dy! }))));
          leader.style.visibility = position ? '' : 'hidden';
          if (!position) return;
          leader.setAttribute('x1', String(point.x));
          leader.setAttribute('y1', String(point.y));
          leader.setAttribute('x2', String(position.x));
          leader.setAttribute('y2', String(position.y));
        });
      });
    }
    this.labels.push(...storyPlacements);
    this.reproject();
  }

  highlight(id: string | null): void {
    this.highlightedId = id;
    this.element.classList.toggle('bm-preview', id !== null);
    for (const node of this.element.querySelectorAll<SVGGElement>('.bm-arc, .bm-story-label')) {
      node.classList.toggle('bm-preview-link', (node.dataset.linkId ?? node.dataset.storyFor) === id);
    }
  }

  private activate(group: SVGGElement, select: () => void): void {
    group.addEventListener('click', select);
    group.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      select();
    });
  }

  private label(text: string, className: string): MapLabel {
    const node = svg('g', { class: className, visibility: 'hidden', 'aria-hidden': 'true' });
    const label = svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    label.textContent = text;
    const background = svg('rect', { rx: 3 });
    node.append(background, label);
    return { node, text: label, background };
  }

  reproject(): void {
    if (this.frame !== null || (!this.markers.length && !this.labels.length)) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      const project = this.projector();
      if (!project || !this.element.clientWidth) return;
      const { width, height, left, top } = this.element.getBoundingClientRect();
      const period = Math.abs((project(0, 180)?.x ?? 0) - (project(0, -180)?.x ?? 0));
      const projection = { project, width, period };
      for (const place of this.markers) place(projection);
      const occupied = [...(this.element.parentElement?.querySelectorAll('.bm-key-plate, .zoom-controls') ?? [])]
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width && rect.height)
        .map((rect) => ({ x: rect.left - left, y: rect.top - top, width: rect.width, height: rect.height }));
      const narrow = width <= 768;
      let storyCount = 0;
      for (const layout of this.labels) layout(projection, ({ node, text, background }, points) => {
        const story = node.classList.contains('bm-story-label');
        const padding = story ? 6 : 4;
        const w = text.getComputedTextLength() + padding * 2;
        const h = story ? 19 : 17;
        node.setAttribute('visibility', 'hidden');
        if (story && narrow && storyCount >= 3) return null;
        for (const [index, { x, y }] of points.entries()) {
          // Place only labels near the viewport, but let Korea's label remain on the edge when panning.
          const korea = node.dataset.country === 'KR';
          if (!korea && (x < 0 || x > width || y < 0 || y > height)) continue;
          const box = { x: Math.max(6, Math.min(x - w / 2, width - w - 6)),
            y: Math.max(7, Math.min(y - h / 2, height - h - 7)), width: w, height: h };
          if (occupied.some((other) => overlaps(box, other))) continue;
          occupied.push(box);
          if (story) storyCount++;
          const center = { x: box.x + w / 2, y: box.y + h / 2 };
          node.setAttribute('transform', `translate(${center.x} ${center.y})`);
          node.setAttribute('visibility', 'visible');
          background.setAttribute('x', String(-w / 2));
          background.setAttribute('y', String(-h / 2));
          background.setAttribute('width', String(w));
          background.setAttribute('height', String(h));
          return { ...center, index };
        }
        return null;
      });
    });
  }

  destroy(): void {
    this.resize?.disconnect();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.element.remove();
  }
}
