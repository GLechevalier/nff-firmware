// Brain tab data layer — the admin counterpart of nff-dashboard's
// useBrainGraph. The tab renders exactly ONE brain: the admin worker's (the
// fixed platform project from nff-db 0116), read through the service-role
// brain routes folded into api/tables.ts (api/_lib/brain.ts). The worker
// recalls/distills into it on every run, so the 15s poll keeps the graph
// visibly evolving. Reads ride useApiPoll so the graph survives App.tsx's
// unmount-on-tab-switch.

import { useCallback, useMemo, useState } from 'react';
import { apiGet, apiPost } from '../../lib/api';
import { invalidatePrefix } from '../../lib/resourceCache';
import { useApiPoll } from '../../hooks/useApiPoll';
import { asCategory, type BrainNode, type BrainEdge } from '@nff-brain/core/types';
import type { SimHit } from '@nff-brain/core/vector';
import type { Tier } from '../lib/brainMasters';

// core's BrainNode is the shape the brain is actually stored in and carries no
// adjacency — edges are their own list. The graph UI wants each node's
// neighbours to hand, so the derived field lives in this intersection rather
// than being pushed back into the shared type. sourceRef is another
// admin-only extension (see 0137_brain_source_ref.sql) — a generic pointer
// back to the real row a synced node summarizes, null for worker-authored ones.
export type AdminBrainNode = BrainNode & {
  relatedIds: string[];
  sourceRef: unknown | null;
  // Employee-brain routing (0138): 'hub'/'portal' are server-derived nodes
  // (never persisted); employeeId marks a portal's drill-in target or a shared
  // overlay node's owner. Absent on plain worker nodes.
  kind?: 'hub' | 'portal';
  employeeId?: string;
  // Priority tier 1–5 (brainMasters.ts tierOf), stamped by deriveMasters on
  // the rows it saw; BrainGraph recomputes it for any row without the stamp.
  tier?: Tier;
};

export interface BrainEmployee {
  id: string;
  name: string;
  lastSyncedAt: string | null;
  nodeCount: number;
}

// Admin-authored "context picker" brain (0142) — created from the Overview
// tab's "+ Create a new brain…" dropdown entry, not synced from an extension.
export interface CustomBrain {
  id: string;
  name: string;
  nodeCount: number;
  createdAt: string;
}

// POST /api/tables/brain/sync — totals of the desired set plus the delta the
// call actually wrote (api/_lib/brain.ts planSync).
export interface SyncDatabaseResult {
  synced: number;
  edges: number;
  added: number;
  changed: number;
  removed: number;
}

export interface GraphDto {
  nodes: Array<{
    id: string;
    title: string;
    category: string;
    color: string;
    x: number;
    y: number;
    size: number;
    lastUpdated: string;
    content: string;
    origin: string;
    recallCount: number;
    lastRecalledAt: string | null;
    sourceRef: unknown | null;
    kind?: 'hub' | 'portal';
    employeeId?: string;
  }>;
  edges: Array<{ from: string; to: string; strength: number }>;
  employees?: BrainEmployee[];
  customBrains?: CustomBrain[];
}

// Shared with the Overview tab's one-off "expand a portal in place" fetch
// (a plain apiGet against the same /api/tables/brain/graph?brain=<id> route
// this hook polls) so both paths map the wire DTO into AdminBrainNode[] the
// same way instead of drifting.
export function mapGraphDto(data: GraphDto | null | undefined): { nodes: AdminBrainNode[]; edges: BrainEdge[] } {
  const rawNodes: AdminBrainNode[] = (data?.nodes ?? []).map((n) => ({
    id: n.id,
    title: n.title,
    // asCategory over a cast: the DB constrains category to four values, but
    // this is untrusted JSON off the wire and an unknown one lands on
    // 'strategy' instead of poisoning the render.
    category: asCategory(n.category),
    color: n.color,
    x: n.x,
    y: n.y,
    size: n.size,
    lastUpdated: n.lastUpdated, // ISO string — core stores it as written
    content: n.content,
    origin: (n.origin as BrainNode['origin']) ?? 'agent',
    recallCount: n.recallCount ?? 0,
    lastRecalledAt: n.lastRecalledAt ?? undefined,
    relatedIds: [],
    sourceRef: n.sourceRef ?? null,
    kind: n.kind,
    employeeId: n.employeeId,
  }));
  // The server already scopes edges to the admin brain's node set; keep the
  // dashboard's belt-and-braces filter so the graph never dereferences a
  // missing node, and derive relatedIds the same way it does.
  const ids = new Set(rawNodes.map((n) => n.id));
  const rawEdges: BrainEdge[] = (data?.edges ?? []).filter((e) => ids.has(e.from) && ids.has(e.to));
  for (const node of rawNodes) {
    node.relatedIds = rawEdges
      .filter((e) => e.from === node.id || e.to === node.id)
      .map((e) => (e.from === node.id ? e.to : e.from));
  }
  return { nodes: rawNodes, edges: rawEdges };
}

