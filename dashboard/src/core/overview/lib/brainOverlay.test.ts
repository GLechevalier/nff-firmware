// deriveOverlay is the whole user→company sync, seen from the company side:
// which teammate nodes appear in this workspace's graph, under whose name.
// Getting it wrong is either a privacy leak or an invisible contribution, so
// it is a pure function and this pins it down.

import { describe, expect, it } from 'vitest';
import { deriveOverlay, linkEdges } from './brainOverlay';
import type { AdminBrainNode } from '../hooks/useBrainGraph';

const MY_HOME = 'my-home-project';
const ALICE = 'alice-home-project';
const BOB = 'bob-home-project';

const companyNode = (over: Partial<AdminBrainNode> = {}): AdminBrainNode => ({
  id: 'c1',
  title: 'Company hub',
  category: 'core',
  color: '#00ffcc',
  x: 400,
  y: 300,
  size: 24,
  lastUpdated: '2026-01-01T00:00:00.000Z',
  content: '',
  origin: 'agent',
  recallCount: 0,
  relatedIds: [],
  sourceRef: null,
  ...over,
});

const sharedRow = (id: string, projectId: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id,
  category: 'strategy',
  color: '#a78bfa',
  x: 0,
  y: 0,
  size: 16,
  last_updated: '2026-01-01T00:00:00.000Z',
  content: '',
  origin: 'import',
  recall_count: 0,
  last_recalled_at: null,
  source_ref: null,
  shared: true,
  project_id: projectId,
  ...over,
});

const contributor = (homeProjectId: string, label: string, nodeCount = 1) => ({
  home_project_id: homeProjectId,
  label,
  node_count: nodeCount,
  last_synced_at: '2026-01-02T00:00:00.000Z',
});

describe('deriveOverlay', () => {
  it('is empty when nobody else contributes', () => {
    const r = deriveOverlay([companyNode()], [], [], MY_HOME);
    expect(r.nodes).toEqual([]);
    expect(r.edges).toEqual([]);
  });

  it('excludes the caller — their own shared nodes belong under "my brain"', () => {
    // company_brain_shared_nodes returns the CALLER's shared rows too, because
    // they are a member of the target project. Showing them as a teammate
    // portal would be nonsense.
    const r = deriveOverlay(
      [companyNode()],
      [sharedRow('mine-1', MY_HOME)],
      [contributor(MY_HOME, 'me')],
      MY_HOME,
    );
    expect(r.nodes).toEqual([]);
  });

  it('builds a hub, a portal per teammate, and rings their shared nodes', () => {
    const r = deriveOverlay(
      [companyNode()],
      [sharedRow('a1', ALICE), sharedRow('a2', ALICE), sharedRow('b1', BOB)],
      [contributor(ALICE, 'alice', 2), contributor(BOB, 'bob', 1)],
      MY_HOME,
    );
    const hub = r.nodes.find((n) => n.kind === 'hub');
    const portals = r.nodes.filter((n) => n.kind === 'portal');
    expect(hub).toBeDefined();
    expect(portals.map((p) => p.title).sort()).toEqual(['alice', 'bob']);
    // Each portal drills into its own contributor.
    expect(portals.find((p) => p.title === 'alice')?.employeeId).toBe(ALICE);
    // Shared nodes are attributed and attached to the right portal.
    const a1 = r.nodes.find((n) => n.id === 'a1');
    expect(a1?.employeeId).toBe(ALICE);
    expect(r.edges).toContainEqual({ from: `brain-portal-${ALICE}`, to: 'a1', strength: 0.6 });
    expect(r.edges).toContainEqual({ from: `brain-portal-${BOB}`, to: 'b1', strength: 0.6 });
    // and never to the wrong one
    expect(r.edges).not.toContainEqual({ from: `brain-portal-${BOB}`, to: 'a1', strength: 0.6 });
  });

  it('never emits a second core node — the renderer pins layout on the only one', () => {
    const r = deriveOverlay(
      [companyNode()],
      [sharedRow('a1', ALICE, { category: 'core' })],
      [contributor(ALICE, 'alice')],
      MY_HOME,
    );
    expect(r.nodes.every((n) => n.category !== 'core')).toBe(true);
  });

  it('anchors the hub to the company core and links them', () => {
    const core = companyNode({ id: 'hub', x: 100, y: 50 });
    const r = deriveOverlay([core], [sharedRow('a1', ALICE)], [contributor(ALICE, 'alice')], MY_HOME);
    const hub = r.nodes.find((n) => n.kind === 'hub')!;
    expect(hub.x).toBe(480); // 100 + 380
    expect(hub.y).toBe(50);
    expect(r.edges).toContainEqual({ from: 'hub', to: hub.id, strength: 0.9 });
  });

  it('still renders with no company core (a brand-new workspace)', () => {
    const r = deriveOverlay([], [sharedRow('a1', ALICE)], [contributor(ALICE, 'alice')], MY_HOME);
    expect(r.nodes.find((n) => n.kind === 'hub')).toBeDefined();
    // nothing to anchor to, so no anchor edge — and no crash
    expect(r.edges.some((e) => e.to === 'teammates-hub')).toBe(false);
  });

  it('ignores shared rows belonging to nobody in the contributor list', () => {
    // A row whose project has no live sync token can't be attributed, so it
    // must not be drawn rather than being hung off an arbitrary portal.
    const r = deriveOverlay(
      [companyNode()],
      [sharedRow('ghost', 'unknown-project'), sharedRow('a1', ALICE)],
      [contributor(ALICE, 'alice')],
      MY_HOME,
    );
    expect(r.nodes.some((n) => n.id === 'ghost')).toBe(false);
    expect(r.nodes.some((n) => n.id === 'a1')).toBe(true);
  });

  it('gives every derived node a stable, collision-free id', () => {
    const r = deriveOverlay(
      [companyNode()],
      [],
      [contributor(ALICE, 'alice'), contributor(BOB, 'bob')],
      MY_HOME,
    );
    const ids = r.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(`brain-portal-${ALICE}`);
  });
});

describe('linkEdges', () => {
  it('drops dangling edges and collapses a pair asserted twice, either way round', () => {
    const nodes = [companyNode({ id: 'hub' }), companyNode({ id: 'tab-devices' })];
    const kept = linkEdges(nodes, [
      { from: 'tab-devices', to: 'hub', strength: 0.9 },
      { from: 'hub', to: 'tab-devices', strength: 0.5 },
      { from: 'tab-devices', to: 'gone', strength: 0.9 },
    ]);
    expect(kept).toEqual([{ from: 'tab-devices', to: 'hub', strength: 0.9 }]);
    expect(nodes.map((n) => n.relatedIds)).toEqual([['tab-devices'], ['hub']]);
  });
});
