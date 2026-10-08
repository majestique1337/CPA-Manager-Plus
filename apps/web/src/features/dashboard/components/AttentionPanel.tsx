import { useTranslation } from 'react-i18next';
import type { DashboardSummaryResponse } from '@/services/api/usageService';
import { PROVIDER_LABEL, formatResetIn, pickDisplayWindows, type QuotaAccountView } from '../quotaModel';
import styles from './Panels.module.scss';

interface AttentionPanelProps {
  accounts: QuotaAccountView[];
  failures: DashboardSummaryResponse['recent_failures'];
  nowMs: number;
}

const ago = (ms: number, nowMs: number) => {
  const minutes = Math.max(0, Math.round((nowMs - ms) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
};

interface Item {
  key: string;
  title: string;
  detail: string;
  when?: string;
}

/** Only renders when something is actually wrong, so a quiet dashboard stays quiet. */
export function AttentionPanel({ accounts, failures, nowMs }: AttentionPanelProps) {
  const { t } = useTranslation();

  const items: Item[] = [
    ...accounts
      .filter((account) => account.status === 'error')
      .map((account) => ({
        key: `quota:${account.id}`,
        title: account.name,
        detail: `${PROVIDER_LABEL[account.provider]} quota could not be read${account.error ? ` · ${account.error}` : ''}`,
      })),
    ...accounts.flatMap((account) =>
      account.status === 'ready'
        ? pickDisplayWindows(account)
            .filter((win) => win.usedPercent !== null && win.usedPercent >= 99.5)
            .map((win) => ({
              key: `out:${account.id}:${win.id}`,
              title: account.name,
              detail: `${PROVIDER_LABEL[account.provider]} ${win.scope ? `${win.label} ${win.scope}` : win.label} exhausted · resets in ${formatResetIn(win.resetAtMs, nowMs)}`,
            }))
        : []
    ),
    ...failures.slice(0, 4).map((failure) => ({
      key: `fail:${failure.timestamp_ms}:${failure.source_hash}`,
      title: failure.model || failure.endpoint,
      detail:
        failure.fail_summary ||
        (failure.fail_status_code ? `HTTP ${failure.fail_status_code}` : 'Request failed'),
      when: ago(failure.timestamp_ms, nowMs),
    })),
  ].slice(0, 5);

  if (items.length === 0) return null;

  return (
    <section className={styles.tile}>
      <header className={styles.tileHead}>
        <h2>{t('dashboard.attention', { defaultValue: 'Needs attention' })}</h2>
      </header>
      <ul className={styles.attention}>
        {items.map((item) => (
          <li key={item.key}>
            <span className={styles.attentionDot} aria-hidden />
            <div>
              <strong title={item.title}>{item.title}</strong>
              <span title={item.detail}>{item.detail}</span>
            </div>
            {item.when ? <time>{item.when}</time> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
