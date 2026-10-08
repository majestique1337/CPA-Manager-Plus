import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useAuthStore, useConfigStore } from '@/stores';
import { normalizeRoutingStrategy } from '@/utils/routingStrategy';
import { AttentionPanel } from './components/AttentionPanel';
import { CapacityBoard } from './components/CapacityBoard';
import { HeatmapTile, RankTile, SpendTile, TrendTile } from './components/UsageTiles';
import { modelHue, prettyModel } from './localUsageModel';
import { UseFirstHero } from './components/UseFirstHero';
import { useDashboardQuota } from './hooks/useDashboardQuota';
import { useDashboardUsageSummary } from './hooks/useDashboardUsageSummary';
import { useLocalUsage } from './hooks/useLocalUsage';
import styles from './DashboardPage.module.scss';

const CLOCK_TICK_MS = 30_000;

const formatAgo = (fromMs: number | null, nowMs: number) => {
  if (fromMs === null) return '';
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (seconds < 45) return 'Updated just now';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `Updated ${minutes}m ago` : `Updated ${Math.round(minutes / 60)}h ago`;
};

const ROUTING_LABEL: Record<string, string> = {
  'round-robin': 'Round robin',
  'weighted-round-robin': 'Weighted round robin',
  'fill-first': 'Fill first',
};

export function DashboardPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const apiBase = useAuthStore((state) => state.apiBase);
  const config = useConfigStore((state) => state.config);
  const usage = useDashboardUsageSummary();
  const quota = useDashboardQuota();
  const local = useLocalUsage();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const refreshAll = useCallback(async () => {
    setNowMs(Date.now());
    await Promise.all([quota.refresh(), usage.refresh(), local.refresh()]);
  }, [quota, usage, local]);

  useHeaderRefresh(refreshAll);

  const routingRaw = config?.routingStrategy?.trim() ?? '';
  const routingKey = normalizeRoutingStrategy(routingRaw);
  const routing = routingRaw ? (routingKey && ROUTING_LABEL[routingKey]) || routingRaw : '';
  const lastUpdate = Math.max(quota.lastUpdatedAt ?? 0, usage.lastRefreshedAt?.getTime() ?? 0) || null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <UseFirstHero accounts={quota.accounts} loading={quota.loading} nowMs={nowMs} />
        <div className={styles.status}>
          <i className={styles.dot} data-state={connectionStatus} />
          <span title={apiBase}>
            {connectionStatus === 'connected'
              ? apiBase.replace(/^https?:\/\//, '')
              : connectionStatus === 'connecting'
                ? t('common.connecting')
                : t('common.disconnected')}
          </span>
          <span className={styles.updated}>{formatAgo(lastUpdate, nowMs)}</span>
        </div>
      </header>

      <AttentionPanel accounts={quota.accounts} failures={usage.recentFailures} nowMs={nowMs} />

      <CapacityBoard accounts={quota.accounts} loading={quota.loading} nowMs={nowMs} />

      {local.summary ? (
        <>
          <div className={styles.rowSpend}>
            <SpendTile summary={local.summary} />
            <TrendTile trend={local.summary.trend} />
          </div>
          <div className={styles.rowRanks}>
            <RankTile
              title={t('dashboard.models', { defaultValue: 'Models' })}
              items={local.summary.models}
              label={prettyModel}
              hueOf={modelHue}
            />
            <RankTile title={t('dashboard.projects', { defaultValue: 'Projects' })} items={local.summary.projects} />
            <HeatmapTile summary={local.summary} />
          </div>
        </>
      ) : !local.loading ? (
        <p className={styles.hint}>
          Spend, models and activity come from your local Claude and Codex logs. Start the helper in
          tools/local-usage to see them here.
        </p>
      ) : null}

      <footer className={styles.footer}>
        <span>CPAMP {__APP_VERSION__}</span>
        {serverVersion ? <span>Core {serverVersion}</span> : null}
        {routing ? <span>Routing: {routing}</span> : null}
      </footer>
    </div>
  );
}
