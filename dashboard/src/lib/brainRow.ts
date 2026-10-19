// brain_nodes / brain_edges rows → the graph model.
//
// The model itself lives in @nff-brain/core, which is where it is maintained;
// this file is only the Supabase row adapter. It replaces src/data/mockBrainNodes.ts,
// which declared a hand-synced copy of the types (plus a mock graph nothing had
// imported in a long time), and it de-duplicates the byte-identical mapNode /
// mapEdge pair that useBrainGraph and useFeatureBrain each carried.

import { asCategory, type BrainNode, type BrainEdge } from '@nff-brain/core/types';

// core's BrainNode carries no adjacency — edges are their own list. The graph UI
// wants each node's neighbours to hand, so the derived field lives here rather
// than being pushed back into the shared type.
export type DashboardBrainNode = BrainNode & { relatedIds: string[] };

export function mapNode(row: Record<string, unknown>): DashboardBrainNode {
  return {
    id: row.id as string,
    title: row.title as string,
    // asCategory over a cast: the DB constrains category to four values, but this
    // is untrusted JSON off the wire and an unknown one lands on 'strategy'
    // instead of poisoning the render.
    category: asCategory(row.category),
    color: row.color as string,
    x: row.x as number,
    y: row.y as number,
    size: row.size as number,
    lastUpdated: row.last_updated as string, // ISO string — core stores it as written
    content: row.content as string,
    origin: (row.origin as BrainNode['origin']) ?? 'agent',
    recallCount: (row.recall_count as number) ?? 0,
    relatedIds: [],
  };
}

export function mapEdge(row: Record<string, unknown>): BrainEdge {
  return {
    from: row.from_id as string,
    to: row.to_id as string,
    strength: row.strength as number,
  };
}

/** Fill in each node's neighbours from the edge list, in place. */
export function linkRelated(nodes: DashboardBrainNode[], edges: BrainEdge[]): void {
  for (const node of nodes) {
    node.relatedIds = edges
      .filter((e) => e.from === node.id || e.to === node.id)
      .map((e) => (e.from === node.id ? e.to : e.from));
  }
}