// brainId: 'company' (the admin worker's brain, default) or an employee_brains
// id from the dropdown/portal drill-in. useApiPoll keys its cache on the full
// URL, so switching brains just repoints the poll.
export function useBrainGraph(brainId: string = 'company') {
  const { data, error, loading, refresh } = useApiPoll<GraphDto>(
    `/api/tables/brain/graph?brain=${encodeURIComponent(brainId)}`,
    15_000,
  );
  const [reducing, setReducing] = useState(false);
  const [reorganizing, setReorganizing] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const { nodes, edges } = useMemo(() => mapGraphDto(data), [data]);

  // Consolidate the brain non-destructively: fold the least-valuable AGENT nodes
  // into their nearest surviving neighbour via brain_merge_reduce (service_role
  // path since migration 0114). Returns the number of nodes merged; throws on
  // error so the caller can surface it.
  const reduce = useCallback(
    async (fraction = 0.25): Promise<number> => {
      setReducing(true);
      try {
        const { merged } = await apiPost<{ merged: number }>('/api/tables/brain/merge', { fraction });
        // apiPost only invalidates its own exact path; the merge changed the graph.
        invalidatePrefix('/api/tables/brain');
        await refresh();
        return merged;
      } finally {
        setReducing(false);
      }
    },
    [refresh],
  );

  // Persist client-computed positions (buildSpine + layoutBrain — see
  // OverviewTab's Reorganize handler) so the clustered layout survives a
  // reload. Mirrors reduce()'s shape.
  const reorganize = useCallback(
    async (positions: Record<string, { x: number; y: number }>): Promise<void> => {
      setReorganizing(true);
      try {
        await apiPost('/api/tables/brain/layout', { positions });
        invalidatePrefix('/api/tables/brain');
        await refresh();
      } finally {
        setReorganizing(false);
      }
    },
    [refresh],
  );

  // Mirror tabs into the brain as origin:'supabase' nodes (api/_lib/brain.ts's
  // syncDatabase — a diff of that origin only: untouched nodes keep their
  // position, new ones are seeded beside their nearest neighbour). Returns the
  // totals plus the delta so the caller can report them.
  const syncDatabase = useCallback(async (): Promise<SyncDatabaseResult> => {
    setSyncing(true);
    try {
      const result = await apiPost<SyncDatabaseResult>('/api/tables/brain/sync', {});
      invalidatePrefix('/api/tables/brain');
      await refresh();
      return result;
    } finally {
      setSyncing(false);
    }
  }, [refresh]);

  // Semantic search: the query vector is computed client-side (src/lib/embedQuery.ts,
  // in-browser WASM); this just forwards it to brain_vector_search, which is
  // service_role-only (0071_brain_semantic.sql), so it has to go through a route.
  const semanticSearch = useCallback(async (vector: number[], k = 20): Promise<SimHit[]> => {
    const { hits } = await apiPost<{ hits: SimHit[] }>('/api/tables/brain/search', { vector, k });
    return hits;
  }, []);

  // Create an admin-authored custom brain (0142) — name/description/tool
  // toggles + pasted-text/file items, already flattened client-side (see
  // CreateBrainModal). Mirrors syncDatabase()'s invalidate-then-refresh shape.
  const createCustomBrain = useCallback(
    async (payload: {
      name: string;
      description: string;
      enabledTools: string[];
      items: Array<{ name: string; content: string }>;
    }): Promise<{ customBrain: { id: string } }> => {
      const result = await apiPost<{ customBrain: { id: string } }>('/api/tables/brain/custom', payload);
      invalidatePrefix('/api/tables/brain');
      await refresh();
      return result;
    },
    [refresh],
  );

  // Create (no id) or save (id) a hand-authored node — the Overview rail's
  // "Add node" + white goal editor. Server namespaces ids `usr-` and stores
  // the goal as source_ref (tool/tab) or plain content (context).
  const saveNode = useCallback(
    async (payload: {
      id?: string;
      title: string;
      content?: string;
      sourceRef?: { kind: 'tool'; tool: string } | { kind: 'tab'; tab: string } | null;
      x?: number;
      y?: number;
    }): Promise<string> => {
      const { id } = await apiPost<{ id: string }>('/api/tables/brain/node', payload);
      invalidatePrefix('/api/tables/brain');
      await refresh();
      return id;
    },
    [refresh],
  );

  const employees = data?.employees ?? [];
  const customBrains = data?.customBrains ?? [];

  return {
    nodes,
    edges,
    employees,
    customBrains,
    createCustomBrain,
    saveNode,
    loading,
    error,
    reduce,
    reducing,
    reorganize,
    reorganizing,
    syncDatabase,
    syncing,
    semanticSearch,
    refresh,
  };
}

