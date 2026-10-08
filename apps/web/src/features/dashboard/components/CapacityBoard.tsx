import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PROVIDER_LABEL,
  PROVIDER_ORDER,
  burnScore,
  elapsedFraction,
  formatPlan,
  formatResetIn,
  pickDisplayWindows,
  resolvePace,
  summarizeProvider,
  type QuotaAccountView,
  type QuotaProvider,
  type QuotaWindowView,
} from '../quotaModel';
import styles from './CapacityBoard.module.scss';

interface CapacityBoardProps {
  accounts: QuotaAccountView[];
  loading: boolean;
  nowMs: number;
}

type Tone = 'ok' | 'low' | 'critical' | 'none';

// Colour only what needs attention: burning faster than the reset clock, or out.
// Windows without a known length (e.g. Antigravity) fall back to plain thresholds.
const toneFor = (win: QuotaWindowView, nowMs: number): Tone => {
  if (win.usedPercent === null) return 'none';
  const pace = resolvePace(win, nowMs);
  if (pace === 'exhausted') return 'critical';
  if (pace === 'over') return 'low';
  if (pace === 'idle') {
    const remaining = 100 - win.usedPercent;
    return remaining <= 10 ? 'critical' : remaining <= 30 ? 'low' : 'ok';
  }
  return 'ok';
};

const formatPercent = (value: number) =>
  value >= 99.5 ? '100' : value < 0.5 ? '0' : Math.round(value);

function WindowMeter({ win, nowMs }: { win: QuotaWindowView; nowMs: number }) {
  const remaining = win.usedPercent === null ? null : 100 - win.usedPercent;
  const elapsed = elapsedFraction(win, nowMs);
  const pace = resolvePace(win, nowMs);
  const tone = toneFor(win, nowMs);
  const paceHint =
    pace === 'under'
      ? 'Using slower than the reset clock — some of this will go unused'
      : pace === 'over'
        ? 'Burning faster than the reset clock'
        : pace === 'exhausted'
          ? 'Exhausted until reset'
          : undefined;
  const label = win.scope
    ? `${win.label} ${win.scope}`
    : win.kind === 'session'
      ? 'Session'
      : win.kind === 'weekly'
        ? 'Week'
        : win.label;
  const reset = formatResetIn(win.resetAtMs, nowMs);

  return (
    <div className={styles.meter} title={paceHint}>
      <span className={styles.meterLabel} title={label}>
        {label}
      </span>
      <div className={styles.track} data-tone={tone}>
        <div className={styles.fill} style={{ width: `${remaining ?? 0}%` }} />
        {elapsed !== null && (
          <span className={styles.pace} style={{ left: `${(1 - elapsed) * 100}%` }} />
        )}
      </div>
      <span className={styles.meterValue} data-tone={tone}>
        {remaining === null ? (
          '—'
        ) : (
          <>
            {formatPercent(remaining)}%<small> left</small>
          </>
        )}
      </span>
      <span className={styles.meterReset} title="Time until this window resets">
        {reset === '—' || reset === 'now' ? reset : `in ${reset}`}
      </span>
    </div>
  );
}

function AccountBlock({
  account,
  nowMs,
  burnFirst,
}: {
  account: QuotaAccountView;
  nowMs: number;
  burnFirst: boolean;
}) {
  const windows = useMemo(() => pickDisplayWindows(account), [account]);
  const plan = formatPlan(account.plan);
  return (
    <div className={styles.account} data-status={account.status} data-burn={burnFirst || undefined}>
      <div className={styles.identity}>
        <span className={styles.name} title={account.name}>
          {account.name}
        </span>
        {plan ? <span className={styles.plan}>{plan}</span> : null}
        {burnFirst ? <span className={styles.burn}>Use first</span> : null}
      </div>
      {account.status === 'error' ? (
        <span className={styles.rowMessage} title={account.error}>
          Quota unavailable{account.error ? `: ${account.error}` : ''}
        </span>
      ) : windows.length === 0 ? (
        <span className={styles.rowMessage}>
          {account.status === 'loading' ? 'Reading quota…' : 'No quota data yet'}
        </span>
      ) : (
        <div className={styles.meters}>
          {windows.map((win) => (
            <WindowMeter key={win.id} win={win} nowMs={nowMs} />
          ))}
        </div>
      )}
    </div>
  );
}

export function CapacityBoard({ accounts, loading, nowMs }: CapacityBoardProps) {
  const { t } = useTranslation();

  // Within a provider the list order is the recommendation: best account to spend first on top.
  const groups = useMemo(() => {
    const map = new Map<QuotaProvider, QuotaAccountView[]>();
    accounts.forEach((account) => {
      map.set(account.provider, [...(map.get(account.provider) ?? []), account]);
    });
    return PROVIDER_ORDER.filter((provider) => map.has(provider)).map((provider) => {
      const scored = (map.get(provider) ?? []).map((account) => ({
        account,
        score: burnScore(account, nowMs)?.score ?? -1,
      }));
      scored.sort((a, b) => b.score - a.score);
      const top = scored.length > 1 && scored[0].score >= 0 ? scored[0].account.id : null;
      const list = scored.map((s) => s.account);
      const wide = list.some((a) =>
        pickDisplayWindows(a).some((w) => w.kind === 'other' || w.scope)
      );
      return { provider, accounts: list, burnId: top, wide };
    });
  }, [accounts, nowMs]);

  if (loading && accounts.length === 0) {
    return (
      <div className={styles.providers} aria-hidden>
        {[0, 1, 2].map((i) => (
          <div key={i} className={styles.skeleton} />
        ))}
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className={styles.empty}>
        <strong>{t('dashboard.no_accounts', { defaultValue: 'No accounts yet' })}</strong>
        <span>
          {t('dashboard.no_accounts_hint', {
            defaultValue: 'Add one under OAuth Login and its quota appears here.',
          })}
        </span>
      </div>
    );
  }

  return (
    <>
      <div className={styles.providers}>
        {groups.map(({ provider, accounts: list, burnId, wide }) => {
          const summary = summarizeProvider(list);
          return (
            <section
              key={provider}
              className={styles.tile}
              data-provider={provider}
              data-wide={wide || undefined}
              aria-label={PROVIDER_LABEL[provider]}
            >
              <header className={styles.tileHead}>
                <h2>
                  <i aria-hidden />
                  {PROVIDER_LABEL[provider]}
                </h2>
                <span className={styles.tileMeta}>
                  {summary.remainingPercent !== null
                    ? `${Math.round(summary.remainingPercent)}% of the week left`
                    : `${list.length} ${list.length === 1 ? 'account' : 'accounts'}`}
                </span>
              </header>
              {list.map((account) => (
                <AccountBlock
                  key={account.id}
                  account={account}
                  nowMs={nowMs}
                  burnFirst={account.id === burnId}
                />
              ))}
            </section>
          );
        })}
      </div>
      <p className={styles.footnote}>
        {t('dashboard.pace_legend', {
          defaultValue: 'Bars show what is left. The tick marks where an even pace would put you.',
        })}
      </p>
    </>
  );
}
