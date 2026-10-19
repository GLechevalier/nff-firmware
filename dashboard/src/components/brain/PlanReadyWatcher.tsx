import { useEffect, useRef } from 'react';
import type { BuilderFeature, FeatureStatus } from '../../types/builderFeature';
import type { TabId } from '../squeletton/TabBar';

// Headless "a plan is waiting for your approval" watcher — the any-origin sibling of
// DemoBuildWatcher. Whatever kicked the plan off (typed chat, CLI/bench), the moment
// a feature row reaches 'planned' the user should hear about it: BuilderTab
// shows its Approve button exactly at that status, and nothing proceeds until they click
// it. DB-driven off the builder_features realtime feed (useBuilderFeatures in App), so no
// per-origin wiring — onPlanReady raises App's gentle "Open the Builder tab →" toast.
interface Props {
  features: BuilderFeature[];
  // The autonomous build demo's session: its feature is suppressed here because the demo
  // narrates its own beats (buildStory / DemoBuildWatcher). Null when no demo is running.
  suppressSessionId: string | null;
  // No toast while the user is already looking at the Builder tab.
  activeTab: TabId;
  onPlanReady: () => void;
}

export function PlanReadyWatcher({ features, suppressSessionId, activeTab, onPlanReady }: Props) {
  // Last seen status per feature id — 'planned' must be an EDGE (new row at planned, or a
  // transition into it), never a level, so an already-planned backlog doesn't re-toast.
  const prevRef = useRef<Map<string, FeatureStatus> | null>(null);
  const notifiedRef = useRef(new Set<string>());

  useEffect(() => {
    // First snapshot with data is the baseline: record statuses, fire nothing. A reload
    // with old 'planned' rows stays silent; only plans landing after that can toast.
    if (prevRef.current === null) {
      if (features.length === 0) return;
      prevRef.current = new Map(features.map(f => [f.id, f.status]));
      return;
    }
    const prev = prevRef.current;
    let ready = false;
    for (const f of features) {
      const before = prev.get(f.id);
      prev.set(f.id, f.status);
      if (f.status !== 'planned' || before === 'planned') continue;
      if (notifiedRef.current.has(f.id)) continue;
      if (suppressSessionId && f.sessionId === suppressSessionId) continue;
      notifiedRef.current.add(f.id);
      ready = true;
    }
    // Already on the Builder tab → the plan is on screen; skip the toast but keep the
    // feature marked notified so tabbing away later doesn't retro-toast it.
    if (ready && activeTab !== 'builder') onPlanReady();
  }, [features, suppressSessionId, activeTab, onPlanReady]);

  return null;
}
