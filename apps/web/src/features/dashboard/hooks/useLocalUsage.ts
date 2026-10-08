import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildDemoLocalUsage } from '../demoLocalUsage';
import { summarizeLocalUsage, type LocalUsagePayload, type LocalUsageSummary } from '../localUsageModel';

const REFRESH_MS = 5 * 60_000;
// Same-origin path: `tailscale serve --set-path /local-usage` forwards it to tools/local-usage/server.mjs.
const ENDPOINT = '/local-usage/data.json';

export interface UseLocalUsageReturn {
  summary: LocalUsageSummary | null;
  loading: boolean;
  /** False when the helper is not running, so the dashboard can hide those tiles instead of showing zeros. */
  available: boolean;
  generatedAt: number | null;
  refresh: () => Promise<void>;
}

export function useLocalUsage(): UseLocalUsageReturn {
  const demoPayload = useMemo(() => (__DEMO_SITE__ ? buildDemoLocalUsage() : undefined), []);
  const [payload, setPayload] = useState<LocalUsagePayload | null>(demoPayload ?? null);
  const [loading, setLoading] = useState(!demoPayload);
  const [available, setAvailable] = useState(Boolean(demoPayload));

  const refresh = useCallback(async () => {
    if (demoPayload) return;
    try {
      const response = await fetch(ENDPOINT, { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as LocalUsagePayload;
      setPayload(data);
      setAvailable(true);
    } catch {
      setAvailable(false);
    } finally {
      setLoading(false);
    }
  }, [demoPayload]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const summary = useMemo(() => (payload ? summarizeLocalUsage(payload.rows) : null), [payload]);
  return { summary, loading, available, generatedAt: payload?.generatedAt ?? null, refresh };
}
