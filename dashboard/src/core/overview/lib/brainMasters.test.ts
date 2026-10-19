// deriveMasters runs on every 15 s poll and its output is never persisted:
// wrong ids collide with real rows, wrong positions jitter the graph, and a
// missing hub makes findHubId pin the layout on a tab master.

import { describe, expect, it } from 'vitest';
import { ADMIN_CORE_NODE_ID, deriveMasters, deriveSeedGraph, findHubId, P4_MIN_DEGREE, revealChain, revealTarget, sameSourceRef, seedVisibility, tierOf, treeParents, upgradeIds, WORKSPACE_HUB_ID } from './brainMasters';
import { BRAIN_TOOL_CATALOG } from './toolCatalog';
import type { AdminBrainNode } from '../hooks/useBrainGraph';

// Two Store apps and one tab under Devices.
const TABS = [
  { id: 'devices', label: 'Devices', app: 'devices' },
  { id: 'dev', label: 'Dev', app: 'dev' },
  { id: 'groups', label: 'Device groups', app: 'devices' },
];

const node = (over: Partial<AdminBrainNode> = {}): AdminBrainNode => ({
  id: 'm1',
  title: 'A memory',
  category: 'strategy',
  color: '#a78bfa',
  x: 10,
  y: 20,
  size: 16,
  lastUpdated: '2026-01-01T00:00:00.000Z',
  content: '',
  origin: 'agent',
  recallCount: 0,
  relatedIds: [],
  sourceRef: null,
  ...over,
});

describe('deriveSeedGraph', () => {
  const seeds = [
    { id: 'tab-other', title: 'Devices', sourceRef: { kind: 'tab', tab: 'devices' } as const },
    { id: 'tool-flash', title: 'Emails', sourceRef: { kind: 'tool', tool: 'gmail' } as const },
  ];

  it('is the hub plus one satellite per seed, every edge a spoke to the hub', () => {
    const { nodes, edges, hubId } = deriveSeedGraph(seeds, 'Company Brain');
    expect(hubId).toBe(WORKSPACE_HUB_ID);
    expect(nodes.map((n) => n.id)).toEqual([WORKSPACE_HUB_ID, 'tab-other', 'tool-flash']);
    expect(nodes.find((n) => n.id === 'tool-flash')).toMatchObject({ category: 'core', sourceRef: { kind: 'tool', tool: 'gmail' } });
    expect(edges).toEqual([
      { from: 'tab-other', to: WORKSPACE_HUB_ID, strength: 0.9 },
      { from: 'tool-flash', to: WORKSPACE_HUB_ID, strength: 0.9 },
    ]);
  });

  it('places satellites deterministically, off the hub', () => {
    const a = deriveSeedGraph(seeds, 'Company Brain');
    const b = deriveSeedGraph(seeds, 'Company Brain');
    const pos = (g: typeof a) => g.nodes.map((n) => [n.id, n.x, n.y]);
    expect(pos(a)).toEqual(pos(b));
    const hub = a.nodes[0];
    for (const n of a.nodes.slice(1)) expect(Math.hypot(n.x - hub.x, n.y - hub.y)).toBeGreaterThan(200);
  });

  it('spawns a seed\'s children on its far side, each spoked to the seed, spaced past the merge slack', () => {
    const withKids = [
      { ...seeds[0], children: [{ id: 'device-a', title: 'Board A' }, { id: 'device-b', title: 'Board B', content: 'Device B — online' }] },
      seeds[1],
    ];
    const g = deriveSeedGraph(withKids, 'Company Brain');
    expect(g.nodes.map((n) => n.id)).toEqual([WORKSPACE_HUB_ID, 'tab-other', 'device-a', 'device-b', 'tool-flash']);
    expect(g.edges).toContainEqual({ from: 'device-a', to: 'tab-other', strength: 0.7 });
    expect(g.edges).toContainEqual({ from: 'device-b', to: 'tab-other', strength: 0.7 });
    expect(g.nodes.find((n) => n.id === 'device-b')).toMatchObject({ category: 'analysis', content: 'Device B — online', sourceRef: { table: 'devices', id: 'b' } });
    const [hub, sat, a, b] = g.nodes;
    const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
    expect(dist(a, hub)).toBeGreaterThan(dist(sat, hub));
    expect(dist(b, hub)).toBeGreaterThan(dist(sat, hub));
    expect(dist(a, b)).toBeGreaterThan(100);
    expect(deriveSeedGraph(withKids, 'Company Brain').nodes.map((n) => [n.x, n.y])).toEqual(g.nodes.map((n) => [n.x, n.y]));
  });
});

