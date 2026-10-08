import { useMemo } from 'react';
import {
  PROVIDER_LABEL,
  burnScore,
  formatResetIn,
  type QuotaAccountView,
} from '../quotaModel';
import styles from '../DashboardPage.module.scss';

interface UseFirstHeroProps {
  accounts: QuotaAccountView[];
  loading: boolean;
  nowMs: number;
}

/** The one answer the page exists for: which subscription to spend from right now. */
export function UseFirstHero({ accounts, loading, nowMs }: UseFirstHeroProps) {
  const pick = useMemo(() => {
    const ranked = accounts
      .map((a) => burnScore(a, nowMs))
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.score - a.score);
    return ranked[0] ?? null;
  }, [accounts, nowMs]);

  if (loading && accounts.length === 0) {
    return <div className={styles.heroSkeleton} aria-hidden />;
  }
  if (accounts.length === 0) {
    return (
      <div className={styles.hero}>
        <h1>No accounts connected</h1>
        <p>Add one under OAuth Login and its quota shows up here.</p>
      </div>
    );
  }
  if (!pick) {
    const nextReset = accounts
      .flatMap((a) => a.windows)
      .map((w) => w.resetAtMs)
      .filter((ms): ms is number => ms !== null && ms > nowMs)
      .sort((a, b) => a - b)[0];
    return (
      <div className={styles.hero}>
        <h1>Nothing to spend right now</h1>
        <p>{nextReset ? `The next window opens in ${formatResetIn(nextReset, nowMs)}.` : 'Every window is used up.'}</p>
      </div>
    );
  }
  return (
    <div className={styles.hero}>
      <h1>
        Spend <span title={pick.account.name}>{pick.account.name}</span> first
      </h1>
      <p>
        {PROVIDER_LABEL[pick.account.provider]} has {Math.round(pick.remainingPercent)}% of its week left and
        resets in {formatResetIn(pick.window.resetAtMs, nowMs)}.
      </p>
    </div>
  );
}
