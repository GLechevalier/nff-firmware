// layoutTree is what Reorganize persists: a wrong parent puts a tool under the
// wrong app for good, a non-deterministic pass jitters every click.

import { describe, expect, it } from 'vitest';
import { layoutTree, treeParents, type TreeEdge, type TreeNode } from './brainTree';

const n = (id: string, over: Partial<TreeNode> = {}): TreeNode => ({ id, x: 0, y: 0, size: 16, ...over });
const e = (from: string, to: string, strength = 0.9): TreeEdge => ({ from, to, strength });
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

const hub = n('hub', { size: 32 });
const dev = n('tab-dev', { size: 32, sourceRef: { kind: 'tab', tab: 'dev' } });
const devices = n('tab-devices', { size: 32, sourceRef: { kind: 'tab', tab: 'devices' } });
const github = n('tool-github', { size: 32, sourceRef: { kind: 'tool', tool: 'github' } });
const groups = n('tab-groups', { size: 32, sourceRef: { kind: 'tab', tab: 'groups' } });
const central = n('central', { tier: 4 });
const leaf = n('leaf', { tier: 5 });
const orphan = n('orphan', { tier: 5 });
const nodes = [hub, dev, devices, github, groups, central, leaf, orphan];
const edges = [
  e('tab-dev', 'hub'), e('tab-devices', 'hub'), e('tool-github', 'tab-dev'), e('tab-groups', 'tab-devices'),
  e('central', 'tool-github', 0.6), e('leaf', 'central', 0.6),
  // Cross-links the tree must ignore: a leaf also touching a peer, a tool touching the other app weakly.
  e('leaf', 'orphan', 0.5), e('tool-github', 'tab-devices', 0.3),
];
const center = { x: 400, y: 300 };

describe('treeParents', () => {
  it('picks the lowest-tier neighbour, strongest edge on a tie, and the hub for an orphan', () => {
    const p = treeParents(nodes, edges, 'hub');
    expect(p.get('tab-dev')).toBe('hub');
    expect(p.get('tool-github')).toBe('tab-dev');
    expect(p.get('tab-groups')).toBe('tab-devices');
    expect(p.get('central')).toBe('tool-github');
    expect(p.get('leaf')).toBe('central');
    expect(p.get('orphan')).toBe('hub');
    expect(p.has('hub')).toBe(false);
  });

  it('prefers the strongest edge among same-tier candidates', () => {
    const p = treeParents([hub, dev, devices, github], [e('tool-github', 'tab-dev', 0.4), e('tool-github', 'tab-devices', 0.9)], 'hub');
    expect(p.get('tool-github')).toBe('tab-devices');
  });
});

describe('layoutTree', () => {
  const pos = layoutTree(nodes, edges, { hubId: 'hub', center });

  it('pins the hub at the centre and puts every child farther out than its parent', () => {
    expect(pos.hub).toEqual(center);
    const parents = treeParents(nodes, edges, 'hub');
    for (const [child, parent] of parents) expect(dist(pos[child], center), child).toBeGreaterThan(dist(pos[parent], center));
  });

  it('keeps a child near its own parent, not the other branch', () => {
    expect(dist(pos['tool-github'], pos['tab-dev'])).toBeLessThan(dist(pos['tool-github'], pos['tab-devices']));
    expect(dist(pos['tab-groups'], pos['tab-devices'])).toBeLessThan(dist(pos['tab-groups'], pos['tab-dev']));
    expect(dist(pos.leaf, pos.central)).toBeLessThan(dist(pos.leaf, pos['tab-devices']));
  });

  it('leaves no two squares overlapping', () => {
    const ids = Object.keys(pos);
    for (const a of ids) for (const b of ids) {
      if (a >= b) continue;
      const sa = nodes.find((x) => x.id === a)!.size;
      const sb = nodes.find((x) => x.id === b)!.size;
      expect(dist(pos[a], pos[b]), `${a}~${b}`).toBeGreaterThan((sa + sb) / 2);
    }
  });

  it('is deterministic and leaves an unknown hub alone', () => {
    expect(layoutTree(nodes, edges, { hubId: 'hub', center })).toEqual(pos);
    const same = layoutTree([leaf, orphan], [], { hubId: 'missing', center });
    expect(same).toEqual({ leaf: { x: 0, y: 0 }, orphan: { x: 0, y: 0 } });
  });
});
