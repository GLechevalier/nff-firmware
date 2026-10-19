// nff-app's brain data layer: the CUSTOMER-facing counterpart of
// useBrainGraph (which serves nff-admin's single vendor brain over
// /admin-api). Nothing here touches nff-admin — every call is a direct
// Supabase query under RLS, scoped to the workspace the caller is a member of.
//
// Three brains behind one `brainId`, matching BrainCard's existing picker:
//
//   'company'          this workspace's graph (brain_nodes where project_id =
//                      currentProjectId), PLUS a derived overlay of teammates'
//                      shared nodes — a hub, one portal per contributor, and a
//                      ring of their shared nodes around it.
//   'mine'             the caller's own brain in full, private nodes included.
//                      That is their personal project (0141's home_project_id),
//                      which they are a member of, so the ordinary member
//                      SELECT policy covers it.
//   <home_project_id>  one teammate's contribution — their shared nodes only,
//                      via company_brain_shared_nodes. Never more than that.
//
// The overlay is DERIVED, never persisted — the same contract nff-admin's
// server-side getGraph keeps for its own hub/portal nodes (api/_lib/brain.ts:246),
// and the same one @nff-brain/core's spine nodes keep. Here it can live in the
// browser because RLS already scopes every input.
//
// Writes (layout, node authoring, consolidate) and semantic search became
// possible from the browser in migration 0156; before it, brain_nodes had a
// SELECT policy and nothing else. See nff-db/scripts/verify-migration-0156.mjs
// for exactly what that migration does and does not permit.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { apiPost, getApiProjectId } from '../../lib/api';
import { BRAIN_SYNCED_EVENT, type BrainSyncedDetail } from '../../lib/adminChat';
import { useCurrentProjectIdOptional } from '../../../context/CurrentProjectContext';
import { ONBOARDING_MODE } from '../../../lib/onboardingMode';
import { DEMO_MODE } from '../../../lib/demoMode';
import { DEMO_BRAIN_EDGES, DEMO_BRAIN_NODES } from '../../../data/demoBrain';
import type { BrainEdge } from '@nff-brain/core/types';
import type { SimHit } from '@nff-brain/core/vector';
import type { AdminBrainNode, BrainEmployee, BrainGraphState, BrainSource } from './useBrainGraph';
import {
  deriveOverlay,
  linkEdges,
  rowToNode,
  NODE_COLS,
  type ContributorRow,
  type NodeRow,
} from '../lib/brainOverlay';
import { deriveMasters } from '../lib/brainMasters';
import { BRAIN_TABS } from '../../../nav';

const POLL_MS = 15_000;

/** The caller's own brain in the picker. Not a uuid, so it can never collide. */
export const MY_BRAIN_ID = 'mine';

async function loadHomeProjectId(): Promise<string | null> {
  // brain_sync_tokens' own-row SELECT policy (0141) — the caller sees their row
  // and nobody else's. Absent until they connect a brain in Settings.
  const { data } = await supabase.from('brain_sync_tokens').select('home_project_id').maybeSingle();
  return (data?.home_project_id as string | undefined) ?? null;
}

async function loadProjectGraph(projectId: string) {
  const [nodesRes, edgesRes] = await Promise.all([
    supabase.from('brain_nodes').select(NODE_COLS).eq('project_id', projectId),
    // brain_edges has no project_id; RLS scopes it through the parent node, and
    // linkEdges drops anything whose endpoints aren't in this node set.
    supabase.from('brain_edges').select('from_id,to_id,strength'),
  ]);
  if (nodesRes.error) throw new Error(nodesRes.error.message);
  if (edgesRes.error) throw new Error(edgesRes.error.message);
  const nodes = ((nodesRes.data ?? []) as NodeRow[]).map(rowToNode);
  const edges = ((edgesRes.data ?? []) as Array<{ from_id: string; to_id: string; strength: number }>).map(
    (e) => ({ from: e.from_id, to: e.to_id, strength: e.strength }),
  );
  return { nodes, edges: linkEdges(nodes, edges) };
}

/** One teammate's contribution: their shared nodes and nothing else. */
async function loadContributorGraph(projectId: string, homeProjectId: string) {
  const { data, error } = await supabase.rpc('company_brain_shared_nodes', {
    target_project_id: projectId,
  });
  if (error) throw new Error(error.message);
  const nodes = ((data ?? []) as NodeRow[])
    .filter((r) => r.project_id === homeProjectId)
    .map(rowToNode);
  return { nodes, edges: linkEdges(nodes, []) };
}

