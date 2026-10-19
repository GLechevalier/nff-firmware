// "Blinking nodes" for the brain graph — a node flares and breathes for a
// while after the admin worker recalls it (notably right after a ChatDock
// prompt), matching nff-brain's VS Code webview.
//
// The webview drives this off a tailed activity.jsonl the extension host
// reads live; the browser has no such feed. This is the OTHER half it also
// has — a fallback that seeds heat straight from each node's own
// last_recalled_at column (see useActivityGlow.ts's "panel opens late"
// effect) — which is all a 15s poll can offer anyway. The decay/recompute
// math itself (recomputeGlow) now lives in @nff-brain/core so both frontends
// share it instead of each re-implementing the loop.

import { useCallback, useEffect, useRef, useState } from 'react';
import { recomputeGlow, type GlowInfo as CoreGlowInfo, type Heat } from '@nff-brain/core/activity';
import { BRAIN_SYNCED_EVENT, type BrainSyncedDetail } from '../../lib/adminChat';

const TICK_MS = 10_000;
// No event kind to key off (recall vs. distill vs. search) without the log —
// 0.7 matches the webview's own "recall" fallback intensity.
const FALLBACK_BASE = 0.7;
// "An agent is pulling me right now": the square blinks ink/paper for this
// long after the browser LEARNS of a touch (poll or sync event) — clocked
// locally, not off the server's last_recalled_at, so poll lag and clock skew
// can't eat the window. ponytail: vendored core 0.1.2 predates
// GlowInfo.active / GLOW_ACTIVE_MS; fold into recomputeGlow once 0.1.3 lands.
const ACTIVE_MS = 20_000;
export type GlowInfo = CoreGlowInfo & { active?: boolean }; // optional: BrainCard's seedGlow builds core GlowInfo literals

export function useBrainGlow(
  nodes: ReadonlyArray<{ id: string; lastRecalledAt?: string }>,
): ReadonlyMap<string, GlowInfo> {
  const heatRef = useRef<Map<string, Heat>>(new Map());
  const seenRef = useRef<Map<string, number>>(new Map()); // id → when this UI learned of the touch
  const [glow, setGlow] = useState<ReadonlyMap<string, GlowInfo>>(new Map());

  const recompute = useCallback(() => {
    const now = Date.now();
    const next = new Map<string, GlowInfo>();
    for (const [id, g] of recomputeGlow(heatRef.current, now)) {
      next.set(id, { ...g, active: now - (seenRef.current.get(id) ?? 0) < ACTIVE_MS });
    }
    for (const id of seenRef.current.keys()) if (!heatRef.current.has(id)) seenRef.current.delete(id);
    // Idle graph (nothing hot): keep the previous empty Map so React bails out
    // and the 10s tick doesn't re-render BrainCard → BrainGraph for nothing.
    setGlow(prev => (prev.size === 0 && next.size === 0 ? prev : next));
  }, []);

  useEffect(() => {
    const heat = heatRef.current;
    let changed = false;
    for (const n of nodes) {
      if (!n.lastRecalledAt) continue;
      const at = Date.parse(n.lastRecalledAt);
      if (!Number.isFinite(at)) continue;
      const prev = heat.get(n.id);
      if (prev && prev.at >= at) continue; // newest touch wins
      heat.set(n.id, { at, base: FALLBACK_BASE, delayMs: 0 });
      seenRef.current.set(n.id, Date.now());
      changed = true;
    }
    if (changed) recompute();
  }, [nodes, recompute]);

  // A sync just landed: flare the nodes it added — "watch it grow" is the whole point.
  useEffect(() => {
    const onSynced = (e: Event) => {
      const ids = (e as CustomEvent<BrainSyncedDetail>).detail?.addedIds ?? [];
      if (ids.length === 0) return;
      const at = Date.now();
      for (const id of ids) {
        heatRef.current.set(id, { at, base: 1, delayMs: 0 });
        seenRef.current.set(id, at);
      }
      recompute();
    };
    window.addEventListener(BRAIN_SYNCED_EVENT, onSynced);
    return () => window.removeEventListener(BRAIN_SYNCED_EVENT, onSynced);
  }, [recompute]);

  useEffect(() => {
    recompute(); // immediate — don't wait a full tick to show what's already hot
    const timer = window.setInterval(recompute, TICK_MS);
    return () => window.clearInterval(timer);
  }, [recompute]);

  return glow;
}
