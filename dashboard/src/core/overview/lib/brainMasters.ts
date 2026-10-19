// Pure derivation of the company brain's tab + tool master nodes.
//
// nff-admin PERSISTS these (api/_lib/brain.ts's syncDatabase, origin
// 'supabase', into ADMIN_BRAIN_PROJECT_ID). A customer workspace has nobody to
// write them, so nff-app derives them on every load — same contract as
// deriveOverlay (brainOverlay.ts): never stored, recomputed per poll, so the
// positions below MUST be deterministic or the graph jitters every 15 s.
//
// BrainGraph.tsx needs nothing new: it already recognises masters purely by
// sourceRef.kind ('tab' → sidebar icon, 'tool' → brand logo, size bumps,
// density protection, Store/permission dimming via hiddenKeys).

import type { BrainEdge } from '@nff-brain/core/types';
import type { AdminBrainNode } from '../hooks/useBrainGraph';
import { BRAIN_TOOL_CATALOG } from './toolCatalog';
import { offNodeIds } from './offNodes';

/** Derived hub id when the workspace has no core row of its own. */
export const WORKSPACE_HUB_ID = 'workspace-hub';
/** The platform brain's seeded hub row ("Admin Worker") — mirrors nff-admin api/_lib/brain.ts. */
export const ADMIN_CORE_NODE_ID = 'admin-core';

const TAB_RADIUS = 260;
const TOOL_RADIUS = 420;

type HubCandidate = {
  id: string;
  category: string;
  sourceRef?: unknown;
  origin?: string;
  relatedIds?: readonly string[];
};

// RULE: the admin / agent worker is THE central node — the layout root, the
// spacing pin, the merge-priority-1 anchor, the size clamp and the auto-select
// all key off this one predicate. Tiers, first non-empty wins; inside a tier
// the most-connected node, then lowest id (same discipline as core's
// resolveRoot — never row order):
//   1. the known hub rows: admin-core, or the client-derived workspace hub;
//   2. the workspace hub admin's brain sync persists (`<proj8>-core`: category
//      core, origin supabase, NO source_ref — device groups and every master
//      carry one, so they never qualify);
//   3. an `nff-brain init` hub in an employee/custom brain (origin seed).
// Nothing else is ever the hub — a distilled memory categorised "core" or a
// tab master used to win the old "first core row" fallback. null lets
// deriveMasters derive the workspace hub instead.
const HUB_TIERS: ReadonlyArray<(n: HubCandidate) => boolean> = [
  (n) => n.id === ADMIN_CORE_NODE_ID || n.id === WORKSPACE_HUB_ID,
  (n) => n.category === 'core' && n.sourceRef == null && n.origin === 'supabase',
  (n) => n.category === 'core' && n.sourceRef == null && n.origin === 'seed',
];

export function findHubId(nodes: readonly HubCandidate[]): string | null {
  for (const match of HUB_TIERS) {
    let best: HubCandidate | null = null;
    for (const n of nodes) {
      if (!match(n)) continue;
      const d = n.relatedIds?.length ?? 0;
      const bd = best?.relatedIds?.length ?? 0;
      if (!best || d > bd || (d === bd && n.id < best.id)) best = n;
    }
    if (best) return best.id;
  }
  return null;
}

/** Is this node THE hub (derived, synced `<proj8>-core`, or admin-core)? Same tiers as findHubId. */
export const isHubNode = (n: HubCandidate): boolean => findHubId([n]) === n.id;

