import { useEffect, useMemo, useRef } from 'react';
import { apiPost } from '../core/lib/api';
import { BRAIN_SYNCED_EVENT, type BrainSyncedDetail } from '../core/lib/adminChat';
import { useCurrentProject } from '../context/CurrentProjectContext';
import { ONBOARDING_MODE } from '../lib/onboardingMode';

/**
 * ONE answer to "which sources feed this workspace's brain?" — read by the rail
 * (lenses unlock on connection), the tour gates, the Sources tab's Devices card
 * and the auto-sync below. GitHub and devices come from the hooks App already
 * runs (passed in, so their realtime subscriptions aren't duplicated). The
 * per-user connectors live in nff-admin since Oct 2026.
 */
export type SourceKey = 'github' | 'devices';
export type SourceStatus = Record<SourceKey, boolean> & {
  /** Every first fetch has settled — until then the lenses keep their old visibility. */
  ready: boolean;
  connectedCount: number;
  deviceCount: number;
};

const KEYS: SourceKey[] = ['github', 'devices'];
const BASELINE_KEY = (projectId: string) => `nff.sources.${projectId}`;

export function useSourceStatus(input: { deviceCount: number; devicesReady: boolean; github: boolean }): SourceStatus {
  const { currentProject } = useCurrentProject();
  const projectId = currentProject.id;
  const status = useMemo<SourceStatus>(() => {
    // Local onboarding mode: report a workspace with nothing connected, so the
    // lenses close and every source gate in the tour starts unsatisfied. `ready`
    // stays real — the lenses only engage once the first status has settled.
    const s = ONBOARDING_MODE
      ? { github: false, devices: false }
      : { github: input.github, devices: input.deviceCount > 0 };
    return {
      ...s,
      ready: input.devicesReady,
      connectedCount: KEYS.filter((k) => s[k]).length,
      deviceCount: ONBOARDING_MODE ? 0 : input.deviceCount,
    };
  }, [input.github, input.deviceCount, input.devicesReady]);

  // Auto-sync: the moment a source flips off→on, mirror it into the brain and
  // announce the result (the graph refetches + glows the new nodes). The
  // baseline lives in sessionStorage so a fresh page load whose first snapshot is
  // already "on" is not read as a flip.
  const syncing = useRef(false);
  useEffect(() => {
    if (!status.ready) return;
    // Onboarding mode fakes every source off; syncing on that would be a lie, and
    // skipping the baseline write means leaving the mode isn't seen as an off→on flip.
    if (ONBOARDING_MODE) return;
    const key = BASELINE_KEY(projectId);
    let prev: Partial<Record<SourceKey, boolean>> | null = null;
    try { prev = JSON.parse(sessionStorage.getItem(key) ?? 'null'); } catch { /* fresh baseline */ }
    const snapshot = Object.fromEntries(KEYS.map((k) => [k, status[k]]));
    try { sessionStorage.setItem(key, JSON.stringify(snapshot)); } catch { /* quota — sync still runs */ }
    if (!prev || syncing.current) return;
    if (!KEYS.some((k) => !prev![k] && status[k])) return;
    syncing.current = true;
    void apiPost<BrainSyncedDetail>('/api/tables/brain/sync', {})
      .then((r) => window.dispatchEvent(new CustomEvent<BrainSyncedDetail>(BRAIN_SYNCED_EVENT, { detail: r })))
      .catch(() => { /* the rail's Sync database button is the manual retry */ })
      .finally(() => { syncing.current = false; });
  }, [status, projectId]);

  return status;
}