// ownIds = the rows that really exist in the brain being written to, i.e. the
// only ids reorganize() may UPDATE. Derived nodes (masters, hub, portals,
// teammate rings) are never in it.
async function loadGraph(brainId: string, projectId: string, homeProjectId: string | null) {
  if (brainId === MY_BRAIN_ID) {
    if (!homeProjectId) return { nodes: [], edges: [], ownIds: new Set<string>() };
    const g = await loadProjectGraph(homeProjectId);
    return { ...g, ownIds: new Set(g.nodes.map((n) => n.id)) };
  }
  if (brainId !== 'company') return { ...(await loadContributorGraph(projectId, brainId)), ownIds: new Set<string>() };

  const [own, sharedRes, contribRes] = await Promise.all([
    loadProjectGraph(projectId),
    supabase.rpc('company_brain_shared_nodes', { target_project_id: projectId }),
    supabase.rpc('company_brain_contributors', { target_project_id: projectId }),
  ]);
  if (sharedRes.error) throw new Error(sharedRes.error.message);
  if (contribRes.error) throw new Error(contribRes.error.message);

  const contributors = (contribRes.data ?? []) as ContributorRow[];
  // Tab/tool masters first: they may derive the hub the teammate overlay anchors on.
  const masters = deriveMasters(own.nodes, own.edges, BRAIN_TABS, projectBrainSource.features.companyLabel);
  const base = own.nodes.concat(masters.nodes);
  const overlay = deriveOverlay(
    base,
    (sharedRes.data ?? []) as NodeRow[],
    contributors,
    homeProjectId,
  );
  const nodes = base.concat(overlay.nodes);
  const edges = linkEdges(nodes, own.edges.concat(masters.edges, overlay.edges));
  return { nodes, edges, contributors, ownIds: new Set(own.nodes.map((n) => n.id)) };
}

