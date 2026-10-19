import { useEffect, useId, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useCurrentProject } from '../context/CurrentProjectContext';
import type { PolicyState, PolicyTransition, StateDimensions } from '../data/policyGraph';

// Reads the Layer-2 policy graph (policy_states + policy_transitions) for the current
// project over RLS — the same browser/anon-key pattern as useBrainGraph — and keeps it
// live via a Realtime subscription on both tables (the useCrashReports idiom), so the
// graph thickens in place as shadow runs land. Both tables are member-read + published
// in migration 0068.

function mapState(row: Record<string, unknown>): PolicyState {
  return {
    id: row.state_id as string,
    summary: (row.summary as string | null) ?? '',
    dimensions: (row.dimensions as StateDimensions | null) ?? { cohorts: [], infra: null },
    visitCount: (row.visit_count as number | null) ?? 0,
    lastSeen: new Date(row.last_seen as string),
  };
}

function mapTransition(row: Record<string, unknown>): PolicyTransition {
  return {
    from: row.from_state as string,
    action: row.action as string,
    to: row.to_state as string,
    count: (row.count as number | null) ?? 0,
    successCount: (row.success_count as number | null) ?? 0,
    refutedCount: (row.refuted_count as number | null) ?? 0,
    sumShots: (row.sum_shots as number | null) ?? 0,
    sumWallMs: (row.sum_wall_ms as number | null) ?? 0,
    sumTokens: (row.sum_tokens as number | null) ?? 0,
    sumWastedSteps: (row.sum_wasted_steps as number | null) ?? 0,
    lastSeen: new Date(row.last_seen as string),
  };
}

export function usePolicyGraph() {
  const { currentProjectId } = useCurrentProject();
  const [states, setStates] = useState<PolicyState[]>([]);
  const [transitions, setTransitions] = useState<PolicyTransition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Instance-unique channel topic (see useCrashReports) so multiple consumers don't
  // collide on the same Realtime channel.
  const instanceId = useId();

  useEffect(() => {
    if (!currentProjectId) return;
    let cancelled = false;

    async function load() {
      const [statesResult, edgesResult] = await Promise.all([
        supabase.from('policy_states').select('*').eq('project_id', currentProjectId),
        supabase.from('policy_transitions').select('*').eq('project_id', currentProjectId),
      ]);
      if (cancelled) return;
      if (statesResult.error) { setError(statesResult.error.message); setLoading(false); return; }
      if (edgesResult.error) { setError(edgesResult.error.message); setLoading(false); return; }

      const rawStates = (statesResult.data ?? []).map((r) => mapState(r as Record<string, unknown>));
      // Drop edges whose endpoints aren't both present, so the renderer never dereferences
      // a missing node (mirrors useBrainGraph).
      const ids = new Set(rawStates.map((s) => s.id));
      const rawEdges = (edgesResult.data ?? [])
        .map((r) => mapTransition(r as Record<string, unknown>))
        .filter((e) => ids.has(e.from) && ids.has(e.to));

      setStates(rawStates);
      setTransitions(rawEdges);
      setError(null);
      setLoading(false);
    }

    load();

    // Realtime: refetch (debounced) on any change to either table so both nodes and edges
    // stay in sync as the worker upserts them.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refetch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void load(); }, 300);
    };
    const channel = supabase
      .channel(`policy_graph:${currentProjectId}:${instanceId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'policy_states', filter: `project_id=eq.${currentProjectId}` },
        refetch)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'policy_transitions', filter: `project_id=eq.${currentProjectId}` },
        refetch)
      .subscribe();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [currentProjectId, instanceId]);

  return { states, transitions, loading, error };
}
