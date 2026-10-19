import { useCallback, useEffect } from 'react';
import { apiGetCached } from '../lib/api';
import { useResource } from '../lib/resourceCache';

/**
 * Fetch an /api path on mount and every `intervalMs`, with manual refresh.
 *
 * The value is held in the module-level resource cache, not in component state, so it SURVIVES the
 * unmount that App.tsx's `{tab === 'x' && <XTab/>}` switch performs on every tab change. Coming back
 * to a tab paints the cached value immediately instead of flashing "Loading…" and refetching.
 *
 * `intervalMs` doubles as the staleness window: it already declares how fresh this data needs to be,
 * so a remount inside that window serves the cache and anything older revalidates in the background.
 *
 * Parsimony:
 * - conditional requests (apiGetCached): unchanged payloads come back as empty 304s;
 * - ticks are refreshIfStale, not force — N consumers of one path collapse to ~1 fetch/interval.
 *   The 0.75 factor is load-bearing: fetchedAt stamps at fetch COMPLETION, so at the next tick the
 *   entry's age is interval − latency; a full-interval threshold would skip every other tick and
 *   silently halve the poll rate;
 * - hidden browser tabs stop polling entirely and catch up on the next visibilitychange.
 */
export function useApiPoll<T>(path: string, intervalMs: number) {
  const fetcher = useCallback(() => apiGetCached<T>(path), [path]);
  const { data, error, loading, refresh, refreshIfStale } = useResource<T>(path, fetcher, {
    staleMs: intervalMs,
  });

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void refreshIfStale(intervalMs * 0.75);
    }, intervalMs);
    const onVisible = () => {
      if (!document.hidden) void refreshIfStale(intervalMs);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshIfStale, intervalMs]);

  return { data, error, loading, refresh };
}