// RULE: the graph is a tree of priority tiers, every node linked to a parent
// one tier up (extra cross-links stay allowed — the tree is visual structure,
// not a constraint):
//   1  the hub;
//   2  the Store apps — the hub's four children (tab masters devices / admin /
//      dev / finance), drawn smaller than the hub, bigger than everything below;
//   3  the other masters: Device groups (under Devices), every tool master (under
//      its app), the employee hub and portals (under the hub);
//   4  "central" memories — any row with at least
//      P4_MIN_DEGREE stored edges;
//   5  plain memories.
// tierOf is the ONE predicate: deriveMasters stamps it on own rows (node.tier)
// and emits the parent edges; BrainGraph reads the stamp (or recomputes it for
// rows that never went through deriveMasters) for size bumps and merge ranks.
export const BRAIN_APPS = ['devices', 'dev'] as const;
export type BrainApp = (typeof BRAIN_APPS)[number];
// ponytail: fixed degree threshold; make it relative (top decile) if real
// brains land ~0 or ~all of their memories in tier 4.
export const P4_MIN_DEGREE = 4;
export type Tier = 1 | 2 | 3 | 4 | 5;

/**
 * Drawn size per tier, as a multiple of the stored size: the hub 3x, a Store
 * app 2.5x (under the hub's HUB_LEAD clamp), tier 3 keeps its historical bumps
 * (tool logo 2.25x, employee 1.3x, tab 1.5x), a central memory 1.5x,
 * a plain one as stored. ONE table for BrainGraph's size memo and the tree
 * layout, so rings are spaced for what is actually rendered.
 */
export function tierScale(n: { sourceRef?: unknown; kind?: 'hub' | 'portal'; employeeId?: string }, tier: Tier): number {
  if (tier === 1) return 3;
  if (tier === 2) return 2.5;
  if (tier === 3) {
    if ((n.sourceRef as { kind?: string } | null | undefined)?.kind === 'tool') return 2.25;
    return n.kind === 'hub' || n.kind === 'portal' || n.employeeId ? 1.3 : 1.5;
  }
  return tier === 4 ? 1.5 : 1;
}

type TierCandidate = { id: string; sourceRef?: unknown; kind?: 'hub' | 'portal'; employeeId?: string; relatedIds?: readonly string[] };

/** `degree` defaults to relatedIds — pass the STORED-edge count from deriveMasters, since relatedIds later gains the derived parent edge. */
export function tierOf(n: TierCandidate, hubId: string | null, degree = n.relatedIds?.length ?? 0): Tier {
  if (n.id === hubId) return 1;
  const ref = n.sourceRef as { kind?: string; tab?: string } | null | undefined;
  if (ref?.kind === 'tab') return (BRAIN_APPS as readonly string[]).includes(ref.tab ?? '') ? 2 : 3;
  if (ref?.kind === 'tool' || n.kind === 'hub' || n.kind === 'portal' || n.employeeId) return 3;
  if (degree >= P4_MIN_DEGREE) return 4;
  return 5;
}

// Derived nodes carry a FIXED timestamp, never `new Date()`: useProjectBrain
// keeps the previous nodes array when a poll returns identical JSON, and a
// fresh timestamp per poll defeated that guard — every 15s the whole O(n²)
// layout/merge chain re-ran for nothing. The epoch never wins the card's
// "updated N ago" max, so the label reflects real rows.
export const DERIVED_TS = '1970-01-01T00:00:00.000Z';

// Same values api/_lib/brain.ts's placeNode gives a 'core' master, so the
// two apps draw the same node.
const derived = (over: Partial<AdminBrainNode> & { id: string; title: string }): AdminBrainNode => ({
  category: 'core',
  color: '#00ffcc',
  x: 400,
  y: 300,
  size: 32,
  lastUpdated: DERIVED_TS,
  content: '',
  origin: 'seed',
  recallCount: 0,
  relatedIds: [],
  sourceRef: null,
  ...over,
});

const ring = (hub: { x: number; y: number }, i: number, n: number, radius: number) => {
  const a = (i / n) * 2 * Math.PI - Math.PI / 2;
  return { x: hub.x + Math.cos(a) * radius, y: hub.y + Math.sin(a) * radius };
};

