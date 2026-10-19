import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useCrashReports } from '../add-ons/observability/hooks/useCrashReports';
import { useDevices } from '../add-ons/observability/hooks/useDevices';
import { useOtaJobs } from '../add-ons/observability/hooks/useOtaJobs';
import type { Device, DeviceStatus } from '../types/device';

// The dot lifecycle the "break & self-heal" demo tells, overlaid on the authoritative
// device.status + live crash reports:
//   • 'breaking' (amber) — the instant you click break, while the crash is being injected and
//     the agent spins up. Nothing in the backend emits this state, so it lives here as a
//     client-only transient.
//   • 'error' (red)      — the device is "broken" and the agent is fixing it. Driven by
//     device.status==='error' (the L1 mock reports it while its fault is armed), a fresh
//     crash_reports row while offline, OR a "demo broken" marker (the instant-crash path:
//     the crash is INJECTED onto a device still running healthy firmware, so status stays
//     'online' and the marker is what holds the dot red until the agent's fix OTA lands).
//   • back to the raw status (green 'online', grey 'offline', …) once it heartbeats the fix.
//   • 'updating' (blue)  — a firmware update is shipping to the device right now: it has an
//     ota_jobs row in an in-flight state. Red wins over blue — a broken device stays red even
//     while its fix OTA ships, so "broken until honestly recovered" keeps telling the truth.
export type EffectiveStatus = DeviceStatus | 'breaking' | 'updating';

// Where a demo-broken device stands in its heal cycle. `demoBrokenActive` (the dot) only needs
// "is it still red", but the demo's narration needs to tell "the fix landed" apart from "the safety
// TTL gave up" — both of which clear the dot. Exposed via useDemoHealState so App can narrate only
// what it can actually observe, instead of celebrating on a timer.
//   • 'idle'      — no demo marker on this device.
//   • 'healing'   — broken; the fix hasn't been adopted yet (dot red).
//   • 'recovered' — the device runs firmware above the seeded version AND reads green for real.
//   • 'expired'   — the safety TTL elapsed without the fix ever landing. NOT a recovery.
export type DemoHealState = 'idle' | 'healing' | 'recovered' | 'expired';

// A fresh crash keeps a device red for this long even if its status momentarily reads
// 'offline' (the crash-loop reboot LWT) — so the dot doesn't flicker grey between reboots.
const CRASH_LINGER_MS = 120_000;
// Safety cap on the amber transient: if a broken device never produces a crash/error (e.g.
// the break was a no-op), fall the dot back to its real status after this.
const BREAKING_TIMEOUT_MS = 90_000;
// Safety cap on the "demo broken" red marker: the instant-crash demo holds the dot red until
// the device heartbeats a firmware version above the seeded one (the agent's real fix). A real
// L2 recompile+OTA takes ~15-18 min, so this cap is generous — it only clears a marker that
// was somehow never recovered (agent gave up, device stayed on old fw) so a dot can't stick red.
const DEMO_BROKEN_TTL_MS = 25 * 60_000;

// ota_jobs statuses that mean "an update is shipping to this device right now" — the dispatch
// onward (nff-ota's transitions.py). 'pending' is deliberately excluded: it means queued-not-
// dispatched, and a paused/scheduled deployment can sit there indefinitely. Nothing here needs
// a TTL — nff-ota's reaper times out stuck jobs and abort sweeps in-flight ones, and both land
// over the same realtime feed.
const OTA_IN_FLIGHT = new Set(['downloading', 'installing', 'rebooting', 'verifying']);

interface DemoBroken {
  since: number;   // epoch ms when the break fired
  fixAbove: string; // the seeded (buggy) semver — recovered once the device runs strictly above it
}

