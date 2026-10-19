// Pure derivation for the company brain's teammate overlay.
//
// Split out of useProjectBrain so it can be tested without a Supabase client:
// this module imports nothing that touches the network, which is the point —
// deciding which teammate nodes appear in a workspace, and under whose name, is
// the part where a mistake is either a privacy leak or a silently invisible
// contribution.
//
// Nothing here is ever persisted. The hub, the portals and the ring positions
// are recomputed on every load — the same contract nff-admin's server-side
// getGraph keeps (api/_lib/brain.ts:246) and that @nff-brain/core's spine nodes
// keep.

import { asCategory, type BrainEdge, type BrainNode } from '@nff-brain/core/types';
import type { AdminBrainNode } from '../hooks/useBrainGraph';
import { DERIVED_TS } from './brainMasters';

export interface NodeRow {
  id: string;
  title: string;
  category: string;
  color: string;
  x: number;
  y: number;
  size: number;
  last_updated: string;
  content: string | null;
  origin: string;
  recall_count: number;
  last_recalled_at: string | null;
  source_ref: unknown | null;
  shared?: boolean;
  project_id?: string;
}

export interface ContributorRow {
  home_project_id: string;
  label: string;
  node_count: number;
  last_synced_at: string | null;
}

export const NODE_COLS =
  'id,title,category,color,x,y,size,last_updated,content,origin,recall_count,last_recalled_at,source_ref,shared,project_id';

export function rowToNode(r: NodeRow): AdminBrainNode {
  return {
    id: r.id,
    // asCategory, not a cast: the column's CHECK is not this client's
    // guarantee, and an unknown value lands on 'strategy' rather than
    // poisoning the render (same reasoning as mapGraphDto).
    category: asCategory(r.category),
    title: r.title,
    color: r.color,
    x: r.x,
    y: r.y,
    size: r.size,
    lastUpdated: r.last_updated,
    content: r.content ?? '',
    origin: (r.origin as BrainNode['origin']) ?? 'agent',
    recallCount: r.recall_count ?? 0,
    lastRecalledAt: r.last_recalled_at ?? undefined,
    relatedIds: [],
    sourceRef: r.source_ref ?? null,
  };
}

/**
 * Fill in each node's neighbours, drop edges that lost an endpoint, and collapse
 * duplicates. A pair counts once whichever way round it is (same convention as
 * nff-admin's planSync) — deriveMasters re-asserts every master's hub spoke on
 * top of the one already in brain_edges, and a doubled edge is both a doubled
 * line and a doubled relatedIds entry, which findHubId ranks on.
 */
export function linkEdges(nodes: AdminBrainNode[], edges: BrainEdge[]): BrainEdge[] {
  const ids = new Set(nodes.map((n) => n.id));
  const byPair = new Map<string, BrainEdge>();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    const prev = byPair.get(key);
    if (!prev || e.strength > prev.strength) byPair.set(key, prev ? { ...prev, strength: e.strength } : e);
  }
  const kept = [...byPair.values()];
  for (const n of nodes) {
    n.relatedIds = kept
      .filter((e) => e.from === n.id || e.to === n.id)
      .map((e) => (e.from === n.id ? e.to : e.from));
  }
  return kept;
}

/**
 * Build the teammate overlay: a hub, a portal per contributor, and a ring of
 * each contributor's shared nodes around their portal.
 *
 * Exported for the self-check in useProjectBrain.test.ts — it is a pure
 * function of (company nodes, shared rows, contributors), which is exactly the
 * part worth pinning down.
 */
export function deriveOverlay(
  companyNodes: AdminBrainNode[],
  sharedRows: NodeRow[],
  contributors: ContributorRow[],
  myHomeProjectId: string | null,
): { nodes: AdminBrainNode[]; edges: BrainEdge[] } {
  // The caller is a member of the target project, so company_brain_shared_nodes
  // returns THEIR shared nodes too. Those belong under 'mine', not in the
  // teammate ring.
  const others = contributors.filter((c) => c.home_project_id !== myHomeProjectId);
  if (others.length === 0) return { nodes: [], edges: [] };

  const nodes: AdminBrainNode[] = [];
  const edges: BrainEdge[] = [];

  // Anchor the overlay off the company graph's own hub, if it has one.
  const core = companyNodes.find((n) => n.category === 'core');
  const hubX = (core?.x ?? 400) + 380;
  const hubY = core?.y ?? 300;

  // Fixed, not `new Date()`: see DERIVED_TS in brainMasters.ts — a per-poll
  // timestamp breaks useProjectBrain's identity guard and re-runs every layout memo.
  const now = DERIVED_TS;
  const derived = (over: Partial<AdminBrainNode> & { id: string; title: string }): AdminBrainNode => ({
    category: 'strategy',
    color: '#f0abfc',
    x: hubX,
    y: hubY,
    size: 18,
    lastUpdated: now,
    content: '',
    origin: 'seed',
    recallCount: 0,
    relatedIds: [],
    sourceRef: null,
    ...over,
  });

  // 'strategy', never 'core': the renderer pins its layout on the single
  // core-category node, so a second one breaks it (the trap nff-admin
  // documents at api/_lib/brain.ts:255).
  const hub = derived({
    id: 'teammates-hub',
    title: 'Teammates',
    size: 24,
    content: `${others.length} teammate${others.length === 1 ? '' : 's'} sharing into this brain.`,
    kind: 'hub',
  });
  nodes.push(hub);
  if (core) edges.push({ from: core.id, to: hub.id, strength: 0.9 });

  others.forEach((c, i) => {
    const portalId = `brain-portal-${c.home_project_id}`;
    const py = hubY + (i - (others.length - 1) / 2) * 110;
    nodes.push(
      derived({
        id: portalId,
        title: c.label,
        x: hubX + 240,
        y: py,
        size: 20,
        content:
          `${c.label} — ${c.node_count} node${c.node_count === 1 ? '' : 's'} in their brain` +
          (c.last_synced_at ? `, last synced ${c.last_synced_at}` : ', never synced'),
        kind: 'portal',
        employeeId: c.home_project_id,
      }),
    );
    edges.push({ from: hub.id, to: portalId, strength: 0.8 });

    // Their shared nodes, ringed around the portal. Stored x/y are meaningful
    // only inside their own graph, so position them here instead.
    const mine = sharedRows.filter((r) => r.project_id === c.home_project_id);
    mine.forEach((r, j) => {
      const angle = (j * 2 * Math.PI) / Math.max(8, mine.length);
      const n = rowToNode(r);
      nodes.push({
        ...n,
        // Demote a shared 'core' node so it cannot become a second hub.
        category: n.category === 'core' ? 'strategy' : n.category,
        x: hubX + 240 + Math.cos(angle) * 170,
        y: py + Math.sin(angle) * 170,
        employeeId: c.home_project_id,
      });
      edges.push({ from: portalId, to: n.id, strength: 0.6 });
    });
  });

  return { nodes, edges };
}