// ponytail: JSON.stringify equality — ~1ms for a few hundred rows every 15s;
// a per-row fingerprint if the brain grows past that.
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function useProjectBrain(brainId: string = 'company'): BrainGraphState {
  const projectId = useCurrentProjectIdOptional();
  const [nodes, setNodes] = useState<AdminBrainNode[]>([]);
  const [edges, setEdges] = useState<BrainEdge[]>([]);
  const [employees, setEmployees] = useState<BrainEmployee[]>([]);
  const [homeProjectId, setHomeProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reducing, setReducing] = useState(false);
  const [reorganizing, setReorganizing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Guards against a slow response for the PREVIOUS brainId landing after a
  // switch and painting the wrong graph.
  const seq = useRef(0);
  const ownIds = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    if (!projectId) return;
    // Local onboarding mode: a brand-new workspace has an empty brain, and an empty
    // company brain is exactly what makes BrainCard render the seed hub. Read nothing
    // (so nothing can be shown), write nothing — the real rows are untouched.
    if (ONBOARDING_MODE) {
      setNodes([]);
      setEdges([]);
      setEmployees([]);
      setError(null);
      setLoading(false);
      return;
    }
    // Demo mode: the canned brain (data/demoBrain.ts) through the same master
    // derivation as a real one. ownIds stays empty, so reorganize/layout write
    // nothing. Copied per refresh — linkEdges fills relatedIds in place.
    if (DEMO_MODE) {
      const own = DEMO_BRAIN_NODES.map((n) => ({ ...n, relatedIds: [] as string[] }));
      const masters = deriveMasters(own, DEMO_BRAIN_EDGES, BRAIN_TABS, projectBrainSource.features.companyLabel);
      const nodes = own.concat(masters.nodes);
      setNodes(nodes);
      setEdges(linkEdges(nodes, DEMO_BRAIN_EDGES.concat(masters.edges)));
      setEmployees([]);
      setError(null);
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    try {
      const home = homeProjectId ?? (await loadHomeProjectId());
      if (seq.current !== mine) return;
      if (home !== homeProjectId) setHomeProjectId(home);
      const g = await loadGraph(brainId, projectId, home);
      if (seq.current !== mine) return;
      ownIds.current = g.ownIds;
      // An unchanged poll keeps the previous arrays: every graph memo
      // (spacing, overlap merge, glow seeding) keys on identity, so a fresh
      // copy of the same rows every 15s re-ran the whole O(n²) chain for nothing.
      setNodes(prev => (sameJson(prev, g.nodes) ? prev : g.nodes));
      setEdges(prev => (sameJson(prev, g.edges) ? prev : g.edges));
      if ('contributors' in g && g.contributors) {
        // Contributors ARE the picker's member list: mapping them onto
        // BrainEmployee is what lets BrainCard's existing portal drill-in and
        // dropdown work unchanged against a completely different backend.
        setEmployees(
          g.contributors
            .filter((c) => c.home_project_id !== home)
            .map((c) => ({
              id: c.home_project_id,
              name: c.label,
              lastSyncedAt: c.last_synced_at,
              nodeCount: c.node_count,
            })),
        );
      }
      setError(null);
    } catch (e) {
      if (seq.current !== mine) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq.current === mine) setLoading(false);
    }
  }, [brainId, projectId, homeProjectId]);

  // refresh() sets state only after an await in every path (it awaits either
  // loadHomeProjectId or loadGraph before the first setState), but the rule
  // can't see through the shared loader — the setState is not synchronous.
  // Same disable, same reason, as the dashboard hook this replaces.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    // A sync landed (auto-sync on connect, or the rail button): don't wait for the poll.
    const onSynced = () => void refresh();
    window.addEventListener(BRAIN_SYNCED_EVENT, onSynced);
    return () => {
      clearInterval(t);
      window.removeEventListener(BRAIN_SYNCED_EVENT, onSynced);
    };
  }, [refresh]);

  // Mirror this workspace's tables + connected sources into origin:'supabase'
  // nodes. Server-side on nff-admin (0156 lets the browser INSERT 'seed' rows
  // only); `X-Project-Id` rides on every apiPost, and requireProjectMember
  // scopes the sync to it. The event refreshes the graph and glows the new ids.
  const syncDatabase = useCallback(async (): Promise<BrainSyncedDetail> => {
    setSyncing(true);
    try {
      const r = await apiPost<BrainSyncedDetail>('/api/tables/brain/sync', {});
      window.dispatchEvent(new CustomEvent<BrainSyncedDetail>(BRAIN_SYNCED_EVENT, { detail: r }));
      return r;
    } finally {
      setSyncing(false);
    }
  }, []);

  // Which project a write lands in: your own brain when viewing 'mine', this
  // workspace otherwise. A teammate's brain is read-only by construction —
  // RLS would refuse the write anyway (0156 gates every policy on
  // is_project_member), this just avoids issuing a doomed request.
  const writeProjectId = brainId === MY_BRAIN_ID ? homeProjectId : projectId;
  const readOnly = brainId !== 'company' && brainId !== MY_BRAIN_ID;

  const reduce = useCallback(
    async (fraction = 0.25): Promise<number> => {
      if (!writeProjectId || readOnly) return 0;
      setReducing(true);
      try {
        const { data, error: e } = await supabase.rpc('brain_merge_reduce', {
          p_project: writeProjectId,
          p_fraction: fraction,
        });
        if (e) throw new Error(e.message);
        await refresh();
        return typeof data === 'number' ? data : 0;
      } finally {
        setReducing(false);
      }
    },
    [writeProjectId, readOnly, refresh],
  );

  const reorganize = useCallback(
    async (positions: Record<string, { x: number; y: number }>): Promise<void> => {
      if (!writeProjectId || readOnly) return;
      setReorganizing(true);
      try {
        const entries = Object.entries(positions).filter(
          ([id, p]) => ownIds.current.has(id) && Number.isFinite(p.x) && Number.isFinite(p.y),
        );
        // No bulk-update in PostgREST; 0156 grants UPDATE on (x,y,…) only, so
        // this can move a node and nothing else. Chunked to keep the browser
        // from opening hundreds of sockets at once.
        for (let i = 0; i < entries.length; i += 25) {
          await Promise.all(
            entries.slice(i, i + 25).map(([id, p]) =>
              supabase.from('brain_nodes').update({ x: p.x, y: p.y }).eq('id', id).eq('project_id', writeProjectId),
            ),
          );
        }
        await refresh();
      } finally {
        setReorganizing(false);
      }
    },
    [writeProjectId, readOnly, refresh],
  );

  const semanticSearch = useCallback(
    async (vector: number[], k = 20): Promise<SimHit[]> => {
      const target = brainId === MY_BRAIN_ID ? homeProjectId : projectId;
      if (!target) return [];
      // brain_vector_search takes the pgvector text literal, not an array.
      const { data, error: e } = await supabase.rpc('brain_vector_search', {
        p_project: target,
        p_query: `[${vector.join(',')}]`,
        p_k: k,
      });
      if (e) throw new Error(e.message);
      return ((data ?? []) as Array<{ id: string; sim: number }>).map((h) => ({ id: h.id, sim: h.sim }));
    },
    [brainId, homeProjectId, projectId],
  );

  const saveNode = useCallback(
    async (payload: {
      id?: string;
      title: string;
      content?: string;
      sourceRef?: { kind: 'tool'; tool: string } | { kind: 'tab'; tab: string } | null;
      x?: number;
      y?: number;
    }): Promise<string> => {
      if (!writeProjectId || readOnly) throw new Error('this brain is read-only');
      if (payload.id) {
        // Update, never upsert: an upsert would reset x/y and recall_count.
        // 0156 grants exactly these columns, so this is also all it CAN write.
        const { error: e } = await supabase
          .from('brain_nodes')
          .update({
            title: payload.title.slice(0, 80),
            content: (payload.content ?? '').slice(0, 1200),
            source_ref: payload.sourceRef ?? null,
            last_updated: new Date().toISOString(),
          })
          .eq('id', payload.id)
          .eq('project_id', writeProjectId);
        if (e) throw new Error(e.message);
        await refresh();
        return payload.id;
      }
      // Full uuid, not 8 hex: brain_nodes.id is a global PK across every
      // project (same reasoning as the ingest endpoint's namespace).
      const id = `usr-${crypto.randomUUID()}`;
      const { error: e } = await supabase.from('brain_nodes').insert({
        id,
        title: payload.title.slice(0, 80),
        category: 'strategy',
        color: '#a78bfa',
        x: payload.x ?? 120 + Math.random() * 560,
        y: payload.y ?? 100 + Math.random() * 400,
        size: 16,
        content: (payload.content ?? '').slice(0, 1200),
        source_ref: payload.sourceRef ?? null,
        project_id: writeProjectId,
        // 'seed' survives both consolidation (which folds origin='agent') and
        // the ingest replace (which clears origin='import'), and it is the only
        // origin 0156's INSERT policy permits.
        origin: 'seed',
      });
      if (e) throw new Error(e.message);
      await refresh();
      return id;
    },
    [writeProjectId, readOnly, refresh],
  );

  const notAvailable = useCallback(async (): Promise<never> => {
    // Unreachable: BrainCard hides both controls when the feature flags are
    // off. Present because the source must satisfy the same shape.
    throw new Error('not available in nff-app');
  }, []);

  return useMemo(
    () => ({
      nodes,
      edges,
      employees,
      customBrains: [],
      createCustomBrain: notAvailable as BrainGraphState['createCustomBrain'],
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
    }),
    [nodes, edges, employees, saveNode, loading, error, reduce, reducing, reorganize, reorganizing,
     syncDatabase, syncing, semanticSearch, refresh, notAvailable],
  );
}