describe('sameSourceRef', () => {
  it('matches on kind + key, whatever the node id', () => {
    expect(sameSourceRef({ kind: 'tool', tool: 'github' }, { kind: 'tool', tool: 'github' })).toBe(true);
    expect(sameSourceRef({ kind: 'tab', tab: 'devices' }, { kind: 'tab', tab: 'devices' })).toBe(true);
    expect(sameSourceRef({ kind: 'tool', tool: 'github' }, { kind: 'tool', tool: 'posthog' })).toBe(false);
    expect(sameSourceRef({ kind: 'tab', tab: 'devices' }, { kind: 'tool', tool: 'devices' })).toBe(false);
    expect(sameSourceRef({ kind: 'tool', tool: 'github' }, null)).toBe(false);
  });
});

describe('seedVisibility', () => {
  const seed = deriveSeedGraph(
    [
      { id: 'tab-other', title: 'Devices', sourceRef: { kind: 'tab', tab: 'devices' } },
      { id: 'tool-flash', title: 'Emails', sourceRef: { kind: 'tool', tool: 'gmail' } },
      { id: 'tool-github', title: 'GitHub', sourceRef: { kind: 'tool', tool: 'github' } },
    ],
    'Company Brain',
  );
  const none = new Set<string>();

  it('folds every satellite and lights only the hub until it is hovered', () => {
    const v = seedVisibility(seed, { revealed: false, hoveredId: null, selectedId: null, activatedIds: none });
    expect([...v.collapsedIds!].sort()).toEqual(['tab-other', 'tool-flash', 'tool-github']);
    expect([...v.focusIds]).toEqual([WORKSPACE_HUB_ID]);
  });

  it('once revealed, lights only the hub + the hovered/selected satellite', () => {
    const v = seedVisibility(seed, { revealed: true, hoveredId: 'tool-flash', selectedId: null, activatedIds: none });
    expect(v.collapsedIds).toBeUndefined();
    expect([...v.focusIds].sort()).toEqual([WORKSPACE_HUB_ID, 'tool-flash'].sort());
  });

  it('an activated satellite never folds back and stays lit', () => {
    const activatedIds = new Set(['tool-github']);
    const folded = seedVisibility(seed, { revealed: false, hoveredId: null, selectedId: null, activatedIds });
    expect([...folded.collapsedIds!].sort()).toEqual(['tab-other', 'tool-flash']);
    const out = seedVisibility(seed, { revealed: true, hoveredId: 'tab-other', selectedId: null, activatedIds });
    expect([...out.focusIds!].sort()).toEqual([WORKSPACE_HUB_ID, 'tab-other', 'tool-github'].sort());
  });
});

const appOf = (toolId: string) => BRAIN_TOOL_CATALOG.find((t) => t.id === toolId)!.app;

