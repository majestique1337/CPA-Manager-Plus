import type {
  AntigravityQuotaState,
  AuthFileItem,
  ClaudeQuotaState,
  CodexQuotaState,
  KimiQuotaState,
  QuotaModelScope,
  XaiQuotaState,
} from '@/types';

export type QuotaProvider = 'claude' | 'codex' | 'kimi' | 'xai' | 'antigravity';

export type QuotaWindowKind = 'session' | 'weekly' | 'other';

export interface QuotaWindowView {
  id: string;
  kind: QuotaWindowKind;
  label: string;
  /** Narrower scope such as a model family, when the window is not account-wide. */
  scope?: string;
  usedPercent: number | null;
  resetAtMs: number | null;
  windowMs: number | null;
}

export interface QuotaAccountView {
  id: string;
  provider: QuotaProvider;
  name: string;
  plan: string | null;
  status: 'ready' | 'loading' | 'error' | 'unknown';
  error?: string;
  windows: QuotaWindowView[];
  fetchedAtMs: number | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const clampPercent = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;

const classifyWindow = (windowMs: number | null, id: string): QuotaWindowKind => {
  if (windowMs !== null) {
    if (windowMs <= 6 * HOUR_MS) return 'session';
    if (windowMs >= 6 * DAY_MS) return 'weekly';
    return 'other';
  }
  const key = id.toLowerCase();
  if (key.includes('five') || key.includes('5h') || key.includes('primary')) return 'session';
  if (key.includes('seven') || key.includes('week') || key.includes('secondary')) return 'weekly';
  return 'other';
};

const KIND_LABEL: Record<QuotaWindowKind, string> = {
  session: '5h',
  weekly: '7d',
  other: '',
};

const windowLabel = (kind: QuotaWindowKind, fallback: string): string =>
  KIND_LABEL[kind] || fallback;

const toWindow = (input: {
  id: string;
  label: string;
  usedPercent: number | null | undefined;
  resetAtMs?: number | null;
  windowSeconds?: number | null;
  scope?: string;
}): QuotaWindowView => {
  const windowMs =
    typeof input.windowSeconds === 'number' && input.windowSeconds > 0
      ? input.windowSeconds * 1000
      : null;
  const kind = classifyWindow(windowMs, input.id);
  return {
    id: input.id,
    kind,
    label: windowLabel(kind, input.label),
    scope: input.scope,
    usedPercent: clampPercent(input.usedPercent),
    resetAtMs: typeof input.resetAtMs === 'number' ? input.resetAtMs : null,
    windowMs,
  };
};

const scopeLabel = (scope: QuotaModelScope | undefined) => {
  if (!scope || scope.kind === 'all') return undefined;
  const raw = scope.key || scope.models?.[0];
  // "*_main" is the provider's default pool, i.e. the account-wide limit.
  if (!raw || /(^|_)main$/.test(raw)) return undefined;
  return raw.replace(/^codex_/, '').replace(/[_-]+/g, ' ');
};

const resolveStatus = (status: string): QuotaAccountView['status'] =>
  status === 'success'
    ? 'ready'
    : status === 'loading'
      ? 'loading'
      : status === 'error'
        ? 'error'
        : 'unknown';

const accountName = (file: AuthFileItem): string => {
  const candidates = [file.email, file.account, file.label, file.name];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return file.name;
};

export const buildClaudeAccount = (
  file: AuthFileItem,
  state: ClaudeQuotaState | undefined
): QuotaAccountView => ({
  id: `claude:${file.name}`,
  provider: 'claude',
  name: accountName(file),
  plan: state?.planType ?? null,
  status: resolveStatus(state?.status ?? 'idle'),
  error: state?.error,
  fetchedAtMs: state?.fetchedAtMs ?? null,
  windows: (state?.windows ?? []).map((w) =>
    toWindow({
      id: w.id,
      label: w.label,
      usedPercent: w.usedPercent,
      resetAtMs: w.resetAtMs,
      windowSeconds: w.limitWindowSeconds,
      scope: scopeLabel(w.modelScope),
    })
  ),
});

export const buildCodexAccount = (
  file: AuthFileItem,
  state: CodexQuotaState | undefined
): QuotaAccountView => ({
  id: `codex:${file.name}`,
  provider: 'codex',
  name: accountName(file),
  plan: state?.planType ?? null,
  status: resolveStatus(state?.status ?? 'idle'),
  error: state?.error,
  fetchedAtMs: state?.fetchedAtMs ?? null,
  windows: (state?.windows ?? []).map((w) =>
    toWindow({
      id: w.id,
      label: w.label,
      usedPercent: w.usedPercent,
      resetAtMs: w.resetAtMs,
      windowSeconds: w.limitWindowSeconds,
      scope: scopeLabel(w.modelScope),
    })
  ),
});

export const buildKimiAccount = (
  file: AuthFileItem,
  state: KimiQuotaState | undefined
): QuotaAccountView => ({
  id: `kimi:${file.name}`,
  provider: 'kimi',
  name: accountName(file),
  plan: null,
  status: resolveStatus(state?.status ?? 'idle'),
  error: state?.error,
  fetchedAtMs: state?.fetchedAtMs ?? null,
  windows: (state?.rows ?? []).map((row) =>
    toWindow({
      id: row.id,
      label: row.label ?? row.id,
      usedPercent: row.limit > 0 ? (row.used / row.limit) * 100 : null,
      resetAtMs: row.resetAtMs,
      windowSeconds: row.limitWindowSeconds,
      scope: row.scope,
    })
  ),
});

export const buildXaiAccount = (
  file: AuthFileItem,
  state: XaiQuotaState | undefined
): QuotaAccountView => {
  const billing = state?.billing;
  const periodEnd = billing?.periodEnd ?? billing?.billingPeriodEnd;
  const resetAtMs = periodEnd ? Date.parse(periodEnd) : NaN;
  const periodStart = billing?.periodStart ?? billing?.billingPeriodStart;
  const startMs = periodStart ? Date.parse(periodStart) : NaN;
  return {
    id: `xai:${file.name}`,
    provider: 'xai',
    name: accountName(file),
    plan: null,
    status: resolveStatus(state?.status ?? 'idle'),
    error: state?.error,
    fetchedAtMs: state?.fetchedAtMs ?? null,
    windows: billing
      ? [
          toWindow({
            id: billing.periodType === 'weekly' ? 'weekly' : 'period',
            label: billing.periodType === 'monthly' ? '30d' : 'Period',
            usedPercent: billing.usedPercent ?? billing.usagePercent,
            resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : null,
            windowSeconds:
              Number.isFinite(resetAtMs) && Number.isFinite(startMs)
                ? (resetAtMs - startMs) / 1000
                : null,
          }),
        ]
      : [],
  };
};

const shortGroupLabel = (label: string): string =>
  label.replace(/claude\s+and\s+gpt/i, 'Claude+GPT').replace(/\s+models?$/i, '');

const bucketWindowCode = (label: string): string =>
  /five|5\s*h/i.test(label) ? '5h' : /week|7\s*d|seven/i.test(label) ? '7d' : label;

export const buildAntigravityAccount = (
  file: AuthFileItem,
  state: AntigravityQuotaState | undefined
): QuotaAccountView => ({
  id: `antigravity:${file.name}`,
  provider: 'antigravity',
  name: accountName(file),
  plan: state?.subscription?.tierName ?? state?.subscription?.plan ?? null,
  status: resolveStatus(state?.status ?? 'idle'),
  error: state?.error,
  fetchedAtMs: state?.fetchedAtMs ?? null,
  windows: (state?.groups ?? []).flatMap((group) =>
    group.buckets.map((bucket) => {
      const resetMs = bucket.resetTime ? Date.parse(bucket.resetTime) : NaN;
      // Model groups are parallel pools, not 5h/7d windows, so they stay "other" and keep their own name.
      return {
        ...toWindow({
          id: `${group.id}:${bucket.id}`,
          label: group.label,
          usedPercent: (1 - bucket.remainingFraction) * 100,
          resetAtMs: Number.isFinite(resetMs) ? resetMs : null,
          scope: group.buckets.length > 1 ? bucketWindowCode(bucket.label) : undefined,
        }),
        kind: 'other' as const,
        label: shortGroupLabel(group.label),
      };
    })
  ),
});

/** Time left in a window, as a fraction elapsed (0 at start, 1 at reset). */
export const elapsedFraction = (win: QuotaWindowView, nowMs: number): number | null => {
  if (win.resetAtMs === null || win.windowMs === null) return null;
  const start = win.resetAtMs - win.windowMs;
  return Math.min(1, Math.max(0, (nowMs - start) / win.windowMs));
};

export type PaceState = 'idle' | 'under' | 'on-track' | 'over' | 'exhausted';

/**
 * Compares quota used against time elapsed. "under" means the account is being
 * used slower than its reset clock allows, which is quota that will be wasted.
 */
export const resolvePace = (win: QuotaWindowView, nowMs: number): PaceState => {
  if (win.usedPercent === null) return 'idle';
  if (win.usedPercent >= 99.5) return 'exhausted';
  const elapsed = elapsedFraction(win, nowMs);
  if (elapsed === null) return 'idle';
  const delta = win.usedPercent / 100 - elapsed;
  if (delta < -0.15) return 'under';
  if (delta > 0.1) return 'over';
  return 'on-track';
};

/** Windows shown on a row: the 5h session, the weekly cap, then the tightest scoped weekly. */
export const pickDisplayWindows = (account: QuotaAccountView): QuotaWindowView[] => {
  const byUsed = (a: QuotaWindowView, b: QuotaWindowView) =>
    (b.usedPercent ?? -1) - (a.usedPercent ?? -1);
  const unscoped = (w: QuotaWindowView) => !w.scope;
  const session = account.windows.filter((w) => w.kind === 'session' && unscoped(w)).sort(byUsed)[0];
  const weeklyAll = account.windows.filter((w) => w.kind === 'weekly' && unscoped(w)).sort(byUsed)[0];
  const weeklyScoped = account.windows.filter((w) => w.kind === 'weekly' && !unscoped(w)).sort(byUsed)[0];
  const others = account.windows
    .filter((w) => w.kind === 'other')
    .sort((a, b) => a.label.localeCompare(b.label) || (a.scope ?? '').localeCompare(b.scope ?? ''))
    .slice(0, 4);
  return [session, weeklyAll, weeklyScoped, ...others].filter(
    (w): w is QuotaWindowView => Boolean(w)
  );
};

export interface BurnRecommendation {
  account: QuotaAccountView;
  window: QuotaWindowView;
  remainingPercent: number;
  resetInMs: number;
  score: number;
}

/**
 * Scores an account's weekly quota: plenty left and the reset clock close means
 * unused quota is about to be lost. Accounts with an exhausted 5h session score
 * nothing, since they can't be used right now.
 */
export const burnScore = (account: QuotaAccountView, nowMs: number): BurnRecommendation | null => {
  if (account.status !== 'ready') return null;
  const session = account.windows.find((w) => w.kind === 'session' && !w.scope);
  if (session && session.usedPercent !== null && session.usedPercent > 95) return null;
  let best: BurnRecommendation | null = null;
  for (const win of account.windows) {
    if (win.kind !== 'weekly' || win.scope || win.usedPercent === null || win.resetAtMs === null) {
      continue;
    }
    const remaining = 100 - win.usedPercent;
    const resetInMs = win.resetAtMs - nowMs;
    if (remaining < 5 || resetInMs <= 0) continue;
    const score = remaining / Math.max(resetInMs / HOUR_MS, 1);
    if (!best || score > best.score) {
      best = { account, window: win, remainingPercent: remaining, resetInMs, score };
    }
  }
  return best;
};

/** Best account to spend first within a group, or null when there is no real choice. */
export const pickBurnFirst = (
  accounts: QuotaAccountView[],
  nowMs: number
): BurnRecommendation | null => {
  const ranked = accounts
    .map((a) => burnScore(a, nowMs))
    .filter((r): r is BurnRecommendation => r !== null)
    .sort((a, b) => b.score - a.score);
  return ranked[0] ?? null;
};

/** "Plan_pro" / "plus" -> "Pro" / "Plus". */
export const formatPlan = (plan: string | null): string | null => {
  if (!plan) return null;
  const clean = plan.replace(/^plan[_\s-]*/i, '').replace(/[_-]+/g, ' ').trim();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : null;
};

export const formatResetIn = (resetAtMs: number | null, nowMs: number): string => {
  if (resetAtMs === null) return '—';
  const diff = resetAtMs - nowMs;
  if (diff <= 0) return 'now';
  const minutes = Math.max(1, Math.floor(diff / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(diff / HOUR_MS);
  if (hours < 48) {
    const restMinutes = Math.floor((diff - hours * HOUR_MS) / 60_000);
    return restMinutes > 0 && hours < 10 ? `${hours}h ${restMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(diff / DAY_MS);
  const restHours = Math.floor((diff - days * DAY_MS) / HOUR_MS);
  return restHours > 0 && days < 7 ? `${days}d ${restHours}h` : `${days}d`;
};

export const PROVIDER_LABEL: Record<QuotaProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  xai: 'xAI',
  antigravity: 'Antigravity',
};

export const PROVIDER_ORDER: QuotaProvider[] = ['claude', 'codex', 'antigravity', 'kimi', 'xai'];

/** Aggregates remaining weekly capacity for one provider, ignoring errored accounts. */
export const summarizeProvider = (accounts: QuotaAccountView[]) => {
  const weekly = accounts
    .filter((a) => a.status === 'ready')
    .map((a) => pickDisplayWindows(a).find((w) => w.kind === 'weekly' && !w.scope))
    .filter((w): w is QuotaWindowView => Boolean(w) && w!.usedPercent !== null);
  if (weekly.length === 0) return { remainingPercent: null as number | null, accounts: accounts.length };
  const remaining =
    weekly.reduce((sum, w) => sum + (100 - (w.usedPercent ?? 0)), 0) / weekly.length;
  return { remainingPercent: remaining, accounts: accounts.length };
};
