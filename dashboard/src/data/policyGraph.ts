// Layer-2 policy-graph domain types + small pure helpers for the Policy tab.
// The graph is a cost-aware, cohort-lifted state→action model recorded in shadow by
// nff-agent-worker (see nff-db 0067): states are nodes, (from, action, to) are directed,
// weighted edges. This file is the browser-side shape of those two tables plus the
// label/formatting logic the renderer and detail panel share.

// The lifted dimensions a state's canonical id hashes (mirror of the worker's
// StateDimensions: src/policy/state.ts). sig = [fw, build, deployment, group, deviceType].
export interface StateDimensions {
  cohorts: Array<{
    extent: 'one' | 'few' | 'group' | 'many' | 'fleet';
    fault: string;
    sig: [string | null, string | null, string | null, string | null, string | null];
  }>;
  infra: { reason: string } | null;
  // A BELIEF / INTERVENTION node in a remediation procedure — a point BETWEEN tools where the
  // agent must decide the next move (e.g. "have crash logs, need diagnosis"). This is the Layer-2
  // belief-state extension: observation/diagnosis tools advance belief, so they create these
  // nodes. Fleet-observation states leave this null.
  procedure?: { name: string; step: string } | null;
}

export interface PolicyState {
  id: string; // state_id — the 16-hex canonical hash
  summary: string; // the human summarizeState() one-liner (grounding)
  dimensions: StateDimensions;
  visitCount: number;
  lastSeen: Date;
}

export interface PolicyTransition {
  from: string; // from_state (state_id)
  action: string;
  to: string; // to_state (state_id)
  count: number;
  successCount: number;
  refutedCount: number;
  sumShots: number;
  sumWallMs: number;
  sumTokens: number;
  sumWastedSteps: number;
  lastSeen: Date;
}

// A stable key for an edge (a directed multigraph — same from/to can carry >1 action).
export function edgeKey(t: PolicyTransition): string {
  return `${t.from}|${t.action}|${t.to}`;
}

// A belief/intervention node (a step in a remediation procedure), not a sensed fleet state.
export function isProcedural(s: PolicyState): boolean {
  return !!s.dimensions.procedure;
}

// The "all healthy" target region: a fleet state with no cohorts deviating and no infra fault.
// Procedural nodes are never the goal.
export function isGoalState(s: PolicyState): boolean {
  return !s.dimensions.procedure && s.dimensions.cohorts.length === 0 && !s.dimensions.infra;
}

// Strip the noisy `crash:` / `status:` / `ota:` prefix off a fault for a compact caption.
function shortFault(fault: string): string {
  const i = fault.indexOf(':');
  return i === -1 ? fault : fault.slice(i + 1);
}

// A compact node caption from the lifted dimensions: `healthy` for a goal state,
// `infra:<reason>` for an infra fault, else the dominant cohort as `extent·fault`
// (with a `+N` suffix when other cohorts are present). Full detail lives in the panel.
export function shortLabel(s: PolicyState): string {
  if (s.dimensions.procedure) return s.dimensions.procedure.step;
  if (isGoalState(s)) return 'healthy';
  if (s.dimensions.infra) return `infra:${s.dimensions.infra.reason}`;
  const [first, ...rest] = s.dimensions.cohorts;
  if (!first) return 'unknown';
  const base = `${first.extent}·${shortFault(first.fault)}`;
  return rest.length ? `${base} +${rest.length}` : base;
}

// Derived edge stats (kept here so the renderer and panel agree).
export function successRate(t: PolicyTransition): number {
  return t.count > 0 ? t.successCount / t.count : 0;
}
export function avgTokens(t: PolicyTransition): number {
  return t.count > 0 ? Math.round(t.sumTokens / t.count) : 0;
}
export function avgWallMs(t: PolicyTransition): number {
  return t.count > 0 ? Math.round(t.sumWallMs / t.count) : 0;
}
export function avgShots(t: PolicyTransition): number {
  return t.count > 0 ? t.sumShots / t.count : 0;
}
