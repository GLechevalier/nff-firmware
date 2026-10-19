import { useCallback, useEffect, useRef } from 'react';
import { useCurrentProject } from '../context/CurrentProjectContext';
import { useDevices } from '../add-ons/observability/hooks/useDevices';

/**
 * Keep a demo project's live mock fleet available for as long as the user is looking at it.
 *
 * A brand-new user's `is_demo` "Welcome to nff" project ships empty (migration 0036 removed the
 * old fake static seed — devices are now real spawned nff-mock containers). This hook makes the
 * ~10-device fleet both APPEAR and STAY:
 *
 *  1. **Presence keep-alive (the fix).** Every mock is spawned with a hard TTL; the controller's
 *     reaper tears one down once it expires. On its own that means a user sitting in the app
 *     watches their Level-1 mocks vanish ~30 min in. So while this tab is open + visible we ping
 *     `POST /api/demo/presence` on an interval, which tells the controller "the user is online" —
 *     it then never TTL-reaps this project's L1 mocks. They drain only once we stop pinging (tab
 *     closed / navigated away). Level-2 (heavy QEMU) mocks are deliberately NOT presence-pinned:
 *     they are a scarce shared resource with their own idle lease, released when unused.
 *
 *  2. **Deficit top-up (backstop).** The first pass seeds the full target (8×L1 + 2×L2). After
 *     that the interval only refills the L1 deficit (`l1_only`) — presence already prevents L1
 *     TTL-reaps, so this just covers an L1 that genuinely died (crash / OOM). L2 is seeded once
 *     and left to its idle lease, so the interval never re-spawns it.
 *
 * Both endpoints are deficit-based / idempotent, so a tick that has nothing to do is a cheap
 * no-op. We hold off refiring while a request is in flight, and pause entirely when the tab is
 * hidden (no point keeping mocks alive for a backgrounded tab).
 */
const TARGET_TOTAL = 10;
const L1_TARGET = 8;
// How often we heartbeat presence + check the L1 deficit. Must stay below the controller's
// presence_ttl_s (150 s) with margin so a single slow tick never lets an L1 lapse.
const KEEPALIVE_INTERVAL_MS = 60_000;

export function useDemoFleetSeed() {
  const { currentProject } = useCurrentProject();
  const { devices, loading } = useDevices();

  // Latest values, read inside the interval without making it a dependency (so the timer isn't
  // torn down and recreated on every realtime device update). Synced in an effect — never write
  // a ref during render.
  const devicesRef = useRef(devices);
  const loadingRef = useRef(loading);
  useEffect(() => { devicesRef.current = devices; }, [devices]);
  useEffect(() => { loadingRef.current = loading; }, [loading]);

  // Whether we've done the one-time full seed (incl. L2) for the current project.
  const fullSeededRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  // One keep-alive tick: heartbeat presence, then top up any deficit. Stable across renders (it
  // reads the latest devices/loading through refs), re-created only when the project changes — so
  // the interval below never churns on device updates, yet the ready-trigger effect can call it.
  const tick = useCallback(async () => {
      if (!currentProject.is_demo) return;
      const projectId = currentProject.id;
      if (loadingRef.current) return;      // wait for the real device list before counting
      if (inFlightRef.current) return;     // don't stack requests
      if (typeof document !== 'undefined' && document.hidden) return; // paused when backgrounded

      inFlightRef.current = true;
      try {
        // Heartbeat first — this is what keeps existing L1 mocks alive. Best-effort.
        void fetch('/api/demo/presence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: projectId }),
        }).catch(() => { /* best-effort; next tick retries */ });

        // Count LIVE mocks only — stale offline rows from reaped containers must not block a
        // top-up. The first pass seeds the full target (L1+L2); later passes refill L1 only.
        const onlineMocks = devicesRef.current.filter(
          (d) => d.id.startsWith('mock-') && d.status === 'online',
        );
        const liveMocks = onlineMocks.length;
        // L2 (heavy QEMU) mocks carry device_type 'nff-qemu-esp32'; everything else is L1.
        const liveL1 = onlineMocks.filter((d) => d.deviceType !== 'nff-qemu-esp32').length;

        const firstFull = fullSeededRef.current !== projectId;
        const needsSeed = firstFull ? liveMocks < TARGET_TOTAL : liveL1 < L1_TARGET;
        if (needsSeed) {
          const resp = await fetch('/api/demo/seed-fleet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_id: projectId, ...(firstFull ? {} : { l1_only: true }) }),
          });
          const data = await resp.json().catch(() => ({}));
          if (resp.ok && data?.ok && firstFull) fullSeededRef.current = projectId;
        } else if (firstFull) {
          fullSeededRef.current = projectId; // already at target — full seed considered done
        }
      } finally {
        inFlightRef.current = false;
      }
    }, [currentProject.id, currentProject.is_demo]);

  // Seed the moment the device list is READY, not up to a full interval later. `tick` bails while
  // `useDevices` is still loading (it can't count the fleet yet); the interval effect below can't
  // depend on `loading` without tearing down its 60s timer on every heartbeat, so on its own the
  // first real seed waited for the first interval fire — up to KEEPALIVE_INTERVAL_MS, and never at
  // all if the tab reloaded/switched inside that window. That is why a fresh demo showed only the
  // self-heal L2s and none of the 8 L1s. This effect fires one tick on the loading→ready edge.
  useEffect(() => {
    if (loading) return;
    void tick();
  }, [loading, tick]);

  useEffect(() => {
    if (!currentProject.is_demo) return;
    void tick();                                  // fire immediately on mount / project switch
    const id = setInterval(() => void tick(), KEEPALIVE_INTERVAL_MS);
    // Re-tick as soon as a hidden tab comes back, so mocks don't lapse while backgrounded.
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // Re-arm only when the project identity changes, not on every device update.
  }, [currentProject.id, currentProject.is_demo, tick]);
}
