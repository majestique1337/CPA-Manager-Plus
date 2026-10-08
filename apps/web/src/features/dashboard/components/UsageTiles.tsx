import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CLAUDE_HUE,
  CODEX_HUE,
  fmtTokens,
  type HeatCell,
  type LocalUsageSummary,
  type RankedItem,
  type TrendDay,
} from '../localUsageModel';
import styles from './Panels.module.scss';


const fmtUsd = (n: number) =>
  n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;

const shortDate = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export function SpendTile({ summary }: { summary: LocalUsageSummary }) {
  const { t } = useTranslation();
  const claude = summary.trend.reduce((s, d) => s + d.claude, 0);
  const codex = summary.trend.reduce((s, d) => s + d.codex, 0);
  const total = Math.max(1, claude + codex);
  return (
    <section className={styles.tile}>
      <header className={styles.tileHead}>
        <h2>{t('dashboard.spend', { defaultValue: 'Spend, last 30 days' })}</h2>
      </header>
      <div>
        <div className={`${styles.spendValue} ${styles.numeral}`}>{fmtUsd(summary.spend)}</div>
        <p className={styles.spendNote}>
          {t('dashboard.spend_note', { defaultValue: 'What this would cost at API list prices' })}
        </p>
      </div>
      <div className={styles.split} aria-hidden>
        <span style={{ flex: claude / total, background: CLAUDE_HUE }} />
        <span style={{ flex: codex / total, background: CODEX_HUE }} />
      </div>
      <div className={styles.legend}>
        <span style={{ ['--swatch' as string]: CLAUDE_HUE }}>
          <i />
          Claude {fmtTokens(claude)}
        </span>
        <span style={{ ['--swatch' as string]: CODEX_HUE }}>
          <i />
          Codex {fmtTokens(codex)}
        </span>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>{t('dashboard.tokens', { defaultValue: 'Tokens' })}</dt>
          <dd className={styles.numeral}>{fmtTokens(summary.tokens)}</dd>
        </div>
        <div>
          <dt>{t('dashboard.cache_share', { defaultValue: 'Served from cache' })}</dt>
          <dd className={styles.numeral}>{Math.round(summary.cacheShare * 100)}%</dd>
        </div>
      </dl>
    </section>
  );
}

export function TrendTile({ trend }: { trend: TrendDay[] }) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const peak = useMemo(() => Math.max(1, ...trend.map((d) => d.claude + d.codex)), [trend]);
  const active = hover !== null ? trend[hover] : null;
  return (
    <section className={styles.tile}>
      <header className={styles.tileHead}>
        <h2>{t('dashboard.trend', { defaultValue: 'Tokens per day' })}</h2>
        <span className={styles.tileMeta}>
          {active
            ? `${shortDate(active.date)}: ${fmtTokens(active.claude + active.codex)}`
            : `Busiest ${fmtTokens(peak)}`}
        </span>
      </header>
      <div className={styles.trend} onMouseLeave={() => setHover(null)}>
        {trend.map((day, index) => {
          const sum = day.claude + day.codex;
          return (
            <div
              key={day.date}
              className={styles.trendDay}
              data-active={hover === index}
              data-empty={sum === 0}
              onMouseEnter={() => setHover(index)}
              title={`${shortDate(day.date)}: ${fmtTokens(sum)}`}
            >
              {sum === 0 ? (
                <em />
              ) : (
                <>
                  <span style={{ height: `${(day.codex / peak) * 100}%`, ['--swatch' as string]: CODEX_HUE }} />
                  <span style={{ height: `${(day.claude / peak) * 100}%`, ['--swatch' as string]: CLAUDE_HUE }} />
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className={styles.axis}>
        <span>{shortDate(trend[0].date)}</span>
        <span>{shortDate(trend[trend.length - 1].date)}</span>
      </div>
    </section>
  );
}

export function RankTile({
  title,
  items,
  label,
  hueOf,
}: {
  title: string;
  items: RankedItem[];
  label?: (name: string) => string;
  hueOf?: (name: string) => string | undefined;
}) {
  const peak = Math.max(1, ...items.map((i) => i.tokens));
  return (
    <section className={styles.tile}>
      <header className={styles.tileHead}>
        <h2>{title}</h2>
      </header>
      {items.length === 0 ? (
        <p className={styles.quiet}>Nothing recorded in the last 30 days.</p>
      ) : (
        <ul className={styles.ranks}>
          {items.map((item) => (
            <li key={item.name} className={styles.rank} title={`${item.name} · ${fmtUsd(item.cost)}`}>
              <span className={styles.rankName}>{label ? label(item.name) : item.name}</span>
              <span className={styles.rankBar} style={{ ['--swatch' as string]: hueOf?.(item.name) }}>
                <span style={{ width: `${(item.tokens / peak) * 100}%` }} />
              </span>
              <span className={`${styles.rankValue} ${styles.numeral}`}>{fmtTokens(item.tokens)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HeatmapTile({ summary }: { summary: LocalUsageSummary }) {
  const { t } = useTranslation();
  const cells: HeatCell[] = summary.heat.flat();
  return (
    <section className={styles.tile}>
      <header className={styles.tileHead}>
        <h2>{t('dashboard.activity', { defaultValue: 'Last 13 weeks' })}</h2>
      </header>
      <div className={styles.heatWrap}>
        <div className={styles.heat} role="img" aria-label="Daily activity, last 13 weeks">
          {cells.map((cell) => (
            <span
              key={cell.date}
              className={styles.cell}
              data-level={cell.level}
              title={`${shortDate(cell.date)}: ${fmtTokens(cell.tokens)}`}
            />
          ))}
        </div>
        <div className={styles.heatStats}>
          <div className={`${styles.total} ${styles.numeral}`}>{fmtTokens(summary.totalTokens)}</div>
          <dl>
            <dt>Active days</dt>
            <dd>{summary.activeDays}</dd>
            <dt>Streak</dt>
            <dd>{summary.streak} {summary.streak === 1 ? 'day' : 'days'}</dd>
            {summary.busiest ? (
              <>
                <dt>Busiest</dt>
                <dd>{shortDate(summary.busiest.date)}, {fmtTokens(summary.busiest.tokens)}</dd>
              </>
            ) : null}
          </dl>
        </div>
      </div>
    </section>
  );
}
