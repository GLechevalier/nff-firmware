// Deterministic force-directed layout for the policy graph. Unlike the Brain graph
// (whose nodes carry stored x/y), policy_states have no coordinates, so we compute them
// on the client. The layout is DETERMINISTIC — positions are seeded from a hash of each
// node id (no Math.random) and the result is meant to be memoized on the node/edge set —
// so it never jitters between re-renders or realtime updates.
//
// Fruchterman-Reingold-lite on the same fixed 800×600 board the SVG renders: pairwise
// repulsion between all nodes + spring attraction along edges, a few hundred cooling
// iterations, then clamp into a margin and center. Self-loops contribute no force.

const WIDTH = 800;
const HEIGHT = 600;
const MARGIN = 60;

export interface Point {
  x: number;
  y: number;
}

// A stable 32-bit hash of a string → used to seed initial positions deterministically.
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

/**
 * Compute board positions for `nodeIds` given the (directed) `edges`. Returns a map
 * id → {x, y} inside the [MARGIN, WIDTH-MARGIN] × [MARGIN, HEIGHT-MARGIN] board.
 * Deterministic: same inputs → same output.
 */
export function layoutGraph(nodeIds: string[], edges: LayoutEdge[]): Record<string, Point> {
  const n = nodeIds.length;
  const pos: Record<string, Point> = {};
  if (n === 0) return pos;
  if (n === 1) {
    pos[nodeIds[0]] = { x: WIDTH / 2, y: HEIGHT / 2 };
    return pos;
  }

  // Seed on a circle jittered by the id hash — deterministic but not degenerate.
  nodeIds.forEach((id, i) => {
    const h = hash(id);
    const angle = (i / n) * 2 * Math.PI + (h % 360) * (Math.PI / 180) * 0.15;
    const radius = 180 + (h % 120);
    pos[id] = { x: WIDTH / 2 + Math.cos(angle) * radius, y: HEIGHT / 2 + Math.sin(angle) * radius };
  });

  // Only edges between distinct nodes exert spring force (self-loops are visual only).
  const springs = edges.filter((e) => e.from !== e.to);

  const k = Math.sqrt((WIDTH * HEIGHT) / n) * 1.15; // ideal edge length (roomier)
  const iterations = 350;
  for (let iter = 0; iter < iterations; iter++) {
    const temp = 1 - iter / iterations; // cooling
    const disp: Record<string, Point> = {};
    for (const id of nodeIds) disp[id] = { x: 0, y: 0 };

    // Repulsion: every pair pushes apart (~k²/d).
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const ia = nodeIds[a];
        const ib = nodeIds[b];
        let dx = pos[ia].x - pos[ib].x;
        let dy = pos[ia].y - pos[ib].y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        // Break exact overlaps deterministically using the id hashes.
        if (dist < 0.02) {
          dx = ((hash(ia + ib) % 100) - 50) / 50;
          dy = ((hash(ib + ia) % 100) - 50) / 50;
          dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        }
        const force = (k * k) / dist * 1.6; // stronger repulsion → fewer overlaps / label collisions
        const ux = dx / dist;
        const uy = dy / dist;
        disp[ia].x += ux * force;
        disp[ia].y += uy * force;
        disp[ib].x -= ux * force;
        disp[ib].y -= uy * force;
      }
    }

    // Attraction along edges (~d²/k).
    for (const e of springs) {
      if (!pos[e.from] || !pos[e.to]) continue;
      const dx = pos[e.from].x - pos[e.to].x;
      const dy = pos[e.from].y - pos[e.to].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist * dist) / k;
      const ux = dx / dist;
      const uy = dy / dist;
      disp[e.from].x -= ux * force;
      disp[e.from].y -= uy * force;
      disp[e.to].x += ux * force;
      disp[e.to].y += uy * force;
    }

    // Apply, capped by the cooling temperature.
    const cap = 30 * temp + 1;
    for (const id of nodeIds) {
      const d = disp[id];
      const dl = Math.sqrt(d.x * d.x + d.y * d.y) || 0.01;
      pos[id].x += (d.x / dl) * Math.min(dl, cap);
      pos[id].y += (d.y / dl) * Math.min(dl, cap);
    }
  }

  // Normalize into the board margins (preserve aspect via a single scale).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of nodeIds) {
    minX = Math.min(minX, pos[id].x);
    minY = Math.min(minY, pos[id].y);
    maxX = Math.max(maxX, pos[id].x);
    maxY = Math.max(maxY, pos[id].y);
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  // Scale X and Y INDEPENDENTLY to fill the board. Aspect-preserving scaling collapses a long
  // chain (e.g. the crash-fix procedure) into a thin vertical strip; independent scaling spreads
  // it across the full width. Mild distortion is fine for a schematic graph.
  const scaleX = (WIDTH - 2 * MARGIN) / spanX;
  const scaleY = (HEIGHT - 2 * MARGIN) / spanY;
  for (const id of nodeIds) {
    pos[id] = {
      x: MARGIN + (pos[id].x - minX) * scaleX,
      y: MARGIN + (pos[id].y - minY) * scaleY,
    };
  }
  return pos;
}
