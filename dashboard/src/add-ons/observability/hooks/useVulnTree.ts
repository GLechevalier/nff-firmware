import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import {
  makeNodeId,
  type NextCheck,
  type Outcome,
  type Severity,
  type VulnNode,
} from '../data/vulnTree';

// The vulnerability tree is now GLOBAL (one canonical tree the pentester owns),
// read from pentester_vuln_tree_nodes — not the deprecated project-scoped
// vuln_tree_nodes. Reads are open to any authenticated user; appends are gated to
// platform admins by RLS (a non-admin insert returns a policy error).

function mapRow(row: Record<string, unknown>): VulnNode {
  return {
    nodeId: row.node_id as string,
    parentId: (row.parent_id as string | null) ?? null,
    label: row.label as string,
    tool: (row.tool as string | null) ?? null,
    severity: row.severity as Severity,
    condition: (row.condition as unknown) ?? null,
    nextCheck: (row.next_check as NextCheck | null) ?? null,
    outcome: (row.outcome as Outcome | null) ?? null,
    origin: (row.origin as VulnNode['origin']) ?? 'agent',
    sourceSession: (row.source_session as string | null) ?? null,
  };
}

export interface AppendNodeInput {
  parentId: string;
  label: string;
  severity: Severity;
  tool?: string;
  impact?: string;
}

export function useVulnTree() {
  const [nodes, setNodes] = useState<VulnNode[]>([]);
  // Tools the pentester actually has registered (synced into pentester_tools).
  // A tree node whose tool is not in this set is rendered "planned".
  const [realTools, setRealTools] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bump to refetch (after an append). The effect — not a synchronous call —
  // owns every state update, mirroring useBrainGraph.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      supabase.from('pentester_vuln_tree_nodes').select('*'),
      supabase.from('pentester_tools').select('name').eq('present', true),
    ]).then(([treeRes, toolsRes]) => {
      if (cancelled) return;
      if (treeRes.error) {
        setError(treeRes.error.message);
      } else {
        setError(null);
        setNodes((treeRes.data ?? []).map(row => mapRow(row as Record<string, unknown>)));
      }
      if (!toolsRes.error) {
        setRealTools(new Set((toolsRes.data ?? []).map(r => (r as { name: string }).name)));
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [refreshKey]);

  // Append a child node (manual UI path → origin 'user'), then trigger a refetch.
  // RLS restricts this to platform admins; other users get a policy error.
  async function appendNode(input: AppendNodeInput): Promise<void> {
    const suffix = Math.random().toString(36).slice(2, 6);
    const { error: err } = await supabase.from('pentester_vuln_tree_nodes').insert({
      node_id: makeNodeId(input.label, suffix),
      parent_id: input.parentId,
      label: input.label,
      tool: input.tool || null,
      severity: input.severity,
      outcome: input.impact ? { impact: input.impact } : null,
      origin: 'user',
    });
    if (err) throw new Error(err.message);
    setRefreshKey(k => k + 1);
  }

  return { nodes, realTools, loading, error, appendNode, reload: () => setRefreshKey(k => k + 1) };
}
