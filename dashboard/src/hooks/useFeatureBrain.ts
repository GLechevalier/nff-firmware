import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useCurrentProject } from '../context/CurrentProjectContext';
import type { BrainEdge } from '@nff-brain/core/types';
import { mapNode, mapEdge, linkRelated, type DashboardBrainNode } from '../lib/brainRow';

// The Builder-tab interview's brain subgraph: only the nodes this interview created
// (brain_nodes.source_session = the builder chat session), so the user watches THIS
// feature's context appear — not the whole project brain. Unlike useBrainGraph (a
// one-shot fetch for the standalone Brain tab), this SUBSCRIBES to realtime so the
// graph grows live as nff-builder's add_feature_context tool commits nodes/edges.

export function useFeatureBrain(sessionId: string | null | undefined) {
  const { currentProjectId } = useCurrentProject();
  const [nodes, setNodes] = useState<DashboardBrainNode[]>([]);
  const [edges, setEdges] = useState<BrainEdge[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!currentProjectId || !sessionId) {
      setNodes([]);
      setEdges([]);
      setLoading(!!sessionId);
      return;
    }

    let cancelled = false;

    async function load() {
      // Nodes scoped to THIS interview; edges scope through their endpoints (the edges
      // table has no project/session column), so we drop any edge not wholly inside
      // this session's node set — same guard as useBrainGraph.
      const [nodesResult, edgesResult] = await Promise.all([
        supabase.from('brain_nodes').select('*')
          .eq('project_id', currentProjectId)
          .eq('source_session', sessionId),
        supabase.from('brain_edges').select('*'),
      ]);
      if (cancelled) return;

      const rawNodes = (nodesResult.data ?? []).map(row => mapNode(row as Record<string, unknown>));
      const nodeIds = new Set(rawNodes.map(n => n.id));
      const rawEdges = (edgesResult.data ?? [])
        .map(row => mapEdge(row as Record<string, unknown>))
        .filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));

      linkRelated(rawNodes, rawEdges);

      setNodes(rawNodes);
      setEdges(rawEdges);
      setLoading(false);
    }

    setLoading(true);
    void load();

    // Reload on any brain change for this project. Volume during an interview is tiny
    // (a node per settled answer), so a full reload per event is simpler and robust —
    // the realtime payloads don't carry enough to merge a scoped subgraph cleanly
    // (edge DELETEs omit endpoints; node source_session may be absent on UPDATE).
    const channelId = Math.random().toString(36).slice(2);
    const channel = supabase
      .channel(`feature-brain-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brain_nodes', filter: `project_id=eq.${currentProjectId}` }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brain_edges' }, () => void load())
      .subscribe();

    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [currentProjectId, sessionId]);

  return { nodes, edges, loading };
}
