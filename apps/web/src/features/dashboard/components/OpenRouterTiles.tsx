import { useState } from 'react';
import { fmtTokens, type LocalUsageSummary, type TrendDay } from '../localUsageModel';
import styles from './OpenRouterTiles.module.scss';

const fmtUsd = (n: number) =>
  n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;
const shortDate = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function Sparkline({ values }: { values: number[] }) {
  const peak = Math.max(1e-9, ...values);
  const step = 100 / Math.max(1, values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(26 - (v / peak) * 24).toFixed(1)}`)
    .join(' ');
  return (
    <svg className={styles.spark} viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Kpi({
  label,
  value,
  values,
  now,
  prev,
  lowerIsBetter,
}: {
  label: string;
  value: string;
  values: number[];
  now: number;
  prev: number;
  lowerIsBetter?: boolean;
}) {
  const change = prev > 0 ? (now / prev - 1) * 100 : null;
  const good = change === null ? true : lowerIsBetter ? change <= 0 : change >= 0;
  return (
    <section className={styles.kpi}>
      <span className={styles.kpiLabel}>{label}</span>
      <div className={styles.kpiBody}>
        <strong className={styles.kpiValue}>{value}</strong>
        <Sparkline values={values} />
      </div>
      {change !== null ? (
        <span className={styles.kpiDelta} data-good={good}>
          {change >= 0 ? '↑' : '↓'} {Math.abs(change).toFixed(1)}% vs prev period
        </span>
      ) : (
        <span className={styles.kpiDelta}>no earlier data</span>
      )}
    </section>
  );
}

/** Four KPI tiles with a sparkline and a delta against the previous period, like OpenRouter's Activity page. */
export function KpiRow({ summary }: { summary: LocalUsageSummary }) {
  const t = summary.trend;
  const blended = summary.tokens > 0 ? (summary.spend / summary.tokens) * 1e6 : 0;
  const prevBlended = summary.prevTokens > 0 ? (summary.prevSpend / summary.prevTokens) * 1e6 : 0;
  const tokensOf = (d: TrendDay) => d.in + d.out + d.cr + d.cw;
  return (
    <div className={styles.kpis}>
      <Kpi
        label="Total spend"
        value={fmtUsd(summary.spend)}
        values={t.map((d) => d.cost)}
        now={summary.spend}
        prev={summary.prevSpend}
        lowerIsBetter
      />
      <Kpi
        label="Token volume"
        value={fmtTokens(summary.tokens)}
        values={t.map(tokensOf)}
        now={summary.tokens}
        prev={summary.prevTokens}
      />
      <Kpi
        label="Cache hit rate"
        value={`${(summary.cacheShare * 100).toFixed(1)}%`}
        values={t.map((d) => (tokensOf(d) > 0 ? d.cr / tokensOf(d) : 0))}
        now={summary.cacheShare}
        prev={summary.prevCacheShare}
      />
      <Kpi
        label="Blended $/1M"
        value={`$${blended.toFixed(2)}`}
        values={t.map((d) => (tokensOf(d) > 0 ? d.cost / tokensOf(d) : 0))}
        now={blended}
        prev={prevBlended}
        lowerIsBetter
      />
    </div>
  );
}

interface Series {
  name: string;
  hue: string;
  of: (d: TrendDay) => number;
}

function StackedChart({
  title,
  trend,
  series,
}: {
  title: string;
  trend: TrendDay[];
  series: Series[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const total = (d: TrendDay) => series.reduce((n, s) => n + s.of(d), 0);
  const peak = Math.max(1, ...trend.map(total));
  const active = hover !== null ? trend[hover] : null;
  return (
    <section className={styles.chart}>
      <header>
        <h2>{title}</h2>
        <span>
          {active
            ? `${shortDate(active.date)}: ${series.map((s) => `${s.name} ${fmtTokens(s.of(active))}`).join(' · ')}`
            : `Peak ${fmtTokens(peak)}`}
        </span>
      </header>
      <div className={styles.bars} onMouseLeave={() => setHover(null)}>
        {trend.map((day, i) => (
          <div key={day.date} data-active={hover === i} onMouseEnter={() => setHover(i)}>
            {series.map((s) => (
              <span
                key={s.name}
                style={{ height: `${(s.of(day) / peak) * 100}%`, background: s.hue }}
              />
            ))}
          </div>
        ))}
      </div>
      <footer>
        {series.map((s) => (
          <span key={s.name} style={{ ['--swatch' as string]: s.hue }}>
            <i />
            {s.name}
          </span>
        ))}
      </footer>
    </section>
  );
}

export function BreakdownCharts({ trend }: { trend: TrendDay[] }) {
  return (
    <div className={styles.charts}>
      <StackedChart
        title="Token breakdown"
        trend={trend}
        series={[
          { name: 'Prompt', hue: '#5b8def', of: (d) => d.in },
          { name: 'Completion', hue: '#a96bf0', of: (d) => d.out },
          { name: 'Cache write', hue: '#f0647a', of: (d) => d.cw },
        ]}
      />
      <StackedChart
        title="Prompt token caching"
        trend={trend}
        series={[
          { name: 'Uncached', hue: '#8b93a3', of: (d) => d.in + d.cw },
          { name: 'Cached', hue: '#f0a93b', of: (d) => d.cr },
        ]}
      />
    </div>
  );
}
