/** One day of usage for one source/model/project, as produced by tools/local-usage/server.mjs. */
export interface LocalUsageRow {
  date: string; // YYYY-MM-DD, local time
  src: 'claude' | 'codex';
  model: string;
  project: string;
  in: number;
  out: number;
  cr: number;
  cw: number;
  cost: number;
}

export interface LocalUsagePayload {
  generatedAt: number | null;
  rows: LocalUsageRow[];
  scanning?: boolean;
}

export interface RankedItem {
  name: string;
  tokens: number;
  cost: number;
}

export interface TrendDay {
  date: string;
  claude: number;
  codex: number;
  /** Tokens per model, for the stacked bars. */
  byModel: Record<string, number>;
  /** Token kinds and spend for the day, for KPI sparklines and the breakdown charts. */
  in: number;
  out: number;
  cr: number;
  cw: number;
  cost: number;
}

export interface HeatCell {
  date: string;
  tokens: number;
  /** 0 (no use) to 4, relative to the busiest day in range. */
  level: 0 | 1 | 2 | 3 | 4;
}

export interface LocalUsageSummary {
  /** Length of the window these numbers cover, in days. */
  days: number;
  spend: number;
  /** Spend in the 30 days before the current window, for the vs-previous delta. */
  prevSpend: number;
  prevTokens: number;
  prevCacheShare: number;
  tokens: number;
  cacheShare: number;
  trend: TrendDay[];
  models: RankedItem[];
  projects: RankedItem[];
  heat: HeatCell[][]; // columns = weeks (oldest first), rows = Mon..Sun
  activeDays: number;
  streak: number;
  busiest: { date: string; tokens: number } | null;
  totalTokens: number;
  /** Earliest day we have data for, so tiles can say how far back the numbers really go. */
  since: string | null;
  coverageDays: number;
}

export const TREND_DAYS = 30;
export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

const MODEL_PALETTE = ['#e5805a', '#8c94ff', '#4fd1c5', '#f6c453', '#d68cf0', '#7fb0ff'];
export const OTHER_HUE = '#6b7280';
/** Colors for the top models, in rank order, so bars and legend agree. */
export const modelPalette = (rank: number) => MODEL_PALETTE[rank] ?? OTHER_HUE;
export const HEAT_WEEKS = 13;

export const rowTokens = (r: LocalUsageRow) => r.in + r.out + r.cr + r.cw;

export const toDateKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const rank = (
  rows: LocalUsageRow[],
  by: (r: LocalUsageRow) => string,
  limit: number
): RankedItem[] => {
  const map = new Map<string, RankedItem>();
  for (const r of rows) {
    const key = by(r);
    const item = map.get(key) ?? { name: key, tokens: 0, cost: 0 };
    item.tokens += rowTokens(r);
    item.cost += r.cost;
    map.set(key, item);
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens).slice(0, limit);
};

