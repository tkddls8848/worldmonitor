export declare const WORLD_OVERVIEW_TIMEZONE: 'Asia/Seoul';
export declare const WORLD_OVERVIEW_KEYS: {
  readonly relations: 'world-overview:relations:v1';
  readonly pairTrends: 'gdelt:bulk:world-pair-trends:v1';
  readonly ai: 'world-overview:ai:v1';
  readonly snapshot: 'world-overview:snapshot:v1';
  readonly archivePrefix: 'world-overview:snapshot:v1:';
  readonly dates: 'world-overview:snapshot-dates:v1';
  readonly marks: 'world-overview:wrong-marks:v1';
};
export declare function kstDate(nowMs: number): string;
export declare function kstHour(nowMs: number): number;
export declare function addDays(date: string, days: number): string;
export declare function pairKey(a: string, b: string): string;