/** Half-circle around `at`, facing AWAY from `hub` — children fan outward, never between their parent and the hub. */
const fan = (hub: { x: number; y: number }, at: { x: number; y: number }, i: number, n: number, radius: number) => {
  const out = Math.atan2(at.y - hub.y, at.x - hub.x);
  const a = out + (n > 1 ? (i / (n - 1) - 0.5) * Math.PI : 0);
  return { x: at.x + Math.cos(a) * radius, y: at.y + Math.sin(a) * radius };
};
/** Radius of a derived tool's fan around its app. */
const TOOL_RING = 200;

const workspaceHub = (hubTitle: string) =>
  derived({ id: WORKSPACE_HUB_ID, title: hubTitle, content: 'This workspace’s brain.' });

export type SourceRef = { kind: 'tab'; tab: string } | { kind: 'tool'; tool: string };

export interface SeedSource {
  id: string;
  title: string;
  sourceRef: SourceRef;
  /** Rows to spawn around this satellite (the host passes them once it is activated). */
  children?: ReadonlyArray<{ id: string; title: string; content?: string }>;
}

/** Same source behind two nodes — ids differ across states (seed `tool-github`, synced `<proj8>-tool-github`). */
export function sameSourceRef(a: SourceRef, b: unknown): boolean {
  const r = b as { kind?: string; tab?: string; tool?: string } | null | undefined;
  return r?.kind === a.kind && (a.kind === 'tab' ? r.tab === a.tab : r.tool === a.tool);
}

/**
 * Seed-hub visibility: satellites fold into the hub until it's hovered, then
 * dim until the pointer picks one — except activated satellites, which stay
 * out and lit for good. `focusIds` feeds BrainGraph's `matchedIds` dimming and
 * is always a set here: it must outrank the Store-off fade, which would grey
 * every satellite of a workspace that has nothing connected yet.
 */
export function seedVisibility(
  seed: { nodes: ReadonlyArray<{ id: string }>; hubId: string },
  s: { revealed: boolean; hoveredId: string | null; selectedId: string | null; activatedIds: ReadonlySet<string> },
): { collapsedIds: Set<string> | undefined; focusIds: Set<string> } {
  const folded = seed.nodes.map((n) => n.id).filter((id) => id !== seed.hubId && !s.activatedIds.has(id));
  const focusIds = new Set([seed.hubId, ...s.activatedIds]);
  if (!s.revealed) return { collapsedIds: new Set(folded), focusIds };
  if (s.hoveredId) focusIds.add(s.hoveredId);
  if (s.selectedId) focusIds.add(s.selectedId);
  return { collapsedIds: undefined, focusIds };
}

/**
 * The tree's parent per node — its NEAREST higher-tier neighbour (ties → lowest
 * id), or the hub when nothing above it is linked. RULE: a folded node sits on its
 * MOTHER node, not the hub: BrainGraph draws GitHub on Dev, Device groups on Devices,
 * an app on the hub, and pops a parent's own children when that parent is hovered.
 */
export function treeParents(
  nodes: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<{ from: string; to: string }>,
  tiers: ReadonlyMap<string, Tier>,
  hubId: string | null,
): Map<string, string> {
  const best = new Map<string, string>();
  const consider = (id: string, other: string) => {
    const t = tiers.get(id) ?? 5;
    const to = tiers.get(other) ?? 5;
    if (to >= t) return;
    const cur = best.get(id);
    const tc = cur ? (tiers.get(cur) ?? 5) : Infinity;
    // NEAREST tier above, not the lowest: a stale sync edge from To Do straight to
    // the hub must not steal it from Admin.
    if (!cur || to > tc || (to === tc && other < cur)) best.set(id, other);
  };
  for (const e of edges) {
    if (e.from === e.to) continue;
    consider(e.from, e.to);
    consider(e.to, e.from);
  }
  if (hubId) for (const n of nodes) if (n.id !== hubId && !best.has(n.id)) best.set(n.id, hubId);
  return best;
}

/**
 * RULE: only the LAST hovered parent keeps its folded children out. Does hovering
 * `id` take over that role? Yes for a node with something folded directly under
 * it, and for a folded node itself (its chain keeps the parent revealed, see
 * revealChain); a leaf leaves the last parent as is.
 */