describe('deriveMasters', () => {
  it('derives nothing for an empty workspace so the empty hint survives', () => {
    expect(deriveMasters([], [], TABS, 'Company Brain')).toEqual({ nodes: [], edges: [] });
  });

  it('derives a hub when the workspace has no core row', () => {
    const { nodes } = deriveMasters([node()], [], TABS, 'Company Brain');
    const hub = nodes.find((n) => n.id === WORKSPACE_HUB_ID);
    expect(hub).toMatchObject({ category: 'core', title: 'Company Brain', sourceRef: null, tier: 1 });
    expect(hub?.kind).toBeUndefined();
  });

  it('reuses the synced workspace hub row as the hub', () => {
    const core = node({ id: '387936b6-core', category: 'core', origin: 'supabase', x: 500, y: 600 });
    const { nodes, edges } = deriveMasters([core, node()], [], TABS, 'Company Brain');
    expect(nodes.some((n) => n.id === WORKSPACE_HUB_ID)).toBe(false);
    expect(core.tier).toBe(1);
    expect(edges).toContainEqual({ from: 'tab-devices', to: '387936b6-core', strength: 0.9 });
    expect(edges.some((e) => e.to === WORKSPACE_HUB_ID)).toBe(false);
  });

  it('derives the hub when the only "core" rows are device groups or distilled memories', () => {
    const group = node({ id: 'g1', category: 'core', origin: 'supabase', sourceRef: { table: 'device_groups', id: 'x' } });
    const memory = node({ id: 'sos-blink-core--0eae', category: 'core', origin: 'agent' });
    const { nodes, edges } = deriveMasters([group, memory], [], TABS, 'Company Brain');
    expect(nodes.some((n) => n.id === WORKSPACE_HUB_ID)).toBe(true);
    expect(edges).toContainEqual({ from: 'tab-dev', to: WORKSPACE_HUB_ID, strength: 0.9 });
    expect(group.tier).toBe(5);
  });

  it('builds one master per tab and per catalog tool, each linked to its tier parent', () => {
    // RULE: a Store app is a hub child; Device groups hangs off Devices; a tool
    // hangs off its app.
    const { nodes, edges } = deriveMasters([node()], [], TABS, 'Company Brain');
    const tabs = nodes.filter((n) => (n.sourceRef as { kind?: string })?.kind === 'tab');
    const tools = nodes.filter((n) => (n.sourceRef as { kind?: string })?.kind === 'tool');
    expect(tabs.map((n) => [n.id, n.tier])).toEqual([['tab-devices', 2], ['tab-dev', 2], ['tab-groups', 3]]);
    expect(tools).toHaveLength(BRAIN_TOOL_CATALOG.length);
    expect(tools.every((n) => n.tier === 3)).toBe(true);
    const parents = edges.filter((e) => e.strength === 0.9);
    expect(parents).toContainEqual({ from: 'tab-devices', to: WORKSPACE_HUB_ID, strength: 0.9 });
    expect(parents).toContainEqual({ from: 'tab-groups', to: 'tab-devices', strength: 0.9 });
    expect(parents).toContainEqual({ from: 'tool-github', to: 'tab-dev', strength: 0.9 });
    expect(parents).toHaveLength(tabs.length + tools.length);
  });

  it('re-asserts the parent edge of a master a sync already persisted', () => {
    // The stored edge can be gone (hub deleted, older sync anchored everything
    // on the hub), so the derive must emit it even when it derives no node.
    const core = node({ id: '387936b6-core', category: 'core', origin: 'supabase' });
    const synced = node({ id: '387936b6-tab-groups', category: 'core', origin: 'supabase', sourceRef: { kind: 'tab', tab: 'groups' } });
    const { nodes, edges } = deriveMasters([core, synced], [], TABS, 'Company Brain');
    expect(nodes.some((n) => (n.sourceRef as { tab?: string })?.tab === 'groups')).toBe(false);
    expect(synced.tier).toBe(3);
    expect(edges).toContainEqual({ from: '387936b6-tab-groups', to: 'tab-devices', strength: 0.9 });
  });

  it('leaves every master — derived or persisted — one hop from its app', () => {
    const core = node({ id: '387936b6-core', category: 'core', origin: 'supabase' });
    const synced = node({ id: '387936b6-tool-github', category: 'core', origin: 'supabase', sourceRef: { kind: 'tool', tool: 'github' } });
    const { nodes, edges } = deriveMasters([core, synced], [], TABS, 'Company Brain');
    const all = [core, synced, ...nodes];
    const hubId = findHubId(all);
    const tabId = (tab: string) => all.find((n) => sameSourceRef({ kind: 'tab', tab }, n.sourceRef))!.id;
    const masters = all.filter((n) => ['tab', 'tool'].includes((n.sourceRef as { kind?: string })?.kind ?? ''));
    expect(masters).toHaveLength(TABS.length + BRAIN_TOOL_CATALOG.length);
    for (const m of masters) {
      const ref = m.sourceRef as { kind: string; tab?: string; tool?: string };
      const app = ref.kind === 'tab' ? TABS.find((t) => t.id === ref.tab)!.app : appOf(ref.tool!);
      const to = ref.kind === 'tab' && ref.tab === app ? hubId : TABS.some((t) => t.id === app) ? tabId(app) : hubId;
      expect(edges, m.id).toContainEqual({ from: m.id, to, strength: 0.9 });
    }
    expect(edges).toContainEqual({ from: '387936b6-tool-github', to: 'tab-dev', strength: 0.9 });
  });

  it('tiers a memory on its STORED degree and links tier 4/5 rows to the nearest node one tier up', () => {
    const hubEdge = (from: string) => ({ from, to: 'core', strength: 0.5 });
    const core = node({ id: 'core', category: 'core', origin: 'supabase', x: 0, y: 0 });
    // `central` has P4_MIN_DEGREE stored edges (to plain peers) → tier 4, and
    // none to a higher tier → it gets linked to the nearest tier-3 master.
    const central = node({ id: 'central', x: 1000, y: 1000 });
    const peers = Array.from({ length: P4_MIN_DEGREE }, (_, i) => node({ id: `p${i}`, x: 1000 + i, y: 990 }));
    // `near` sits next to `central` with no stored edge → tier 5, parent = central.
    const near = node({ id: 'near', x: 1010, y: 1010 });
    // `anchored` already reaches the hub → tier 5, no derived edge.
    const anchored = node({ id: 'anchored', x: 1020, y: 1020 });
    const stored = [...peers.map((p) => ({ from: p.id, to: 'central', strength: 0.5 })), hubEdge('anchored')];
    const { edges } = deriveMasters([core, central, ...peers, near, anchored], stored, TABS, 'x');
    expect(central.tier).toBe(4);
    expect(near.tier).toBe(5);
    expect(anchored.tier).toBe(5);
    expect(edges).toContainEqual({ from: 'near', to: 'central', strength: 0.6 });
    expect(edges.filter((e) => e.from === 'anchored')).toEqual([]);
    const up = edges.find((e) => e.from === 'central');
    expect(up?.strength).toBe(0.6);
    expect(up && tierOf({ id: up.to, sourceRef: { kind: up.to.startsWith('tab-') ? 'tab' : 'tool', tab: up.to.slice(4), tool: up.to.slice(5) } }, 'core')).toBe(3);
    // Peers are tier 5 linked to a tier-4 row already — nothing derived for them.
    for (const p of peers) expect(edges.filter((e) => e.from === p.id)).toEqual([]);
  });

  it('fans a derived tool master out beside its app, away from the hub', () => {
    const { nodes } = deriveMasters([node()], [], TABS, 'x');
    const at = (id: string) => nodes.find((n) => n.id === id)!;
    const hub = at(WORKSPACE_HUB_ID);
    const dev = at('tab-dev');
    const github = at('tool-github');
    const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    expect(d(github, dev)).toBeLessThan(d(github, hub));
    expect(d(github, hub)).toBeGreaterThan(d(dev, hub));
  });

  it('places masters deterministically across calls', () => {
    const pos = (r: ReturnType<typeof deriveMasters>) => r.nodes.map((n) => [n.id, n.x, n.y]);
    const edges = (r: ReturnType<typeof deriveMasters>) => r.edges;
    const a = deriveMasters([node(), node({ id: 'm2', x: 900, y: 900 })], [], TABS, 'x');
    const b = deriveMasters([node(), node({ id: 'm2', x: 900, y: 900 })], [], TABS, 'x');
    expect(pos(a)).toEqual(pos(b));
    expect(edges(a)).toEqual(edges(b));
  });
});

