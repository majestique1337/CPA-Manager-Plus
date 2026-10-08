import { toDateKey, type LocalUsagePayload, type LocalUsageRow } from './localUsageModel';

/** Deterministic fake usage for demo builds and design work. */
export const buildDemoLocalUsage = (now: Date = new Date()): LocalUsagePayload => {
  const rows: LocalUsageRow[] = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const combos: Array<[LocalUsageRow['src'], string, string, number]> = [
    ['claude', 'claude-opus-5-5', 'lectomi', 1],
    ['claude', 'claude-sonnet-5-5', 'LocalFlow', 0.35],
    ['claude', 'claude-haiku-5-5', 'T3 scratch', 0.1],
    ['codex', 'gpt-6-sol', 'lectomi', 0.8],
    ['codex', 'gpt-5.6-luna', 'app', 0.4],
  ];
  for (let i = 0; i < 100; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const weekday = (d.getDay() + 6) % 7;
    if (rand() < (weekday > 4 ? 0.55 : 0.12)) continue;
    const burst = 0.3 + rand() * rand() * 3;
    for (const [src, model, project, weight] of combos) {
      if (rand() < 0.3) continue;
      const tokens = Math.round(burst * weight * 90_000_000 * (0.4 + rand()));
      rows.push({
        date: toDateKey(d),
        src,
        model,
        project,
        in: Math.round(tokens * 0.02),
        out: Math.round(tokens * 0.01),
        cr: Math.round(tokens * 0.95),
        cw: Math.round(tokens * 0.02),
        cost: (tokens / 1e6) * (src === 'claude' ? 0.55 : 0.2),
      });
    }
  }
  return { generatedAt: now.getTime(), rows: rows.reverse() };
};
