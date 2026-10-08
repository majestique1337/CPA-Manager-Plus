import { describe, expect, it } from 'vitest';
import { fmtTokens, prettyModel, summarizeLocalUsage, type LocalUsageRow } from './localUsageModel';

const row = (date: string, patch: Partial<LocalUsageRow> = {}): LocalUsageRow => ({
  date,
  src: 'claude',
  model: 'claude-opus-5-5',
  project: 'app',
  in: 100,
  out: 100,
  cr: 800,
  cw: 0,
  cost: 1,
  ...patch,
});

const NOW = new Date(2026, 9, 8, 12); // Thu 8 Oct 2026

describe('summarizeLocalUsage', () => {
  it('sums the last 30 days and ignores older rows', () => {
    const s = summarizeLocalUsage([row('2026-10-08'), row('2026-10-01'), row('2026-08-01')], NOW);
    expect(s.spend).toBe(2);
    expect(s.tokens).toBe(2000);
    expect(s.cacheShare).toBeCloseTo(0.8);
    expect(s.trend).toHaveLength(30);
    expect(s.trend[29]).toMatchObject({ date: '2026-10-08', claude: 1000, codex: 0 });
  });

  it('ranks models and projects by tokens', () => {
    const s = summarizeLocalUsage(
      [row('2026-10-08', { model: 'a', project: 'x', cr: 10 }), row('2026-10-08', { model: 'b', project: 'y', cr: 900 })],
      NOW
    );
    expect(s.models.map((m) => m.name)).toEqual(['b', 'a']);
    expect(s.projects[0].name).toBe('y');
  });

  it('counts a streak that is still alive when today is idle', () => {
    const s = summarizeLocalUsage([row('2026-10-07'), row('2026-10-06'), row('2026-10-04')], NOW);
    expect(s.streak).toBe(2);
    expect(s.activeDays).toBe(3);
    expect(s.heat).toHaveLength(13);
    expect(s.heat[0]).toHaveLength(7);
    expect(s.since).toBe('2026-10-04');
    expect(s.coverageDays).toBe(5);
  });
});

describe('formatting', () => {
  it('abbreviates token counts and model ids', () => {
    expect(fmtTokens(5_980_000_000)).toBe('6.0B');
    expect(fmtTokens(1_234_000)).toBe('1.2M');
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(prettyModel('gpt-6-sol')).toBe('GPT-6 Sol');
  });
});