export function revealTarget(
  id: string,
  foldable: ReadonlySet<string>,
  parentOf: ReadonlyMap<string, string>,
  hubId: string | null,
): boolean {
  if (foldable.has(id)) return true;
  for (const f of foldable) if ((parentOf.get(f) ?? hubId) === id) return true;
  return false;
}

/**
 * The ids BrainGraph must treat as revealed for each start (the last hovered
 * parent, the selected node): the start plus the folded ancestors it needs to
 * stay drawn — hover a popped GitHub and Dev stays revealed under the pointer.
 * Stops at the first drawn ancestor, so hovering Admin never pops the hub's other apps.
 */
export function revealChain(
  starts: ReadonlyArray<string | null>,
  foldable: ReadonlySet<string>,
  parentOf: ReadonlyMap<string, string>,
  hubId: string | null,
): Set<string> {
  const out = new Set<string>();
  for (const start of starts) {
    let id = start;
    for (let guard = 0; id && !out.has(id) && guard < 32; guard++) {
      out.add(id);
      id = foldable.has(id) ? (parentOf.get(id) ?? hubId) : null;
    }
  }
  return out;
}

const isMasterRef = (ref: unknown) => {
  const k = (ref as { kind?: string } | null | undefined)?.kind;
  return k === 'tab' || k === 'tool';
};

/**
 * The REAL graph's upgrade offer — same beat as the seed hub, whatever state
 * the brain is in: the masters of the seeds not in use yet fold into the hub
 * until it is hovered. "In use" = activated, or a source of it connected, or a
 * real memory hanging under it — `activated` is per-browser localStorage, so a
 * Dev app feeding rows on another machine must never vanish into the hub.
 * Folds the master plus whatever hangs ONLY off it (Dev's tool masters go
 * with Dev); a subtree holding anything but tab/tool masters is content.
 */
export function upgradeIds(
  nodes: ReadonlyArray<{ id: string; sourceRef?: unknown }>,
  edges: ReadonlyArray<{ from: string; to: string }>,
  seeds: ReadonlyArray<{ sourceRef: SourceRef; activated: boolean; connected: boolean }>,
  hubId: string,
): Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const masterOf = seeds.map((s) => nodes.find((n) => sameSourceRef(s.sourceRef, n.sourceRef))?.id ?? null);
  const anchors = new Set([hubId, ...masterOf.filter((id): id is string => id !== null)]);
  const out = new Set<string>();
  seeds.forEach((s, i) => {
    const id = masterOf[i];
    if (!id || s.activated || s.connected) return;
    const wall = new Set(anchors);
    wall.delete(id);
    const sub = offNodeIds(nodes, edges, new Set([id]), wall);
    if ([...sub].every((x) => isMasterRef(byId.get(x)?.sourceRef))) sub.forEach((x) => out.add(x));
  });
  return out;
}

/**
 * Empty-workspace onboarding graph: the hub plus one satellite per source,
 * all on the tab ring. Same ids deriveMasters emits (`tab-<rail>`, `tool-<id>`)
 * so the first sync morphs the satellites into the real masters in place
 * instead of remounting the graph.
 */