/**
 * The source nff-app hands BrainCard. nff-admin keeps adminBrainSource and is
 * not affected — the two share the renderer and nothing else.
 */
export const projectBrainSource: BrainSource = {
  useGraph: useProjectBrain,
  // Double-clicking a portal rings that teammate's shared nodes around it in
  // place. Outside a React tree, so the workspace comes from the same
  // module-level id AuthGate already pushes into the API client.
  fetchGraph: async (brainId) => {
    const projectId = getApiProjectId();
    if (!projectId || brainId === 'company' || brainId === MY_BRAIN_ID) {
      return { nodes: [], edges: [] };
    }
    return loadContributorGraph(projectId, brainId);
  },
  features: {
    sync: true,         // POST /api/tables/brain/sync, scoped to this workspace by X-Project-Id
    commits: false,     // brain_commits (0140) is service-role-only — vendor-only
    createBrain: false, // custom_brains (0142) is a vendor registry
    companyLabel: 'Company Brain',
    memberNoun: 'Teammate',
    myBrainId: MY_BRAIN_ID,
    emptyCompanyHint:
      'Your brain is empty. Hover the core on Overview and pick a source — every repo, deployment, device and transaction becomes a node here, and the agent adds what it learns as it works.',
    memberSyncHint:
      'This teammate has connected a brain but has not published anything to this workspace yet. Only nodes they mark as shared appear here.',
  },
};
