// Radial TREE layout of the brain by priority tier — what Reorganize persists.
// The hub sits at the centre, every other node just outside its parent (the
// neighbour one tier up), each subtree fanning out in its own wedge. Pure and
// deterministic. Core's layoutRadial would do the same job but sizes any
// internal real node at a hardcoded 16, so a Store app with tools under it
// gets no room; this is the ~60-line local version, finished by core's own
// spaceOutNodes pass.

import { spaceOutNodes, type Pt } from '@nff-brain/core/layout';
import { tierOf, tierScale, type Tier } from './brainMasters';

export interface TreeNode {
  id: string;
  x: number;
  y: number;
  size: number;
  tier?: number;
  sourceRef?: unknown;
  kind?: 'hub' | 'portal';
  employeeId?: string;
  relatedIds?: readonly string[];
}

export interface TreeEdge {
  from: string;
  to: string;
  strength: number;
}

const RING_GAP = 40;
const MIN_GAP = 60;

/** The parent of every non-root node: its lowest-tier neighbour (then strongest edge, then lowest id); no neighbour above it → the hub. */
export function treeParents(nodes: readonly TreeNode[], edges: readonly TreeEdge[], hubId: string): Map<string, string> {
  const tier = new Map(nodes.map((n) => [n.id, (n.tier as Tier | undefined) ?? tierOf(n, hubId)]));
  const best = new Map<string, { id: string; tier: number; strength: number }>();
  const consider = (me: string, other: string, strength: number) => {
    const t = tier.get(other);
    const mine = tier.get(me);
    if (t === undefined || mine === undefined || t >= mine) return;
    const cur = best.get(me);
    if (!cur || t < cur.tier || (t === cur.tier && (strength > cur.strength || (strength === cur.strength && other < cur.id))))
      best.set(me, { id: other, tier: t, strength });
  };
  for (const e of edges) {
    consider(e.from, e.to, e.strength);
    consider(e.to, e.from, e.strength);
  }
  const parents = new Map<string, string>();
  for (const n of nodes) if (n.id !== hubId) parents.set(n.id, best.get(n.id)?.id ?? hubId);
  return parents;
}

/**
 * Board positions for every node: root at `center`, children in wedges split
 * by subtree demand, radius = just outside the parent unless the wedge is too
 * narrow for what hangs off it (arc = radius × angle — core's layoutRadial
 * trick). Then one overlap pass with the root pinned.
 */
export function layoutTree(
  nodes: readonly TreeNode[],
  edges: readonly TreeEdge[],
  opts: { hubId: string; center: Pt },
): Record<string, Pt> {
  const { hubId, center } = opts;
  if (!nodes.some((n) => n.id === hubId)) return Object.fromEntries(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  const tier = new Map(nodes.map((n) => [n.id, (n.tier as Tier | undefined) ?? tierOf(n, hubId)]));
  const size = new Map(nodes.map((n) => [n.id, n.size * tierScale(n, tier.get(n.id)!)]));
  const parents = treeParents(nodes, edges, hubId);
  const kids = new Map<string, string[]>();
  for (const [child, parent] of parents) (kids.get(parent) ?? kids.set(parent, []).get(parent)!).push(child);
  for (const list of kids.values()) list.sort((a, b) => tier.get(a)! - tier.get(b)! || (a < b ? -1 : 1));

  // A node's LEAF children (memories under a master, devices under Devices)
  // pack in rows inside their wedge — ceil(√k) per row — instead of one arc:
  // a hundred device rows on a single arc would push the whole first ring
  // thousands of units out. Children with subtrees of their own keep a wedge each.
  const width = (id: string) => 2 * size.get(id)! + MIN_GAP;
  const split = (id: string) => {
    const cs = kids.get(id) ?? [];
    const inner = cs.filter((c) => (kids.get(c)?.length ?? 0) > 0);
    const leaves = cs.filter((c) => (kids.get(c)?.length ?? 0) === 0);
    const cols = Math.ceil(Math.sqrt(leaves.length));
    const leafW = leaves.reduce((m, c) => Math.max(m, width(c)), 0);
    return { inner, leaves, cols, leafW };
  };
  const demandCache = new Map<string, number>();
  const demand = (id: string): number => {
    const hit = demandCache.get(id);
    if (hit !== undefined) return hit;
    const { inner, cols, leafW } = split(id);
    let d = cols * leafW;
    for (const c of inner) d += demand(c);
    d = Math.max(d, width(id));
    demandCache.set(id, d);
    return d;
  };

  const pos: Record<string, Pt> = {};
  const at = (r: number, a: number): Pt => ({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  const place = (id: string, a0: number, a1: number, parentR: number, parentSize: number) => {
    const own = size.get(id)!;
    let r = 0;
    if (id === hubId) pos[id] = center;
    else {
      const span = Math.max(a1 - a0, 1e-6);
      r = Math.max(parentR + parentSize + own + RING_GAP, demand(id) / span);
      pos[id] = at(r, (a0 + a1) / 2);
    }
    const { inner, leaves, cols, leafW } = split(id);
    const total = inner.reduce((s, c) => s + demand(c), 0) + cols * leafW;
    let a = a0;
    for (const c of inner) {
      const w = ((a1 - a0) * demand(c)) / (total || 1);
      place(c, a, a + w, r, own);
      a += w;
    }
    if (leaves.length) {
      const w = Math.max(a1 - a, 1e-6);
      const base = Math.max(r + own + leafW / 2 + RING_GAP, (cols * leafW) / w);
      leaves.forEach((c, i) => {
        const row = Math.floor(i / cols);
        const col = i % cols;
        pos[c] = at(base + row * leafW, a + ((col + 0.5) / cols) * w);
      });
    }
  };
  place(hubId, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI, 0, 0);

  const all = nodes.map((n) => ({ id: n.id, x: pos[n.id].x, y: pos[n.id].y, size: size.get(n.id)! }));
  return spaceOutNodes(all, { minGap: MIN_GAP, pinnedId: hubId });
}