export function deriveSeedGraph(
  seeds: readonly SeedSource[],
  hubTitle: string,
): { nodes: AdminBrainNode[]; edges: BrainEdge[]; hubId: string } {
  const hub = workspaceHub(hubTitle);
  const nodes = [hub];
  const edges: BrainEdge[] = [];
  seeds.forEach((s, i) => {
    const sat = derived({ id: s.id, title: s.title, content: s.title, sourceRef: s.sourceRef, ...ring(hub, i, seeds.length, TAB_RADIUS) });
    nodes.push(sat);
    edges.push({ from: s.id, to: hub.id, strength: 0.9 });
    // Children sit on an arc facing AWAY from the hub (a full ring would drop the
    // inner ones onto it), same shape admin's sync writes for `device-*` rows.
    // The merge test is per AXIS (core density.ts: |dx| < sizes+slack AND |dy| <
    // sizes+14+slack, slack = 16px / zoom ≈ 55–75 units with the side panel open),
    // so diagonal neighbours need a chord of ~1.4× that: ≥ ~200 units.
    // ponytail: radius grows linearly with the count, which shrinks the fit zoom
    // and widens the slack — past ~12 devices they start merging into ×N blobs
    // (the graph's normal behaviour); ring them in two rows if that reads wrong.
    const kids = s.children ?? [];
    const away = Math.atan2(sat.y - hub.y, sat.x - hub.x);
    const radius = Math.max(180, kids.length * 52);
    kids.forEach((c, k) => {
      const a = away + ((k + 0.5) / kids.length - 0.5) * ((4 * Math.PI) / 3);
      nodes.push(derived({
        id: c.id, title: c.title, content: c.content ?? c.title, category: 'analysis', size: 16,
        sourceRef: { table: 'devices', id: c.id.replace(/^device-/, '') },
        x: sat.x + Math.cos(a) * radius, y: sat.y + Math.sin(a) * radius,
      }));
      edges.push({ from: c.id, to: s.id, strength: 0.7 });
    });
  });
  return { nodes, edges, hubId: hub.id };
}

/**
 * `edges` = the STORED edges among `companyNodes` (tier 4 is a degree count,
 * and relatedIds is empty on the demo path / already polluted by earlier
 * derived edges elsewhere). Stamps `tier` on every own row in place — same
 * contract as linkEdges' relatedIds.
 */
