import { describe, expect, it } from 'vitest';
import {
  formatPlan,
  formatResetIn,
  pickBurnFirst,
  pickDisplayWindows,
  resolvePace,
  summarizeProvider,
  type QuotaAccountView,
  type QuotaWindowView,
} from './quotaModel';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_000_000_000_000;

const win = (patch: Partial<QuotaWindowView>): QuotaWindowView => ({
  id: 'w',
  kind: 'weekly',
  label: '7d',
  usedPercent: 50,
  resetAtMs: NOW + 3 * DAY,
  windowMs: 7 * DAY,
  ...patch,
});

const account = (id: string, windows: QuotaWindowView[], status: QuotaAccountView['status'] = 'ready') =>
  ({ id, provider: 'claude', name: id, plan: null, status, windows, fetchedAtMs: NOW }) as QuotaAccountView;

describe('resolvePace', () => {
  it('flags slow, fast and exhausted windows against the reset clock', () => {
    // 4 of 7 days elapsed => ~57% of the window gone
    const base = { resetAtMs: NOW + 3 * DAY };
    expect(resolvePace(win({ ...base, usedPercent: 10 }), NOW)).toBe('under');
    expect(resolvePace(win({ ...base, usedPercent: 55 }), NOW)).toBe('on-track');
    expect(resolvePace(win({ ...base, usedPercent: 90 }), NOW)).toBe('over');
    expect(resolvePace(win({ ...base, usedPercent: 100 }), NOW)).toBe('exhausted');
    expect(resolvePace(win({ usedPercent: null }), NOW)).toBe('idle');
  });
});

describe('pickBurnFirst', () => {
  it('prefers the account with lots left and the nearest reset', () => {
    const soon = account('soon', [win({ usedPercent: 20, resetAtMs: NOW + 6 * HOUR })]);
    const later = account('later', [win({ usedPercent: 20, resetAtMs: NOW + 5 * DAY })]);
    expect(pickBurnFirst([later, soon], NOW)?.account.id).toBe('soon');
  });

  it('skips errored, nearly empty and scoped windows', () => {
    const errored = account('err', [win({ usedPercent: 0 })], 'error');
    const empty = account('empty', [win({ usedPercent: 98 })]);
    const scoped = account('scoped', [win({ usedPercent: 0, scope: 'opus' })]);
    expect(pickBurnFirst([errored, empty, scoped], NOW)).toBeNull();
  });
});

describe('burn rules', () => {
  it('ignores accounts whose 5h session is already exhausted', () => {
    const blocked = account('blocked', [
      win({ id: 's', kind: 'session', label: '5h', usedPercent: 99, windowMs: 5 * HOUR, resetAtMs: NOW + HOUR }),
      win({ usedPercent: 10, resetAtMs: NOW + 6 * HOUR }),
    ]);
    expect(pickBurnFirst([blocked], NOW)).toBeNull();
  });
});

describe('formatPlan', () => {
  it('cleans raw plan identifiers', () => {
    expect(formatPlan('Plan_pro')).toBe('Pro');
    expect(formatPlan('plus')).toBe('Plus');
    expect(formatPlan(null)).toBeNull();
  });
});

describe('pickDisplayWindows', () => {
  it('returns session, weekly and the tightest scoped weekly in order', () => {
    const acc = account('a', [
      win({ id: 's', kind: 'session', label: '5h', usedPercent: 30 }),
      win({ id: 'w', usedPercent: 40 }),
      win({ id: 'o1', scope: 'opus', usedPercent: 20 }),
      win({ id: 'o2', scope: 'sonnet', usedPercent: 70 }),
    ]);
    expect(pickDisplayWindows(acc).map((w) => w.id)).toEqual(['s', 'w', 'o2']);
  });
});

describe('summarizeProvider', () => {
  it('averages remaining weekly quota over ready accounts only', () => {
    const a = account('a', [win({ usedPercent: 20 })]);
    const b = account('b', [win({ usedPercent: 60 })]);
    const broken = account('c', [win({ usedPercent: 100 })], 'error');
    expect(summarizeProvider([a, b, broken]).remainingPercent).toBe(60);
  });
});

describe('formatResetIn', () => {
  it('formats minutes, hours and days compactly', () => {
    expect(formatResetIn(NOW + 20 * 60_000, NOW)).toBe('20m');
    expect(formatResetIn(NOW + 2 * HOUR + 15 * 60_000, NOW)).toBe('2h 15m');
    expect(formatResetIn(NOW + 3 * DAY + 9 * HOUR, NOW)).toBe('3d 9h');
    expect(formatResetIn(NOW - 1, NOW)).toBe('now');
    expect(formatResetIn(null, NOW)).toBe('—');
  });
});
