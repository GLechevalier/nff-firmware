// The demo brain is rebuilt on every 15 s poll through the real
// deriveMasters/linkEdges path: a dangling edge silently vanishes, a duplicate
// id collides in the renderer, and a hub-looking row would steal the centre.

import { describe, expect, it } from 'vitest';
import { CATEGORIES } from '@nff-brain/core/types';
import { DEMO_BRAIN_EDGES, DEMO_BRAIN_NODES, DEMO_MASTER_IDS } from './demoBrain';
import { deriveMasters, WORKSPACE_HUB_ID } from '../core/overview/lib/brainMasters';
import { linkEdges } from '../core/overview/lib/brainOverlay';
import { BRAIN_TABS } from '../nav';

describe('demoBrain', () => {
  it('is a well-formed graph the hub derivation does not mistake for a hub', () => {
    const ids = new Set(DEMO_BRAIN_NODES.map((n) => n.id));
    expect(ids.size).toBe(DEMO_BRAIN_NODES.length);
    for (const n of DEMO_BRAIN_NODES) expect(CATEGORIES).toContain(n.category);

    const own = DEMO_BRAIN_NODES.map((n) => ({ ...n, relatedIds: [] as string[] }));
    const masters = deriveMasters(own, DEMO_BRAIN_EDGES, BRAIN_TABS, 'Company Brain');
    const masterIds = new Set(masters.nodes.map((n) => n.id));
    expect(masterIds.has(WORKSPACE_HUB_ID)).toBe(true);
    for (const id of DEMO_MASTER_IDS) expect(masterIds.has(id), id).toBe(true);

    // Every edge endpoint is a fixture node or a derived master — nothing dangles.
    const all = new Set([...ids, ...masterIds]);
    for (const e of DEMO_BRAIN_EDGES) {
      expect(all.has(e.from), e.from).toBe(true);
      expect(all.has(e.to), e.to).toBe(true);
    }

    const nodes = own.concat(masters.nodes);
    const edges = linkEdges(nodes, DEMO_BRAIN_EDGES.concat(masters.edges));
    expect(edges.length).toBe(DEMO_BRAIN_EDGES.length + masters.edges.length);
    // No orphan: every fixture node reaches something.
    for (const n of own) expect(n.relatedIds.length, n.id).toBeGreaterThan(0);
  });
});