describe('tierOf', () => {
  const ref = (sourceRef: unknown, over: Partial<AdminBrainNode> = {}) => node({ id: 'n', sourceRef, ...over });
  it('ranks hub / app / other master / central / plain', () => {
    expect(tierOf(node({ id: 'hub' }), 'hub')).toBe(1);
    expect(tierOf(ref({ kind: 'tab', tab: 'devices' }), 'hub')).toBe(2);
    expect(tierOf(ref({ kind: 'tab', tab: 'groups' }), 'hub')).toBe(3);
    expect(tierOf(ref({ kind: 'tool', tool: 'github' }), 'hub')).toBe(3);
    expect(tierOf(ref(null, { kind: 'portal', employeeId: 'e1' }), 'hub')).toBe(3);
    expect(tierOf(ref(null), 'hub', P4_MIN_DEGREE)).toBe(4);
    expect(tierOf(ref(null), 'hub', P4_MIN_DEGREE - 1)).toBe(5);
    expect(tierOf(ref(null, { relatedIds: ['a', 'b', 'c', 'd'] }), 'hub')).toBe(4);
  });
});

describe('findHubId', () => {
  const deviceGroup = node({ id: 'g1', category: 'core', origin: 'supabase', sourceRef: { table: 'device_groups', id: 'x' } });
  const tabMaster = node({ id: 'tab-groups', category: 'core', origin: 'supabase', sourceRef: { kind: 'tab', tab: 'groups' }, relatedIds: ['a', 'b', 'c'] });
  const distilled = node({ id: 'sos-blink-core--0eae', category: 'core', origin: 'agent', relatedIds: ['a', 'b'] });
  const synced = node({ id: '387936b6-core', category: 'core', origin: 'supabase' });
  const seeded = node({ id: 'brain-hub', category: 'core', origin: 'seed' });

  it('never crowns a device group, a master or a distilled memory', () => {
    expect(findHubId([deviceGroup, tabMaster, distilled])).toBeNull();
    expect(findHubId([tabMaster])).toBeNull();
  });

  it('admin-core and the derived workspace hub beat every other row', () => {
    const adminCore = node({ id: ADMIN_CORE_NODE_ID, category: 'core', origin: 'seed' });
    expect(findHubId([synced, seeded, adminCore])).toBe(ADMIN_CORE_NODE_ID);
    expect(findHubId([synced, node({ id: WORKSPACE_HUB_ID, category: 'core', origin: 'seed' })])).toBe(WORKSPACE_HUB_ID);
  });

  it('the synced workspace hub beats a seeded one, which beats nothing else', () => {
    expect(findHubId([distilled, deviceGroup, seeded, synced])).toBe('387936b6-core');
    expect(findHubId([distilled, deviceGroup, seeded])).toBe('brain-hub');
  });

  it('breaks ties inside a tier by connectivity, then id — independent of row order', () => {
    const a = node({ id: 'z-core', category: 'core', origin: 'supabase', relatedIds: ['x'] });
    const b = node({ id: 'a-core', category: 'core', origin: 'supabase' });
    expect(findHubId([b, a])).toBe('z-core');
    expect(findHubId([a, b])).toBe('z-core');
    expect(findHubId([node({ id: 'b-core', category: 'core', origin: 'supabase' }), b])).toBe('a-core');
  });
});