interface DeviceHealth {
  markBreaking: (deviceIds: string[]) => void;
  markDemoBroken: (deviceId: string, fixAbove: string) => void;
  effectiveStatus: (device: Pick<Device, 'id' | 'status'>) => EffectiveStatus;
  // Where a demo-broken device stands in its heal cycle — the honest signal the demo narrates from.
  demoHealState: (deviceId: string) => DemoHealState;
  // The raw client-side break transients, exposed so a consumer (App's crash toast) can fire the
  // instant a device is marked breaking/demo-broken — the demo mocks the panic, so this is the
  // earliest signal, well before the real crash_reports row arrives over realtime.
  breaking: Record<string, number>;
  demoBroken: Record<string, DemoBroken>;
  // True while any device reads red. Derived here rather than by the consumer because this provider
  // already holds the device list — a consumer calling useDevices() itself would open a second
  // realtime subscription for the lifetime of the app (tabs stay mounted via display:none).
  anyError: boolean;
  // The break demo's DURABLE state, read off migration 0080's devices.demo_fault_* columns rather
  // than the in-memory `demoBroken` markers above — so both survive a page reload.
  //   • demoBrokenNow  — a device is broken and hasn't adopted the fix yet. Picks which sketch the
  //                      bundled demo repo serves as main/main.c.
  //   • demoBrokeAt    — when the FIRST break fired, or null if none ever did. Stays set after the
  //                      heal: a merged bad commit doesn't vanish from history.
  demoBrokenNow: boolean;
  demoBrokeAt: Date | null;
}

const Ctx = createContext<DeviceHealth | null>(null);