/** Turns raw daily rows into everything the dashboard tiles show. `now` is injectable for tests. */
export const summarizeLocalUsage = (
  rows: LocalUsageRow[],
  now: Date = new Date(),
  windowDays: number = TREND_DAYS
): LocalUsageSummary => {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const trendStart = toDateKey(addDays(today, -(windowDays - 1)));
  const recent = rows.filter((r) => r.date >= trendStart);
  const prevStart = toDateKey(addDays(today, -(2 * windowDays - 1)));
  const prevRows = rows.filter((r) => r.date >= prevStart && r.date < trendStart);
  const prevSpend = prevRows.reduce((sum, r) => sum + r.cost, 0);
  const prevTokens = prevRows.reduce((sum, r) => sum + rowTokens(r), 0);
  const prevCacheShare = prevTokens > 0 ? prevRows.reduce((sum, r) => sum + r.cr, 0) / prevTokens : 0;

  const trendMap = new Map<string, TrendDay>();
  for (let i = windowDays - 1; i >= 0; i--) {
    const date = toDateKey(addDays(today, -i));
    trendMap.set(date, { date, claude: 0, codex: 0, byModel: {}, in: 0, out: 0, cr: 0, cw: 0, cost: 0 });
  }
  for (const r of recent) {
    const day = trendMap.get(r.date);
    if (day) {
      day[r.src] += rowTokens(r);
      day.in += r.in;
      day.out += r.out;
      day.cr += r.cr;
      day.cw += r.cw;
      day.cost += r.cost;
      day.byModel[r.model] = (day.byModel[r.model] ?? 0) + rowTokens(r);
    }
  }

  const perDay = new Map<string, number>();
  for (const r of rows) perDay.set(r.date, (perDay.get(r.date) ?? 0) + rowTokens(r));

  // Heatmap is week-aligned (Monday first) and ends on the current week.
  const mondayOffset = (today.getDay() + 6) % 7;
  const firstMonday = addDays(today, -mondayOffset - (HEAT_WEEKS - 1) * 7);
  const days: { date: string; tokens: number; future: boolean }[] = [];
  for (let i = 0; i < HEAT_WEEKS * 7; i++) {
    const d = addDays(firstMonday, i);
    const date = toDateKey(d);
    days.push({ date, tokens: perDay.get(date) ?? 0, future: d > today });
  }
  const peak = Math.max(1, ...days.map((d) => d.tokens));
  const levelOf = (tokens: number): HeatCell['level'] =>
    tokens <= 0
      ? 0
      : (Math.min(4, Math.max(1, Math.ceil((tokens / peak) * 4))) as HeatCell['level']);
  const heat: HeatCell[][] = [];
  for (let w = 0; w < HEAT_WEEKS; w++) {
    heat.push(
      days
        .slice(w * 7, w * 7 + 7)
        .map((d) => ({ date: d.date, tokens: d.tokens, level: d.future ? 0 : levelOf(d.tokens) }))
    );
  }

  const heatDays = days.filter((d) => !d.future);
  const activeDays = heatDays.filter((d) => d.tokens > 0).length;
  let streak = 0;
  for (let i = heatDays.length - 1; i >= 0; i--) {
    // an idle today does not break a streak that was alive yesterday
    if (heatDays[i].tokens > 0) streak++;
    else if (i !== heatDays.length - 1) break;
  }
  const busiestDay = heatDays.reduce<{ date: string; tokens: number } | null>(
    (best, d) => (d.tokens > (best?.tokens ?? 0) ? { date: d.date, tokens: d.tokens } : best),
    null
  );

  const tokens = recent.reduce((sum, r) => sum + rowTokens(r), 0);
  const cached = recent.reduce((sum, r) => sum + r.cr, 0);
  const totalTokens = heatDays.reduce((sum, d) => sum + d.tokens, 0);

  return {
    days: windowDays,
    spend: recent.reduce((sum, r) => sum + r.cost, 0),
    prevSpend,
    prevTokens,
    prevCacheShare,
    tokens,
    cacheShare: tokens > 0 ? cached / tokens : 0,
    trend: [...trendMap.values()],
    models: rank(recent, (r) => r.model, 5),
    projects: rank(recent, (r) => r.project, 4),
    heat,
    activeDays,
    streak,
    busiest: busiestDay,
    totalTokens,
    since: rows.length
      ? rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0].date)
      : null,
    coverageDays: rows.length
      ? Math.round(
          (today.getTime() -
            new Date(
              `${rows.reduce((min, r) => (r.date < min ? r.date : min), rows[0].date)}T00:00:00`
            ).getTime()) /
            86_400_000
        ) + 1
      : 0,
  };
};

/** "claude-opus-5-5" -> "Opus 5.5", "gpt-6-sol" -> "GPT-6 Sol". */
export const prettyModel = (id: string): string => {
  const claude = id.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i);
  if (claude) {
    const family = claude[1].charAt(0).toUpperCase() + claude[1].slice(1);
    return `${family} ${claude[2]}${claude[3] && claude[3].length < 3 ? `.${claude[3]}` : ''}`;
  }
  const gpt = id.match(/^gpt-([\d.]+)(?:-(.+))?$/i);
  if (gpt) {
    const tail = gpt[2] ? ` ${gpt[2].charAt(0).toUpperCase()}${gpt[2].slice(1)}` : '';
    return `GPT-${gpt[1]}${tail}`;
  }
  return id;
};

export const CLAUDE_HUE = '#e5805a';
export const CODEX_HUE = '#8c94ff';
export const modelHue = (id: string) => (id.startsWith('claude') ? CLAUDE_HUE : CODEX_HUE);

export const fmtTokens = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
};