// The real graph's upgrade offer: what folds into the hub until it is hovered.
describe('upgradeIds', () => {
  const hub = node({ id: WORKSPACE_HUB_ID, category: 'core', origin: 'seed' });
  const dev = node({ id: 'tab-dev', sourceRef: { kind: 'tab', tab: 'dev' } });
  const devices = node({ id: 'tab-devices', sourceRef: { kind: 'tab', tab: 'devices' } });
  const github = node({ id: 'tool-github', sourceRef: { kind: 'tool', tool: 'github' } });
  const posthog = node({ id: 'tool-posthog', sourceRef: { kind: 'tool', tool: 'posthog' } });
  const memory = node({ id: 'm-groups' });
  const nodes = [hub, dev, devices, github, posthog, memory];
  const edges = [
    { from: 'tab-dev', to: WORKSPACE_HUB_ID },
    { from: 'tab-devices', to: WORKSPACE_HUB_ID },
    { from: 'tool-github', to: 'tab-dev' },
    { from: 'tool-posthog', to: 'tab-dev' },
    { from: 'm-groups', to: 'tab-devices' },
  ];
  const seed = (tab: string, over: Partial<{ activated: boolean; connected: boolean }> = {}) => ({
    sourceRef: { kind: 'tab' as const, tab },
    activated: false,
    connected: false,
    ...over,
  });

  it('folds an unused app with the masters that hang only off it', () => {
    expect([...upgradeIds(nodes, edges, [seed('dev'), seed('devices', { activated: true })], WORKSPACE_HUB_ID)].sort())
      .toEqual(['tab-dev', 'tool-github', 'tool-posthog']);
  });

  it('an activated or connected app stays out', () => {
    expect(upgradeIds(nodes, edges, [seed('dev', { activated: true })], WORKSPACE_HUB_ID).size).toBe(0);
    expect(upgradeIds(nodes, edges, [seed('dev', { connected: true })], WORKSPACE_HUB_ID).size).toBe(0);
  });

  it('an app with a real memory under it is in use, whatever the flags say', () => {
    expect(upgradeIds(nodes, edges, [seed('devices')], WORKSPACE_HUB_ID).size).toBe(0);
    // …and a seed whose master is not on the graph is simply skipped.
    expect(upgradeIds(nodes, edges, [seed('other')], WORKSPACE_HUB_ID).size).toBe(0);
  });
});