/**
 * Everything BrainCard needs from a backend, in one injectable object.
 *
 * BrainCard renders two brains that share nothing but a shape: nff-admin's
 * vendor brain (the fixed platform project from 0116, read through the
 * service-role routes in api/_lib/brain.ts) and nff-app's per-company brain
 * (read straight from Supabase under RLS, scoped to the caller's workspace —
 * see useProjectBrain). nff-admin renders <BrainCard /> bare and keeps this
 * default; nff-app passes its own source, so no customer request ever reaches
 * nff-admin for brain data.
 */
export type BrainGraphState = ReturnType<typeof useBrainGraph>;

export interface BrainFeatures {
  /** "Sync database" — mirrors the admin's own tabs into the graph. Vendor-only. */
  sync: boolean;
  /** The commit timeline — brain_commits is service-role-only (0140). Vendor-only. */
  commits: boolean;
  /** "+ Create a new brain…" — custom_brains (0142) is a vendor registry. */
  createBrain: boolean;
  /** Header + picker label for the shared brain ("Admin Worker Brain" / "Company"). */
  companyLabel: string;
  /** What a non-company entry in the picker is called: "Employee" vs "Teammate". */
  memberNoun: string;
  /**
   * Picker id for "my own brain", or null where the concept does not exist.
   * nff-admin has no per-user brain — an employee's brain is a vendor registry
   * row, not the viewer's own — so it stays null there.
   */
  myBrainId: string | null;
  /** Empty state for the shared brain. */
  emptyCompanyHint: string;
  /** Empty state for a member who has never synced. */
  memberSyncHint: string;
}

export interface BrainSource {
  useGraph: (brainId: string) => BrainGraphState;
  /** One-shot snapshot for expanding a portal in place (no poll). */
  fetchGraph: (brainId: string) => Promise<{ nodes: AdminBrainNode[]; edges: BrainEdge[] }>;
  features: BrainFeatures;
}

export const adminBrainSource: BrainSource = {
  useGraph: useBrainGraph,
  fetchGraph: async (brainId) =>
    mapGraphDto(await apiGet<GraphDto>(`/api/tables/brain/graph?brain=${encodeURIComponent(brainId)}`)),
  features: {
    sync: true,
    commits: true,
    createBrain: true,
    companyLabel: 'Admin Worker Brain',
    memberNoun: 'Employee',
    myBrainId: null,
    emptyCompanyHint:
      'The admin worker has no memories yet — they appear as it answers and builds.',
    memberSyncHint:
      'This employee has not synced their brain yet. Their extension syncs to admin.nanoforgeflow.com (production) — a token minted on a different instance lands there, not here.',
  },
};
