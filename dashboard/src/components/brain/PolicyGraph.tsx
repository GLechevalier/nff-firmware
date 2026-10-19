import type { PolicyState, PolicyTransition } from '../../data/policyGraph';
import { edgeKey, isGoalState, isProcedural, shortLabel, successRate } from '../../data/policyGraph';
import type { Point } from '../../utils/graphLayout';

// The Layer-2 policy-graph renderer — the directed, weighted cousin of BrainGraph. Pure
// inline SVG on the same fixed 800×600 board (positions come from graphLayout, since
// policy_states carry no coordinates). The parent owns selection/hover so it can pair the
// graph with a detail panel. Edges are directed (arrowheads), colored by success rate and
// thickened by visit count; self-loops and parallel actions are drawn distinctly.

export type PolicySelection = { kind: 'node'; id: string } | { kind: 'edge'; id: string };

interface PolicyGraphProps {
  states: PolicyState[];
  transitions: PolicyTransition[];
  positions: Record<string, Point>;
  selected: PolicySelection | null;
  hovered: PolicySelection | null;
  onSelect: (sel: PolicySelection | null) => void;
  onHover: (sel: PolicySelection | null) => void;
  emptyState?: React.ReactNode;
}

// Node half-side from visit frequency (12–30), scaled against the busiest state.
function nodeSize(visit: number, maxVisit: number): number {
  if (maxVisit <= 0) return 14;
  return 12 + (visit / maxVisit) * 18;
}

// Success-rate → color: green (works) → amber (mixed) → red (fails/refuted); grey when
// there's essentially no evidence yet.
function edgeColor(t: PolicyTransition): string {
  if (t.count < 1) return '#bbb';
  const r = successRate(t);
  if (r >= 0.75) return '#16a34a';
  if (r >= 0.4) return '#d97706';
  return '#dc2626';
}

// Visit count → stroke width (log-scaled, 1–5).
function edgeWidth(count: number): number {
  return Math.max(1, Math.min(5, 1 + Math.log2(count + 1)));
}

const GLYPH = (s: PolicyState): string =>
  isProcedural(s) ? '▸' : isGoalState(s) ? '✓' : s.dimensions.infra ? '⚡' : '✕';

// The unordered pair key groups every edge between the same two nodes (both directions +
// parallel actions) so they can be fanned apart instead of overlapping.
function pairKey(from: string, to: string): string {
  return from < to ? `${from}|${to}` : `${to}|${from}`;
}