// Fold anchors: who a node sits on when folded, and whose hover pops it.
describe('treeParents', () => {
  const tiers = new Map<string, 1 | 2 | 3 | 4 | 5>([
    [WORKSPACE_HUB_ID, 1], ['tab-devices', 2], ['tab-dev', 2], ['tab-groups', 3], ['tool-flash', 3], ['tool-github', 3], ['m1', 5], ['loner', 5],
  ]);
  const nodes = [...tiers.keys()].map((id) => ({ id }));
  const edges = [
    { from: 'tab-devices', to: WORKSPACE_HUB_ID },
    { from: 'tab-dev', to: WORKSPACE_HUB_ID },
    { from: 'tab-groups', to: 'tab-devices' },
    { from: 'tool-flash', to: 'tab-devices' },
    { from: 'tool-github', to: 'tab-dev' },
    { from: 'm1', to: 'tool-flash' },
    { from: 'm1', to: 'tab-groups' }, // two tier-3 neighbours: lowest id wins
    { from: 'm1', to: 'tab-devices' }, // …a higher tier does NOT steal it (nearest wins)
    { from: 'tab-groups', to: WORKSPACE_HUB_ID }, // stale sync shortcut: Groups stays on Devices
    { from: 'ghost', to: 'loner' }, // an edge to a node the graph does not know
  ];
  const parents = treeParents(nodes, edges, tiers, WORKSPACE_HUB_ID);

  it('is the nearest higher-tier neighbour, ties by id, the hub when nothing above is linked', () => {
    expect(parents.get('tool-github')).toBe('tab-dev');
    expect(parents.get('tab-groups')).toBe('tab-devices');
    expect(parents.get('tab-devices')).toBe(WORKSPACE_HUB_ID);
    expect(parents.get('m1')).toBe('tab-groups');
    expect(parents.get('loner')).toBe(WORKSPACE_HUB_ID);
    expect(parents.has(WORKSPACE_HUB_ID)).toBe(false);
  });

  it('breaks a same-tier tie on the lowest id', () => {
    const p = treeParents(nodes, edges.filter((e) => e.to !== 'tab-devices' || e.from !== 'm1'), tiers, WORKSPACE_HUB_ID);
    expect(p.get('m1')).toBe('tab-groups');
  });
});

describe('hover reveal: only the last parent keeps its folded children out', () => {
  const hub = WORKSPACE_HUB_ID;
  // Groups folded on Devices, GitHub folded on Dev; Other (an off app) folded on the hub.
  const parentOf = new Map([['tab-devices', hub], ['tab-dev', hub], ['tab-other', hub], ['tab-groups', 'tab-devices'], ['tool-github', 'tab-dev'], ['m1', 'tab-groups']]);
  const foldable = new Set(['tab-groups', 'tool-github', 'tab-other']);

  it('a parent with something folded under it takes over; a leaf changes nothing', () => {
    expect(revealTarget('tab-devices', foldable, parentOf, hub)).toBe(true);
    expect(revealTarget(hub, foldable, parentOf, hub)).toBe(true); // Other is folded on it
    expect(revealTarget('tab-groups', foldable, parentOf, hub)).toBe(true); // the folded child itself
    expect(revealTarget('m1', foldable, parentOf, hub)).toBe(false);
    expect(revealTarget(hub, new Set(['tab-groups']), parentOf, hub)).toBe(false); // nothing folded on the hub
  });

  it('hover Devices → Groups out; hover the hub next → Groups folds (Devices no longer revealed)', () => {
    expect([...revealChain(['tab-devices'], foldable, parentOf, hub)]).toEqual(['tab-devices']);
    expect([...revealChain([hub], foldable, parentOf, hub)]).toEqual([hub]);
  });

  it('a popped child keeps its folded ancestors revealed so it stays drawn under the pointer', () => {
    expect([...revealChain(['tool-github'], foldable, parentOf, hub)]).toEqual(['tool-github', 'tab-dev']);
    // …but stops at the first drawn ancestor: Devices revealed ≠ the hub's other apps popped.
    expect([...revealChain(['tab-groups'], foldable, parentOf, hub)]).toEqual(['tab-groups', 'tab-devices']);
    // The selected node's chain rides along while its panel is open.
    expect([...revealChain([hub, 'tab-groups'], foldable, parentOf, hub)].sort()).toEqual([hub, 'tab-devices', 'tab-groups'].sort());
  });
});