// ── semver helpers ──────────────────────────────────────────────────────────────────
function parseSemver(v: string | null | undefined): [number, number, number] | null {
  const m = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(typeof v === 'string' ? v : '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function semverGt(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
}

export function DeviceHealthProvider({ children }: { children: ReactNode }) {
  const { crashes } = useCrashReports();
  // The device list (incl. any leased pool L2, surfaced via l2_visible_devices) — the source of
  // the live firmware version that clears a "demo broken" marker on recovery.
  const { devices } = useDevices();
  // Live OTA job rows — drives the blue 'updating' dot. sharedResource dedupes this with
  // OtaTab's subscription, so mounting it here opens no extra channel.
  const { jobs } = useOtaJobs();
  // deviceId -> epoch ms when it was marked breaking.
  const [breaking, setBreaking] = useState<Record<string, number>>({});
  // deviceId -> the demo-broken marker (instant-crash red-until-fixed).
  const [demoBroken, setDemoBroken] = useState<Record<string, DemoBroken>>({});
  // A coarse ticker so the amber timeout + crash linger + demo-broken TTL expire on their own.
  // Threaded into `value` below so consumers actually re-render on each tick — otherwise the
  // memoized context value would be stable and purely time-based transitions would never show.
  const [tick, setTick] = useState(0);

  const markBreaking = useCallback((deviceIds: string[]) => {
    const now = Date.now();
    setBreaking(prev => {
      const next = { ...prev };
      for (const id of deviceIds) next[id] = now;
      return next;
    });
  }, []);

  // Mark a device "demo broken" (red) until it heartbeats a firmware version above `fixAbove`
  // (the seeded buggy semver). The instant-crash path calls this: the crash is injected onto a
  // device still running healthy firmware, so the raw status never goes red — this marker does,
  // and recovery is tied to the agent's REAL fix OTA landing, not a timer.
  const markDemoBroken = useCallback((deviceId: string, fixAbove: string) => {
    if (!deviceId) return;
    setDemoBroken(prev => ({ ...prev, [deviceId]: { since: Date.now(), fixAbove } }));
  }, []);

  // Most-recent crash timestamp per device (ms). `crashes` is already newest-first (capped 50).
  const lastCrashAt = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of crashes) {
      const t = c.timestamp.getTime();
      if (!(c.deviceId in m) || t > m[c.deviceId]) m[c.deviceId] = t;
    }
    return m;
  }, [crashes]);

  // Live running firmware per device (the greater of the reported + current version), used to
  // detect recovery of a demo-broken device.
  const fwById = useMemo(() => {
    const m: Record<string, [number, number, number] | null> = {};
    for (const d of devices) {
      const a = parseSemver(d.firmwareVersion);
      const b = parseSemver(d.currentFirmwareVersion);
      m[d.id] = a && b ? (semverGt(a, b) ? a : b) : (a ?? b);
    }
    return m;
  }, [devices]);

  // Devices with an update shipping to them right now (an in-flight ota_jobs row).
  const updatingIds = useMemo(
    () => new Set(jobs.filter(j => OTA_IN_FLIGHT.has(j.status)).map(j => j.deviceId)),
    [jobs],
  );

  // Where a demo-broken device stands. Derived at read time (not pruned via setState) so recovery
  // reflects live device updates without an effect writing state. Markers are keyed by device id
  // (bounded to the pool), so leaving a recovered entry in the map is harmless.
  //
  // Recovery is checked BEFORE the safety TTL: a device that finally adopts the fix at minute 26
  // has genuinely recovered, and saying so is more truthful than reporting the timeout that would
  // otherwise have fired first. The TTL remains the escape hatch for every other case (fix never
  // landed, device went offline holding the fixed firmware) so a dot can never stick red forever.
  const demoHealState = useCallback(
    (deviceId: string): DemoHealState => {
      const mark = demoBroken[deviceId];
      if (!mark) return 'idle';

      const running = fwById[deviceId];
      const target = parseSemver(mark.fixAbove);
      const fwClimbed = running != null && target != null && semverGt(running, target);

      // The fix OTA landed — but only call it recovered once the device would actually read GREEN:
      // its raw status is back online and no panic is still lingering. Otherwise the demo would
      // announce "healthy again" over a device the dot still (correctly) paints red, which is the
      // exact dishonesty this state machine exists to prevent.
      if (fwClimbed) {
        const crashedAt = lastCrashAt[deviceId];
        const crashLingering = crashedAt != null && Date.now() - crashedAt < CRASH_LINGER_MS;
        const status = devices.find(d => d.id === deviceId)?.status;
        if (status === 'online' && !crashLingering) return 'recovered';
      }

      if (Date.now() - mark.since > DEMO_BROKEN_TTL_MS) return 'expired'; // safety expiry
      return 'healing';
    },
    [demoBroken, fwById, devices, lastCrashAt],
  );

  // A demo-broken marker is "active" (dot stays red) exactly while it is still healing — a
  // recovered device shows its real colour, and an expired marker is released so nothing sticks red.
  const demoBrokenActive = useCallback(
    (deviceId: string): boolean => demoHealState(deviceId) === 'healing',
    [demoHealState],
  );

  // Only tick while there is time-sensitive state to expire (an active break, a recent crash, or
  // a demo-broken marker), so an idle fleet does no per-second work.
  useEffect(() => {
    const now = Date.now();
    const anyBreaking = Object.values(breaking).some(t => now - t < BREAKING_TIMEOUT_MS);
    const anyRecentCrash = Object.values(lastCrashAt).some(t => now - t < CRASH_LINGER_MS);
    const anyDemoBroken = Object.keys(demoBroken).length > 0;
    if (!anyBreaking && !anyRecentCrash && !anyDemoBroken) return;
    const iv = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(iv);
  }, [breaking, lastCrashAt, demoBroken]);

  const effectiveStatus = useCallback(
    (device: Pick<Device, 'id' | 'status'>): EffectiveStatus => {
      const now = Date.now();

      // RED (demo) — the instant-crash path: the crash was injected onto a device still running
      // healthy firmware, so its raw status stays 'online'. Hold red until the agent's fix OTA
      // lands (firmware climbs above the seeded version). Wins over every other state.
      if (demoBrokenActive(device.id)) return 'error';

      const crashedAt = lastCrashAt[device.id];
      const crashedRecently = crashedAt != null && now - crashedAt < CRASH_LINGER_MS;

      // RED — actively crashing / agent fixing. The L1 mock reports status='error' while its
      // fault is armed; between crash-loop reboots it may blink 'offline' (LWT), so as long as
      // a crash is recent AND it isn't back online, keep it red.
      if (device.status === 'error') return 'error';
      if (crashedRecently && device.status !== 'online') return 'error';

      // BLUE — a firmware update is shipping to this device (in-flight ota_jobs row). Below the
      // red branches on purpose: a broken device receiving its fix stays red until it recovers.
      if (updatingIds.has(device.id)) return 'updating';

      // AMBER — you just clicked break; the crash is landing but it hasn't gone red yet.
      // Suppressed once a crash lands (red wins) and time-capped so a no-op break can't strand it.
      const brokeAt = breaking[device.id];
      if (brokeAt != null && now - brokeAt < BREAKING_TIMEOUT_MS && !crashedRecently) {
        return 'breaking';
      }

      // GREEN / grey / … — the authoritative status.
      return device.status;
    },
    [breaking, lastCrashAt, demoBrokenActive, updatingIds],
  );

  // Is anything red right now? Spans a reload, unlike the client-only `demoBroken` markers: a
  // demo-broken device's raw status is held at 'error' across its healthy heartbeats by migration
  // 0080's demo_fault_above, and cleared honestly once the agent's fix OTA is adopted.
  const anyError = devices.some(d => effectiveStatus(d) === 'error');

  // ── the durable break markers (migration 0080) ────────────────────────────────────
  // These read the DB columns, not the in-memory maps above, so a reload mid-heal still shows the
  // buggy sketch, the break commit, and the merged break PR. `anyError` is deliberately NOT the
  // predicate: an unrelated device erroring (or a DemoChaosPanel scenario that seeds some OTHER
  // sketch) must not rewrite main/main.c to the null_deref twin.
  //
  // Still healing = the fault was armed and the device has not yet adopted firmware strictly above
  // the seeded version. Exactly the condition 0080's heartbeat override holds status='error' on.
  const demoBrokenNow = devices.some(d => {
    if (!d.demoFaultSince || !d.demoFaultAbove) return false;
    const running = fwById[d.id];
    const target = parseSemver(d.demoFaultAbove);
    return !(running != null && target != null && semverGt(running, target));
  });

  // When the first break fired. Anchors the derived break commit/PR (data/babynffDemoGit.ts), which
  // must outlive the heal — so this never clears once set.
  const demoBrokeAtMs = devices.reduce<number | null>((earliest, d) => {
    const t = d.demoFaultSince?.getTime();
    if (t == null) return earliest;
    return earliest == null || t < earliest ? t : earliest;
  }, null);
  // Rebuild the Date only when the timestamp actually changes: a fresh object every render would
  // make it an unstable dep for every consumer's useMemo.
  const demoBrokeAt = useMemo(
    () => (demoBrokeAtMs == null ? null : new Date(demoBrokeAtMs)),
    [demoBrokeAtMs],
  );

  // `tick` is intentionally a dep: each 1s tick makes a fresh value so consumers re-render and
  // re-evaluate the time-based branches (amber timeout / crash linger / demo-broken TTL). Only
  // ticks while an incident is active, so an idle fleet does no per-second re-rendering.
  const value = useMemo(
    () => ({
      markBreaking, markDemoBroken, effectiveStatus, demoHealState, breaking, demoBroken, anyError,
      demoBrokenNow, demoBrokeAt,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markBreaking, markDemoBroken, effectiveStatus, demoHealState, breaking, demoBroken, anyError,
     demoBrokenNow, demoBrokeAt, tick],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// Marks devices as "breaking" (amber) — call the moment a break / self-heal is fired.
// No-op when no provider is mounted, so callers can use it unconditionally.
export function useMarkBreaking(): (deviceIds: string[]) => void {
  const ctx = useContext(Ctx);
  return ctx?.markBreaking ?? noop;
}
const noop = () => {};

// Marks a device "demo broken" (red until its firmware climbs above `fixAbove`) — call with the
// self-heal response's device_id + seeded version. No-op when no provider is mounted.
export function useMarkDemoBroken(): (deviceId: string, fixAbove: string) => void {
  const ctx = useContext(Ctx);
  return ctx?.markDemoBroken ?? noop2;
}

// The device the demo is currently healing, or null. Read from the shared `demoBroken` marker so it
// resolves whichever of the three break triggers fired (App.runBreakHeal, OverviewTab, DemoChaosPanel)
// without each having to thread the id up.
//
// The MOST RECENTLY marked device wins. Markers are never pruned (recovery is derived at read time),
// so a second demo on a different device leaves the first device's entry in the map: taking the first
// key would hand back the previous, already-recovered device — pointing DemoFixWatcher at the wrong
// row and letting the recover beat fire the instant the new story reached its deploy phase.
export function useDemoBrokenDeviceId(): string | null {
  const ctx = useContext(Ctx);
  const entries = Object.entries(ctx?.demoBroken ?? {});
  if (entries.length === 0) return null;
  return entries.reduce((newest, e) => (e[1].since > newest[1].since ? e : newest))[0];
}
const noop2 = () => {};

// Where the demo's device stands in its heal cycle. The demo narrates from this instead of a timer:
// 'recovered' is the ONLY state that earns a "healthy again" toast, and it requires the device to
// have adopted firmware above the seeded version AND to read green for real. 'expired' means the
// safety TTL elapsed without the fix landing — the honest ending, not a recovery.
// Returns 'idle' when no provider is mounted or no device is given.
export function useDemoHealState(deviceId: string | null): DemoHealState {
  const ctx = useContext(Ctx);
  if (!ctx || !deviceId) return 'idle';
  return ctx.demoHealState(deviceId);
}

// The current client-side "just broke" transients (device id → epoch ms), for a consumer that
// wants to react the instant a break is fired — before the real crash_reports row lands. Returns
// stable empty maps when no provider is mounted, so it is safe to call unconditionally.
const EMPTY_BREAK: Record<string, number> = {};
const EMPTY_DEMO: Record<string, DemoBroken> = {};
export function useDeviceBreakState(): { breaking: Record<string, number>; demoBroken: Record<string, DemoBroken> } {
  const ctx = useContext(Ctx);
  return { breaking: ctx?.breaking ?? EMPTY_BREAK, demoBroken: ctx?.demoBroken ?? EMPTY_DEMO };
}

// True while any device reads red (a live incident). Survives a reload, unlike the demoBroken
// markers — see `anyError` above. False when no provider is mounted.
export function useAnyDeviceError(): boolean {
  return useContext(Ctx)?.anyError ?? false;
}

// True while the break demo's device is broken and has not yet adopted the agent's fix. Read from
// migration 0080's durable devices.demo_fault_* columns, so it survives a reload. This — not
// useAnyDeviceError — decides whether the bundled demo repo serves the buggy sketch.
export function useDemoBrokenNow(): boolean {
  return useContext(Ctx)?.demoBrokenNow ?? false;
}

// When the break demo first fired, or null if it never has. Never clears once set (the heal doesn't
// un-merge the bad commit), so the derived break commit + PR persist through recovery and reloads.
export function useDemoBrokeAt(): Date | null {
  return useContext(Ctx)?.demoBrokeAt ?? null;
}

// The effective-status accessor itself, for callers that classify a *list* of devices (the Enroll
// board's inactive sweep) rather than render one dot — useEffectiveStatus is a hook, so it can't be
// called per item. Same overlays, same no-provider fallback to the raw status.
export function useEffectiveStatusFn(): (device: Pick<Device, 'id' | 'status'>) => EffectiveStatus {
  const ctx = useContext(Ctx);
  return ctx?.effectiveStatus ?? rawStatus;
}
const rawStatus = (d: Pick<Device, 'id' | 'status'>): EffectiveStatus => d.status;

// Returns the effective dot status for a device, overlaying the break→crash→recover lifecycle
// on the raw status. Falls back to the raw status when no provider is mounted or no device is
// given, so it is safe to call from any StatusBadge.
export function useEffectiveStatus(
  device: Pick<Device, 'id' | 'status'> | undefined,
  fallback: DeviceStatus,
): EffectiveStatus {
  const ctx = useContext(Ctx);
  if (!device || !ctx) return fallback;
  return ctx.effectiveStatus(device);
}
