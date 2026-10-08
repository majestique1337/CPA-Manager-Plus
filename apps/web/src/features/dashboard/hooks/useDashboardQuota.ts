import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  KIMI_CONFIG,
  XAI_CONFIG,
  getQuotaStoreKey,
  refreshQuotaWithConfig,
} from '@/components/quota';
import { authFilesApi } from '@/services/api';
import { useAuthStore, useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { isDisabledAuthFile } from '@/utils/quota';
import {
  buildAntigravityAccount,
  buildClaudeAccount,
  buildCodexAccount,
  buildKimiAccount,
  buildXaiAccount,
  type QuotaAccountView,
  type QuotaProvider,
} from '../quotaModel';

const AUTO_REFRESH_MS = 5 * 60_000;
const STALE_AFTER_MS = 10 * 60_000;

const resolveProvider = (file: AuthFileItem): QuotaProvider | null => {
  const type = String(file.type ?? file.provider ?? '').toLowerCase();
  if (type.includes('claude') || type.includes('anthropic')) return 'claude';
  if (type.includes('codex') || type.includes('openai')) return 'codex';
  if (type.includes('antigravity')) return 'antigravity';
  if (type.includes('kimi')) return 'kimi';
  if (type.includes('xai') || type.includes('grok')) return 'xai';
  return null;
};

export interface UseDashboardQuotaReturn {
  accounts: QuotaAccountView[];
  loading: boolean;
  refreshing: boolean;
  lastUpdatedAt: number | null;
  refresh: () => Promise<void>;
}

export function useDashboardQuota(): UseDashboardQuotaReturn {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const requestScope = useMemo(() => ({ apiBase, managementKey }), [apiBase, managementKey]);

  const claudeQuota = useQuotaStore((s) => s.claudeQuota);
  const codexQuota = useQuotaStore((s) => s.codexQuota);
  const kimiQuota = useQuotaStore((s) => s.kimiQuota);
  const xaiQuota = useQuotaStore((s) => s.xaiQuota);
  const antigravityQuota = useQuotaStore((s) => s.antigravityQuota);
  const setClaudeQuota = useQuotaStore((s) => s.setClaudeQuota);
  const setCodexQuota = useQuotaStore((s) => s.setCodexQuota);
  const setKimiQuota = useQuotaStore((s) => s.setKimiQuota);
  const setXaiQuota = useQuotaStore((s) => s.setXaiQuota);
  const setAntigravityQuota = useQuotaStore((s) => s.setAntigravityQuota);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadFiles = useCallback(async () => {
    if (connectionStatus !== 'connected') return [] as AuthFileItem[];
    try {
      const response = await authFilesApi.list();
      const active = response.files.filter((file) => !isDisabledAuthFile(file));
      if (mountedRef.current) setFiles(active);
      return active;
    } catch {
      return [] as AuthFileItem[];
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [connectionStatus]);

  const refreshQuota = useCallback(
    async (targets: AuthFileItem[]) => {
      const isCurrent = () => mountedRef.current;
      const base = { t, isCurrent, requestScope };
      await Promise.allSettled(
        targets.map(async (file) => {
          switch (resolveProvider(file)) {
            case 'claude':
              return refreshQuotaWithConfig({
                ...base,
                config: CLAUDE_CONFIG,
                file,
                setQuota: setClaudeQuota,
                currentState: useQuotaStore.getState().claudeQuota[getQuotaStoreKey(CLAUDE_CONFIG, file)],
              });
            case 'codex':
              return refreshQuotaWithConfig({
                ...base,
                config: CODEX_CONFIG,
                file,
                setQuota: setCodexQuota,
                currentState: useQuotaStore.getState().codexQuota[getQuotaStoreKey(CODEX_CONFIG, file)],
              });
            case 'kimi':
              return refreshQuotaWithConfig({
                ...base,
                config: KIMI_CONFIG,
                file,
                setQuota: setKimiQuota,
                currentState: useQuotaStore.getState().kimiQuota[getQuotaStoreKey(KIMI_CONFIG, file)],
              });
            case 'xai':
              return refreshQuotaWithConfig({
                ...base,
                config: XAI_CONFIG,
                file,
                setQuota: setXaiQuota,
                currentState: useQuotaStore.getState().xaiQuota[getQuotaStoreKey(XAI_CONFIG, file)],
              });
            case 'antigravity':
              return refreshQuotaWithConfig({
                ...base,
                config: ANTIGRAVITY_CONFIG,
                file,
                setQuota: setAntigravityQuota,
                currentState:
                  useQuotaStore.getState().antigravityQuota[getQuotaStoreKey(ANTIGRAVITY_CONFIG, file)],
              });
            default:
              return null;
          }
        })
      );
    },
    [requestScope, setAntigravityQuota, setClaudeQuota, setCodexQuota, setKimiQuota, setXaiQuota, t]
  );

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRefreshing(true);
    try {
      const active = await loadFiles();
      await refreshQuota(active);
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setRefreshing(false);
    }
  }, [loadFiles, refreshQuota]);

  // First load: show cached quota immediately, then refresh anything stale.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const active = await loadFiles();
      if (cancelled || active.length === 0) return;
      const state = useQuotaStore.getState();
      const now = Date.now();
      const stale = active.filter((file) => {
        const provider = resolveProvider(file);
        if (!provider) return false;
        const store = {
          claude: state.claudeQuota,
          codex: state.codexQuota,
          kimi: state.kimiQuota,
          xai: state.xaiQuota,
          antigravity: state.antigravityQuota,
        }[provider] as Record<string, { fetchedAtMs?: number } | undefined>;
        const fetchedAt = Object.values(store).find(
          (entry) => (entry as { authFileName?: string } | undefined)?.authFileName === file.name
        )?.fetchedAtMs;
        return !fetchedAt || now - fetchedAt > STALE_AFTER_MS;
      });
      if (stale.length > 0) await refreshQuota(stale);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadFiles, refreshQuota]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const accounts = useMemo<QuotaAccountView[]>(() => {
    const find = <T extends { authFileName?: string }>(store: Record<string, T>, file: AuthFileItem) =>
      Object.values(store).find((entry) => entry.authFileName === file.name);
    return files.flatMap((file): QuotaAccountView[] => {
      switch (resolveProvider(file)) {
        case 'claude':
          return [buildClaudeAccount(file, find(claudeQuota, file))];
        case 'codex':
          return [buildCodexAccount(file, find(codexQuota, file))];
        case 'kimi':
          return [buildKimiAccount(file, find(kimiQuota, file))];
        case 'xai':
          return [buildXaiAccount(file, find(xaiQuota, file))];
        case 'antigravity':
          return [buildAntigravityAccount(file, find(antigravityQuota, file))];
        default:
          return [];
      }
    });
  }, [files, claudeQuota, codexQuota, kimiQuota, xaiQuota, antigravityQuota]);

  const lastUpdatedAt = useMemo(() => {
    const times = accounts.map((a) => a.fetchedAtMs).filter((v): v is number => v !== null);
    return times.length ? Math.max(...times) : null;
  }, [accounts]);

  return { accounts, loading, refreshing, lastUpdatedAt, refresh };
}
