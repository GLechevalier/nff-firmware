// Which nodes dim with a switched-off tab/tool master: the master itself plus
// everything reachable from it WITHOUT passing through a live anchor (the hub,
// a master that is still on). Edges are undirected here — core's upsertEdge
// treats (from,to) as an unordered pair, so "child" can't be read off `from`.
// Two BFS: what the off masters reach, minus what the live anchors reach.
// Isolated nodes touch neither and stay lit. Zero React — the graph calls it
// from a useMemo, the test calls it bare.

export function offNodeIds(
  nodes: readonly { id: string }[],
  edges: readonly { from: string; to: string }[],
  seeds: ReadonlySet<string>,
  anchors: ReadonlySet<string>,
): Set<string> {
  if (seeds.size === 0) return new Set();
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    adj.get(e.from)?.push(e.to);
    adj.get(e.to)?.push(e.from);
  }
  const reach = (from: ReadonlySet<string>, wall: ReadonlySet<string>): Set<string> => {
    const seen = new Set(from);
    const queue = [...from];
    for (let i = 0; i < queue.length; i++) {
      for (const next of adj.get(queue[i]) ?? []) {
        if (seen.has(next) || wall.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  };
  const on = reach(anchors, seeds);
  const off = reach(seeds, anchors);
  for (const id of on) off.delete(id);
  return off;
}
