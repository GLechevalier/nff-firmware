import { useEffect, useId, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useCurrentProject } from '../context/CurrentProjectContext';
import { shortLabel, type PolicyState, type StateDimensions } from '../data/policyGraph';

// Live feed of the SINGLE most recent policy-graph observation for the current project — the
// edge the worker just recorded via record_policy_transition (nff-db 0067/0068). Unlike
// usePolicyGraph (which refetches the whole graph for the Policy tab), this surfaces the
// individual event so the self-heal demo can dramatize "the policy layer's nodes activating"
// (PolicyActivityToast). Edges are AGGREGATED rows keyed (project, from, action, to) with
// `count` bumped on repeat, so an activation arrives as an INSERT *or* UPDATE — we subscribe
// to both and key each observation by count.
//
// Correlation is time-based only: the RPC carries no session id, so we simply listen while
// the self-heal story is armed. A concurrent unrelated agent run in the same project would
// also pop the toast — an accepted demo risk.

export interface PolicyActivationNode {
  id: string;
  label: string; // shortLabel() caption, or the truncated state id until the detail fetch lands
  summary: string;
  visitCount: number;
}

export interface PolicyActivation {
  key: string; // `${from}|${action}|${to}|${count}` — changes on every observation, drives re-animation
  action: string;
  count: number;
  successCount: number;
  from: PolicyActivationNode | null; // null label detail until the policy_states fetch lands
  to: PolicyActivationNode | null;
  at: number;
}

function placeholderNode(id: string): PolicyActivationNode {
  return { id, label: id.slice(0, 8), summary: '', visitCount: 0 };
}

export function usePolicyActivation(armed: boolean): PolicyActivation | null {
  const { currentProjectId } = useCurrentProject();
  // Deliberately NOT cleared on disarm: the toast's own dismiss timer owns teardown, so a
  // transition that lands right as the story resolves still gets its full dwell.
  const [activation, setActivation] = useState<PolicyActivation | null>(null);
  // Instance-unique channel topic (see useCrashReports) so multiple consumers don't
  // collide on the same Realtime channel.
  const instanceId = useId();

  useEffect(() => {
    if (!armed || !currentProjectId) return;
    let cancelled = false;

    const channel = supabase
      .channel(`policy_activation:${currentProjectId}:${instanceId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'policy_transitions', filter: `project_id=eq.${currentProjectId}` },
        (payload) => {
          const row = payload.new as Record<string, unknown> | null;
          if (!row || typeof row.from_state !== 'string') return;
          const from = row.from_state as string;
          const action = (row.action as string | null) ?? '';
          const to = (row.to_state as string | null) ?? '';
          const count = (row.count as number | null) ?? 0;
          const key = `${from}|${action}|${to}|${count}`;
          setActivation({
            key,
            action,
            count,
            successCount: (row.success_count as number | null) ?? 0,
            from: placeholderNode(from),
            to: placeholderNode(to),
            at: Date.now(),
          });
          // Patch in the endpoint labels. The RPC upserts states before the edge in the same
          // transaction, so they're committed by the time the edge event arrives. Guarded by
          // `key` so a late response can't clobber a newer observation. A procedure-mode burst
          // coalesces single-slot (last event wins) — same philosophy as noteActivity.
          void supabase
            .from('policy_states')
            .select('state_id, summary, dimensions, visit_count')
            .eq('project_id', currentProjectId)
            .in('state_id', [from, to])
            .then(({ data }) => {
              if (cancelled || !data) return;
              const byId = new Map(data.map((r) => [r.state_id as string, r]));
              const node = (id: string): PolicyActivationNode => {
                const r = byId.get(id);
                if (!r) return placeholderNode(id);
                const state: PolicyState = {
                  id,
                  summary: (r.summary as string | null) ?? '',
                  dimensions: (r.dimensions as StateDimensions | null) ?? { cohorts: [], infra: null },
                  visitCount: (r.visit_count as number | null) ?? 0,
                  lastSeen: new Date(0),
                };
                return { id, label: shortLabel(state), summary: state.summary, visitCount: state.visitCount };
              };
              setActivation((cur) =>
                cur && cur.key === key ? { ...cur, from: node(from), to: node(to) } : cur);
            });
        })
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [armed, currentProjectId, instanceId]);

  return activation;
}