export function deriveMasters(
  companyNodes: AdminBrainNode[],
  edges: ReadonlyArray<{ from: string; to: string }>,
  tabs: ReadonlyArray<{ id: string; label: string; app?: string }>,
  hubTitle: string,
): { nodes: AdminBrainNode[]; edges: BrainEdge[] } {
  // A brand-new workspace keeps BrainCard's empty hint (nodes.length === 0).
  if (companyNodes.length === 0) return { nodes: [], edges: [] };

  const nodes: AdminBrainNode[] = [];
  const out: BrainEdge[] = [];

  // Customer workspaces have no hub row until admin's brain sync writes one
  // (the worker never does); derive the agent-worker hub so findHubId, the
  // overlay and the reorganize root all anchor on it.
  const existingHubId = findHubId(companyNodes);
  let hub = existingHubId ? companyNodes.find((n) => n.id === existingHubId) : undefined;
  if (!hub) {
    hub = workspaceHub(hubTitle);
    nodes.push(hub);
  }
  const hubId = hub.id;
  const at = hub;

  // Tier every own row on its stored degree.
  const own = new Set(companyNodes.map((n) => n.id));
  const degree = new Map<string, number>();
  for (const e of edges) {
    if (!own.has(e.from) || !own.has(e.to) || e.from === e.to) continue;
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const tier = new Map<string, Tier>();
  for (const n of companyNodes) {
    n.tier = tierOf(n, hubId, degree.get(n.id) ?? 0);
    tier.set(n.id, n.tier);
  }
  hub.tier = 1;
  tier.set(hubId, 1);

  // A workspace sync (POST /brain/sync) persists its own masters, namespaced
  // (`<proj8>-tab-devices`, `<proj8>-tool-github`); derive only the ones that
  // are NOT already on the graph, matched by source_ref, so nothing doubles up.
  const masterId = (ref: SourceRef) => companyNodes.find((n) => sameSourceRef(ref, n.sourceRef))?.id ?? null;
  const master = (over: Parameters<typeof derived>[0]) => {
    const n = derived(over);
    n.tier = tierOf(n, hubId);
    tier.set(n.id, n.tier);
    nodes.push(n);
    return n;
  };

  // RULE: every master is linked to its parent tier — an app to the hub, the
  // rest to their app — including the ones a sync already persisted. The
  // stored edge can be gone (hub row deleted or replaced in the previewer, an
  // older sync that anchored everything on the hub), so re-assert it on every
  // load; linkEdges (brainOverlay.ts) collapses the duplicate against the row
  // that is still in brain_edges.
  const parent = (id: string, to: string, strength: number) => {
    if (id !== to) out.push({ from: id, to, strength });
  };

  const tabIds = new Map<string, string>();
  tabs.forEach((t, i) => {
    const existing = masterId({ kind: 'tab', tab: t.id });
    const id = existing ?? `tab-${t.id}`;
    if (!existing) master({ id, title: t.label, content: `${t.label} tab`, sourceRef: { kind: 'tab', tab: t.id }, ...ring(at, i, tabs.length, TAB_RADIUS) });
    tabIds.set(t.id, id);
  });
  // A tab that is its own app is a hub child; anything else hangs off its app
  // (a missing app — a test's short tab list — falls back to the hub).
  const appOf = (app: string | undefined) => (app && tabIds.get(app)) || hubId;
  for (const t of tabs) parent(tabIds.get(t.id)!, t.app === t.id ? hubId : appOf(t.app), 0.9);

  // A derived tool master fans out on the far side of its APP, so the tree
  // shape holds on a brain nobody has reorganized; no app on the graph → the
  // hub-wide tool ring.
  const byApp = new Map<string, typeof BRAIN_TOOL_CATALOG>();
  for (const t of BRAIN_TOOL_CATALOG) (byApp.get(t.app) ?? byApp.set(t.app, []).get(t.app)!).push(t);
  const nodeAt = (id: string) => companyNodes.find((n) => n.id === id) ?? nodes.find((n) => n.id === id);
  BRAIN_TOOL_CATALOG.forEach((t, i) => {
    const existing = masterId({ kind: 'tool', tool: t.id });
    const id = existing ?? `tool-${t.id}`;
    if (!existing) {
      const appId = tabIds.get(t.app);
      const app = appId ? nodeAt(appId) : undefined;
      const siblings = byApp.get(t.app)!;
      const spot = app ? fan(at, app, siblings.indexOf(t), siblings.length, TOOL_RING) : ring(at, i, BRAIN_TOOL_CATALOG.length, TOOL_RADIUS);
      master({ id, title: t.label, content: `Connected tool: ${t.label}`, sourceRef: { kind: 'tool', tool: t.id }, ...spot });
    }
    parent(id, appOf(t.app), 0.9);
  });

  // Tiers 4–5: a row with no stored edge to a higher tier gets one to the
  // nearest node one tier up (then two up… then the hub) — deterministic on
  // stored positions, so the 15 s poll sees the same edge every time.
  const higher = new Map<string, Set<string>>();
  for (const e of edges) {
    const a = tier.get(e.from);
    const b = tier.get(e.to);
    if (a === undefined || b === undefined) continue;
    if (b < a) (higher.get(e.from) ?? higher.set(e.from, new Set()).get(e.from)!).add(e.to);
    if (a < b) (higher.get(e.to) ?? higher.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  const all = companyNodes.concat(nodes);
  for (const n of companyNodes) {
    const t = n.tier!;
    if (t < 4 || higher.has(n.id)) continue;
    for (let up = t - 1; up >= 1 && !higher.has(n.id); up--) {
      let best: AdminBrainNode | null = null;
      let bestD = Infinity;
      for (const c of all) {
        if (c.id === n.id || tier.get(c.id) !== up) continue;
        const d = (c.x - n.x) ** 2 + (c.y - n.y) ** 2;
        if (d < bestD || (d === bestD && best && c.id < best.id)) {
          best = c;
          bestD = d;
        }
      }
      if (best) {
        parent(n.id, best.id, 0.6);
        higher.set(n.id, new Set([best.id]));
      }
    }
  }

  // ponytail: nearest-by-position parent; port admin's trigram similarity
  // (brain.ts planSync) if "closest" reads wrong once memories cluster under
  // the wrong tool.
  return { nodes, edges: out };
}