export function PolicyGraph({ states, transitions, positions, selected, hovered, onSelect, onHover, emptyState }: PolicyGraphProps) {
  const stateMap = Object.fromEntries(states.map((s) => [s.id, s]));
  const maxVisit = states.reduce((m, s) => Math.max(m, s.visitCount), 0);

  if (states.length === 0 && emptyState) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
        {emptyState}
      </div>
    );
  }

  // Assign each edge a fan index within its unordered pair (deterministic: sorted by
  // direction + action) so parallel/bidirectional edges spread out.
  const groups = new Map<string, PolicyTransition[]>();
  for (const t of transitions) {
    if (t.from === t.to) continue; // self-loops handled separately
    const key = pairKey(t.from, t.to);
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => (a.from === b.from ? a.action.localeCompare(b.action) : a.from.localeCompare(b.from)));
  }
  const fanOffset = (t: PolicyTransition): number => {
    const g = groups.get(pairKey(t.from, t.to))!;
    const idx = g.indexOf(t);
    return (idx - (g.length - 1) / 2) * 34;
  };

  const isSel = (kind: 'node' | 'edge', id: string) =>
    (selected?.kind === kind && selected.id === id) || (hovered?.kind === kind && hovered.id === id);
  // A node is "touched" when it, or an incident edge, is selected/hovered.
  const nodeTouched = (id: string): boolean => {
    if (isSel('node', id)) return true;
    for (const sel of [selected, hovered]) {
      if (sel?.kind === 'edge') {
        const t = transitions.find((e) => edgeKey(e) === sel.id);
        if (t && (t.from === id || t.to === id)) return true;
      }
    }
    return false;
  };
  const edgeTouched = (t: PolicyTransition): boolean =>
    isSel('edge', edgeKey(t)) || isSel('node', t.from) || isSel('node', t.to);

  return (
    <svg viewBox="0 0 800 600" preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: '100%', display: 'block' }}>
      <rect width="800" height="600" fill="#fff" onClick={() => onSelect(null)} />

      {/* ── directed edges (between distinct nodes) ── */}
      {transitions.filter((t) => t.from !== t.to).map((t) => {
        const from = positions[t.from];
        const to = positions[t.to];
        const fromS = stateMap[t.from];
        const toS = stateMap[t.to];
        if (!from || !to || !fromS || !toS) return null;
        const key = edgeKey(t);
        const active = edgeTouched(t);
        const color = active ? '#000' : edgeColor(t);
        const width = edgeWidth(t.count) + (active ? 1 : 0);

        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const perpx = -uy;
        const perpy = ux;
        const rFrom = nodeSize(fromS.visitCount, maxVisit) + 2;
        const rTo = nodeSize(toS.visitCount, maxVisit) + 8; // extra room for the arrowhead
        const sx = from.x + ux * rFrom;
        const sy = from.y + uy * rFrom;
        const ex = to.x - ux * rTo;
        const ey = to.y - uy * rTo;
        const grp = groups.get(pairKey(t.from, t.to))!;
        const gi = grp.indexOf(t);
        const gm = grp.length;
        const off = fanOffset(t);
        const cx = (sx + ex) / 2 + perpx * off;
        const cy = (sy + ey) / 2 + perpy * off;

        // Arrowhead: tangent at the curve end (quadratic B'(1) ∝ end − control).
        const tx = ex - cx;
        const ty = ey - cy;
        const tl = Math.sqrt(tx * tx + ty * ty) || 1;
        const nx = tx / tl;
        const ny = ty / tl;
        const AH = 9; // arrow length
        const AW = 4.5; // half-width
        const backx = ex - nx * AH;
        const backy = ey - ny * AH;
        const arrow = `${ex},${ey} ${backx + perpArrow(nx, ny).x * AW},${backy + perpArrow(nx, ny).y * AW} ${backx - perpArrow(nx, ny).x * AW},${backy - perpArrow(nx, ny).y * AW}`;

        // Label anchor on the curve. For parallel edges, stagger each label along the edge
        // (different t) AND nudge it to its own curve's side, so they don't stack.
        const lt = gm > 1 ? 0.3 + 0.4 * (gi / (gm - 1)) : 0.5;
        const bez = (a: number, c: number, b: number) => (1 - lt) * (1 - lt) * a + 2 * (1 - lt) * lt * c + lt * lt * b;
        const nudge = off === 0 ? 0 : Math.sign(off) * 8;
        const mx = bez(sx, cx, ex) + perpx * nudge;
        const my = bez(sy, cy, ey) + perpy * nudge;
        // Static label = action only (color already encodes success rate); the % appears on
        // hover/select and in the detail panel, so the resting graph stays uncluttered.
        const label = active ? `${t.action} ${Math.round(successRate(t) * 100)}%` : t.action;

        return (
          <g key={key} style={{ cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'edge', id: key }); }}
            onMouseEnter={() => onHover({ kind: 'edge', id: key })}
            onMouseLeave={() => onHover(null)}>
            {/* fat invisible hit target */}
            <path d={`M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`} stroke="transparent" strokeWidth={12} fill="none" />
            <path d={`M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`} stroke={color} strokeWidth={width} fill="none" />
            <polygon points={arrow} fill={color} />
            {(active || transitions.length <= 24) && (
              <text x={mx} y={my - 3} textAnchor="middle" fontSize={9}
                fill={active ? '#000' : '#444'}
                stroke="#fff" strokeWidth={3} paintOrder="stroke"
                style={{ pointerEvents: 'none', userSelect: 'none', fontWeight: active ? 'bold' : 'normal' }}>
                {label}
              </text>
            )}
          </g>
        );
      })}

      {/* ── self-loops (actuation that left the state unchanged) ── */}
      {transitions.filter((t) => t.from === t.to).map((t) => {
        const p = positions[t.from];
        const s = stateMap[t.from];
        if (!p || !s) return null;
        const key = edgeKey(t);
        const active = edgeTouched(t);
        const color = active ? '#000' : edgeColor(t);
        const width = edgeWidth(t.count) + (active ? 1 : 0);
        const r = nodeSize(s.visitCount, maxVisit);
        const topY = p.y - r;
        const d = `M ${p.x - 7} ${topY} C ${p.x - 42} ${topY - 58} ${p.x + 42} ${topY - 58} ${p.x + 7} ${topY}`;
        // Arrowhead pointing back down into the node at the loop end.
        const arrow = `${p.x + 7},${topY} ${p.x + 2},${topY - 9} ${p.x + 13},${topY - 8}`;
        return (
          <g key={key} style={{ cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'edge', id: key }); }}
            onMouseEnter={() => onHover({ kind: 'edge', id: key })}
            onMouseLeave={() => onHover(null)}>
            <path d={d} stroke="transparent" strokeWidth={12} fill="none" />
            <path d={d} stroke={color} strokeWidth={width} fill="none" />
            <polygon points={arrow} fill={color} />
            {(active || transitions.length <= 24) && (
              <text x={p.x} y={topY - 62} textAnchor="middle" fontSize={9}
                fill={active ? '#000' : '#444'}
                stroke="#fff" strokeWidth={3} paintOrder="stroke"
                style={{ pointerEvents: 'none', userSelect: 'none', fontWeight: active ? 'bold' : 'normal' }}>
                {active ? `${t.action} ${Math.round(successRate(t) * 100)}%` : t.action}
              </text>
            )}
          </g>
        );
      })}

      {/* ── nodes ── */}
      {states.map((s) => {
        const p = positions[s.id];
        if (!p) return null;
        const size = nodeSize(s.visitCount, maxVisit);
        const selectedNode = isSel('node', s.id);
        const touched = nodeTouched(s.id);
        const goal = isGoalState(s);
        const proc = isProcedural(s);
        // Fleet-state nodes = solid squares; belief/intervention nodes = rounded + dashed (a
        // transient point the agent passes THROUGH, not a physical fleet state).
        return (
          <g key={s.id} style={{ cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); onSelect({ kind: 'node', id: s.id }); }}
            onMouseEnter={() => onHover({ kind: 'node', id: s.id })}
            onMouseLeave={() => onHover(null)}>
            <rect x={p.x - size} y={p.y - size} width={size * 2} height={size * 2}
              rx={proc ? 9 : 0}
              fill={selectedNode ? '#000' : touched ? '#f5f5f5' : '#fff'}
              stroke={goal ? '#16a34a' : proc ? '#6b7280' : '#000'}
              strokeWidth={selectedNode ? 0 : goal ? 2 : 1}
              strokeDasharray={proc && !selectedNode ? '4 3' : undefined} />
            <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={size > 20 ? 13 : 10}
              fill={selectedNode ? '#fff' : goal ? '#16a34a' : proc ? '#6b7280' : '#000'}
              style={{ pointerEvents: 'none', userSelect: 'none' }}>
              {GLYPH(s)}
            </text>
            <text x={p.x} y={p.y + size + 13} textAnchor="middle" fontSize={10}
              fill="#000" fontWeight={selectedNode ? 'bold' : 'normal'}
              stroke="#fff" strokeWidth={3} paintOrder="stroke"
              style={{ pointerEvents: 'none', userSelect: 'none' }}>
              {shortLabel(s)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// Perpendicular unit of a (already unit) tangent — the arrowhead's base spread direction.
function perpArrow(nx: number, ny: number): Point {
  return { x: -ny, y: nx };
}
