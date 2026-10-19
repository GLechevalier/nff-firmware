// offNodeIds decides which graph nodes fade with a switched-off tab/tool: get
// it wrong and a whole live branch greys out, or an uninstalled tab's rows keep
// glowing. Pure, so this pins the reachability rule down.

import { describe, expect, it } from 'vitest';
import { offNodeIds } from './offNodes';

const ids = (...xs: string[]) => xs.map((id) => ({ id }));
const e = (from: string, to: string) => ({ from, to });
const HUB = 'admin-core';
const sorted = (s: Set<string>) => [...s].sort();

describe('offNodeIds', () => {
  it('dims a switched-off tab and everything hanging only off it', () => {
    const nodes = ids(HUB, 'tab-devices', 'tab-dev', 'groups', 'device-1', 'group-1');
    const edges = [
      e('tab-devices', HUB),
      e('tab-dev', HUB),
      e('groups', 'tab-devices'),
      e('device-1', 'groups'),
      e('device-1', 'group-1'),
    ];
    const off = offNodeIds(nodes, edges, new Set(['tab-devices']), new Set([HUB, 'tab-dev']));
    expect(sorted(off)).toEqual(['device-1', 'group-1', 'groups', 'tab-devices']);
  });

  it('keeps a branch lit when any of it has another path to a live anchor', () => {
    const nodes = ids(HUB, 'tab-devices', 'groups', 'device-1', 'worker-note');
    const edges = [
      e('tab-devices', HUB),
      e('groups', 'tab-devices'),
      e('device-1', 'groups'),
      e('worker-note', 'device-1'),
      e('worker-note', HUB),
    ];
    const off = offNodeIds(nodes, edges, new Set(['tab-devices']), new Set([HUB]));
    expect(sorted(off)).toEqual(['tab-devices']);
  });

  it('dims a childless tool alone and leaves isolated nodes untouched', () => {
    const nodes = ids(HUB, 'tool-github', 'lonely');
    const off = offNodeIds(nodes, [e('tool-github', HUB)], new Set(['tool-github']), new Set([HUB]));
    expect(sorted(off)).toEqual(['tool-github']);
  });

  it('is direction-agnostic and handles a child shared by two off masters', () => {
    const nodes = ids(HUB, 'tool-posthog', 'tool-vercel', 'shared');
    const edges = [e(HUB, 'tool-posthog'), e('tool-vercel', HUB), e('shared', 'tool-posthog'), e('tool-vercel', 'shared')];
    const off = offNodeIds(nodes, edges, new Set(['tool-posthog', 'tool-vercel']), new Set([HUB]));
    expect(sorted(off)).toEqual(['shared', 'tool-posthog', 'tool-vercel']);
  });

  it('returns nothing when no master is off', () => {
    const off = offNodeIds(ids(HUB, 'tab-devices'), [e('tab-devices', HUB)], new Set(), new Set([HUB, 'tab-devices']));
    expect(off.size).toBe(0);
  });
});
