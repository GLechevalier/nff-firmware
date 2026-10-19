import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useCurrentProject } from '../context/CurrentProjectContext';

// The current project's agent token spend for today (UTC day), read from
// project_token_usage — the per-project/per-day accumulator the nff-agent-worker
// writes (migration 08). Initial fetch + Realtime, so the number ticks up live as
// runs finish, exactly like useAgentConsole.
//
// `ceiling` is the DISPLAY cap, optionally supplied via VITE_AGENT_DAILY_TOKEN_CEILING
// so the UI can show a progress bar. The authoritative cap lives in the worker
// (PROJECT_DAILY_TOKEN_CEILING); keep the two in sync, or leave this unset to just
// show the raw count.
const CEILING = Math.max(0, Number(import.meta.env.VITE_AGENT_DAILY_TOKEN_CEILING ?? 0));

// UTC calendar day (YYYY-MM-DD), matching the worker's bucket key.
const utcDay = () => new Date().toISOString().slice(0, 10);

export function useTokenUsage() {
  const { currentProjectId } = useCurrentProject();
  const [tokensToday, setTokensToday] = useState<number | null>(null);

  useEffect(() => {
    if (!currentProjectId) return;
    let cancelled = false;
    const today = utcDay();

    supabase
      .from('project_token_usage')
      .select('tokens_used')
      .eq('project_id', currentProjectId)
      .eq('usage_date', today)
      .limit(1)
      .then(({ data }) => {
        if (cancelled) return;
        const row = data?.[0] as { tokens_used?: number } | undefined;
        setTokensToday(Number(row?.tokens_used ?? 0));
      });

    const channelId = Math.random().toString(36).slice(2);
    const channel = supabase
      .channel(`token-usage-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_token_usage', filter: `project_id=eq.${currentProjectId}` }, payload => {
        const row = payload.new as { usage_date?: string; tokens_used?: number };
        // Ignore other days' buckets (a midnight rollover inserts a fresh row).
        if (row.usage_date && row.usage_date !== utcDay()) return;
        if (typeof row.tokens_used === 'number') setTokensToday(row.tokens_used);
      })
      .subscribe();

    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [currentProjectId]);

  return { tokensToday, ceiling: CEILING > 0 ? CEILING : null };
}
