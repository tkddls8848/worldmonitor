import { ensureHydrated } from '@/services/bootstrap';
import type { GlobalIndicatorGauge } from '@/types/global-indicators';
import type { OpsEvent } from '@/types/world-overview';

const URLS = {
  cli: 'https://www.oecd.org/en/data/datasets/oecd-composite-leading-indicators-clis.html',
  gpr: 'https://www.matteoiacoviello.com/gpr.htm',
  cofer: 'https://data.imf.org/en/datasets/IMF.STA:COFER',
  pink: 'https://www.worldbank.org/en/research/commodity-markets',
};
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO2 = /^[A-Z]{2}$/;
const DAY_MS = 86_400_000;
const MAJOR_ECONOMIES = new Set('AU BR CA CN DE ES FR GB ID IN IT JP KR MX TR US ZA AR RU SA'.split(' '));

const PHASES = {
  expansion: ['Expansion', '확장'],
  slowdown: ['Slowdown', '둔화'],
  downturn: ['Downturn', '하강'],
  recovery: ['Recovery', '회복'],
} as const;

const PINK_LABELS = {
  energy: ['Energy', '에너지'], nonEnergy: ['Non-energy', '비에너지'],
  agriculture: ['Agriculture', '농산물'], food: ['Food', '식품'], fertilizers: ['Fertilizers', '비료'],
  metals: ['Metals & minerals', '금속·광물'], preciousMetals: ['Precious metals', '귀금속'],
} as const;
type Phase = keyof typeof PHASES;
type PinkIndex = keyof typeof PINK_LABELS;
type Point = { period: string; value: number };
type Cli = Point & { change: number; phase: Phase; turningPoint: 'peak' | 'trough' | null };
type GprDay = { date: string; value: number; average30d: number; normal: number; dailySpike: boolean; sustainedSpike: boolean };
type Cofer = { period: string; usd: number; yoyPp: number | null };
type PinkSpike = { period: string; key: PinkIndex; momPct: number };
type Pink = { period: string; energyYoy: number | null; foodYoy: number | null; spikes: PinkSpike[] };

export interface GlobalIndicators {
  cli: Record<string, Cli>;
  gpr: { latest: GprDay | null; countries: Record<string, Point>; spikes: GprDay[] };
  cofer: Cofer | null;
  pink: Pink | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function point(value: unknown): Point | null {
  const { period, value: level } = record(value);
  return typeof period === 'string' && PERIOD.test(period) && finite(level) ? { period, value: level } : null;
}

function gprDay(value: unknown): GprDay | null {
  const { date, value: level, average30d, normal, dailySpike, sustainedSpike } = record(value);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !finite(Date.parse(date))
    || !finite(level) || !finite(average30d) || !finite(normal) || typeof dailySpike !== 'boolean'
    || typeof sustainedSpike !== 'boolean') return null;
  return { date, value: level, average30d, normal, dailySpike, sustainedSpike };
}

export function readGlobalIndicators(cliRaw: unknown, gprRaw: unknown, coferRaw: unknown, pinkRaw: unknown): GlobalIndicators {
  const cli: Record<string, Cli> = {};
  for (const [code, raw] of Object.entries(record(record(cliRaw).series))) {
    const entry = point(raw);
    const { change, phase, turningPoint } = record(raw);
    if (entry && (ISO2.test(code) || code === 'G20' || code === 'OECD') && finite(change)
      && typeof phase === 'string' && Object.prototype.hasOwnProperty.call(PHASES, phase)) {
      cli[code] = { ...entry, change, phase: phase as Phase,
        turningPoint: turningPoint === 'peak' || turningPoint === 'trough' ? turningPoint : null };
    }
  }
  const countries: Record<string, Point> = {};
  const gpr = record(gprRaw);
  for (const [code, raw] of Object.entries(record(gpr.countries))) {
    const entry = point(raw);
    if (entry && ISO2.test(code)) countries[code] = entry;
  }
  const gprSpikes = Array.isArray(gpr.spikes) ? gpr.spikes.map(gprDay).filter((day) => day !== null) : [];
  const cofer = record(record(coferRaw).latest);
  const usd = record(cofer.shares).USD;
  const pink = record(pinkRaw);
  const pinkLatest = record(pink.latest);
  const pinkIndices = record(pinkLatest.indices);
  const pinkSpikes = Array.isArray(pink.spikes) ? pink.spikes.flatMap((raw): PinkSpike[] => {
    const { period, key, momPct } = record(raw);
    return typeof period === 'string' && PERIOD.test(period) && typeof key === 'string'
      && Object.prototype.hasOwnProperty.call(PINK_LABELS, key) && finite(momPct) && Math.abs(momPct) > 10
      ? [{ period, key: key as PinkIndex, momPct }] : [];
  }) : [];
  const energy = record(pinkIndices.energy).yoyPct;
  const food = record(pinkIndices.food).yoyPct;
  return {
    cli,
    gpr: { latest: gprDay(gpr.latest), countries, spikes: gprSpikes },
    cofer: typeof cofer.period === 'string' && /^\d{4}-Q[1-4]$/.test(cofer.period) && finite(usd) && usd >= 0 && usd <= 100
      ? { period: cofer.period, usd, yoyPp: finite(cofer.usdYoyPp) ? cofer.usdYoyPp : null } : null,
    pink: typeof pinkLatest.period === 'string' && PERIOD.test(pinkLatest.period)
      ? { period: pinkLatest.period, energyYoy: finite(energy) ? energy : null, foodYoy: finite(food) ? food : null, spikes: pinkSpikes } : null,
  };
}

export async function loadGlobalIndicators(): Promise<GlobalIndicators> {
  const [cli, gpr, cofer, pink] = await Promise.allSettled([
    ensureHydrated('oecdCli'), ensureHydrated('gpr'), ensureHydrated('imfCofer'), ensureHydrated('pinkSheet'),
  ]);
  return readGlobalIndicators(
    cli.status === 'fulfilled' ? cli.value : null,
    gpr.status === 'fulfilled' ? gpr.value : null,
    cofer.status === 'fulfilled' ? cofer.value : null,
    pink.status === 'fulfilled' ? pink.value : null,
  );
}

function signed(value: number, digits = 1): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

export function globalIndicatorGauges(data: GlobalIndicators, language: string, iso2?: string): GlobalIndicatorGauge[] {
  const locale = language === 'ko' ? 1 : 0;
  const gauges: GlobalIndicatorGauge[] = [];
  const cli = data.cli[iso2 ?? 'G20'];
  if (cli) gauges.push({
    id: 'cli', label: iso2 ? 'OECD CLI' : 'G20 CLI',
    value: `${PHASES[cli.phase][locale]} · ${cli.value.toFixed(2)}`, period: cli.period, url: URLS.cli,
  });
  if (iso2) {
    const country = data.gpr.countries[iso2];
    if (country) gauges.push({ id: 'gpr', label: 'GPR', value: country.value.toFixed(2), period: country.period, url: URLS.gpr });
    return gauges;
  }
  const gpr = data.gpr.latest;
  if (gpr) gauges.push({
    id: 'gpr', label: locale ? 'GPR 30일 / 1년' : 'GPR 30d / 1y',
    value: `${gpr.average30d.toFixed(1)} / ${gpr.normal.toFixed(1)}`, period: gpr.date, url: URLS.gpr,
  });
  const cofer = data.cofer;
  if (cofer) gauges.push({
    id: 'cofer', label: locale ? '외환보유액 USD 비중' : 'USD reserve share',
    value: `${cofer.usd.toFixed(1)}%${cofer.yoyPp === null ? '' : ` · ${signed(cofer.yoyPp, 2)} pp ${locale ? '전년비' : 'YoY'}`}`,
    period: cofer.period, url: URLS.cofer,
  });
  const pink = data.pink;
  if (pink) for (const [key, yoy] of [['energy', pink.energyYoy], ['food', pink.foodYoy]] as const) {
    if (yoy !== null) gauges.push({
      id: `pink-${key}`, label: `${PINK_LABELS[key][locale]} ${locale ? '전년비' : 'YoY'}`,
      value: `${signed(yoy)}%`, period: pink.period, url: URLS.pink,
    });
  }
  return gauges;
}

function monthEnd(period: string): number {
  return Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)), 0);
}

export function globalIndicatorEvents(data: GlobalIndicators, language: string, now: number): OpsEvent[] {
  const ko = language === 'ko';
  const names = new Intl.DisplayNames([ko ? 'ko' : 'en'], { type: 'region' });
  const events: OpsEvent[] = [];
  for (const [iso2, cli] of Object.entries(data.cli)) {
    if (!MAJOR_ECONOMIES.has(iso2) || !cli.turningPoint) continue;
    const turn = cli.turningPoint === 'peak' ? (ko ? '고점' : 'peak') : (ko ? '저점' : 'trough');
    events.push({ id: `cli:${iso2}:${cli.period}`, kind: 'global-indicator', iso2, at: monthEnd(cli.period),
      title: `${names.of(iso2)} CLI · ${turn} · ${cli.value.toFixed(2)}`, severity: 'medium', url: URLS.cli });
  }
  const newestSpikes = data.gpr.spikes.filter((day) => day.dailySpike || day.sustainedSpike)
    .sort((a, b) => b.date.localeCompare(a.date));
  const daily = newestSpikes.find((day) => day.dailySpike);
  const sustained = newestSpikes.find((day) => day.sustainedSpike);
  if (daily) events.push({
    id: `gpr:daily:${daily.date}`, kind: 'global-indicator', at: Date.parse(daily.date), severity: 'high', url: URLS.gpr,
    title: ko ? `일간 GPR 99백분위 초과 · ${daily.value.toFixed(1)}` : `Daily GPR above 99th percentile · ${daily.value.toFixed(1)}`,
  });
  if (sustained) events.push({
    id: `gpr:sustained:${sustained.date}`, kind: 'global-indicator', at: Date.parse(sustained.date), severity: 'high', url: URLS.gpr,
    title: ko ? `GPR 30일 평균이 1년 평균의 1.5배 초과 · ${sustained.average30d.toFixed(1)}`
      : `GPR 30-day average above 1.5× normal · ${sustained.average30d.toFixed(1)}`,
  });
  for (const { period, key, momPct } of data.pink?.spikes ?? []) events.push({
    id: `pink:${key}:${period}`, kind: 'global-indicator', at: monthEnd(period), severity: 'medium', url: URLS.pink,
    title: `Pink Sheet · ${PINK_LABELS[key][ko ? 1 : 0]} · ${signed(momPct)}% ${ko ? '전월비' : 'MoM'}`,
  });
  return events.filter(({ id, at }) => at <= now && at >= now - (id.startsWith('gpr:') ? 30 : 95) * DAY_MS)
    .sort((a, b) => b.at - a.at);
}
