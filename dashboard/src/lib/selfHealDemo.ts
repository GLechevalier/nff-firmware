import type { Device } from '../types/device';

// The crash-loop scenario that drives the full "diagnose + heal" story: the device crash-loops
// until the agent fixes the code and ships an OTA. Same endpoint the DemoChaosPanel uses.
export const HEAL_SCENARIO = 'null_deref';

// device_type stamped on Level-2 (heavy QEMU, real-firmware) mocks; see nff-mock controller
// levels.py → NFF_MOCK_DEVICE_TYPE. L1 (Python sim) mocks default to plain 'esp32'.
const L2_DEVICE_TYPE = 'nff-qemu-esp32';

// Pick a device to break for the self-heal demo. It MUST be a Level-2 QEMU mock: only L2 boots a
// real flash image, so only L2 can be crash-looped by a code fault and genuinely recover via an
// agent code fix + OTA recompile. Breaking an L1 Python sim looks like it does nothing — the
// diagnose→fix→OTA story has no real firmware to act on. Prefer an online/warning L2 mock; never
// fall back to L1, since that reproduces exactly the "demo doesn't work" bug.
export function pickVictim(devices: Device[]): Device | undefined {
  return devices.find(
    d =>
      d.id.startsWith('mock-') &&
      d.deviceType === L2_DEVICE_TYPE &&
      (d.status === 'online' || d.status === 'warning'),
  );
}

// Poll the (realtime-fed) device list until an L2 mock is online — a freshly seeded L2 takes
// ~30 s to spawn + ~60 s for the QEMU boot. Resolves undefined past the ceiling.
export async function waitForVictim(
  getDevices: () => Device[], timeoutMs = 180_000, everyMs = 2_000,
): Promise<Device | undefined> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = pickVictim(getDevices());
    if (v) return v;
    await new Promise(r => setTimeout(r, everyMs));
  }
  return undefined;
}

export interface SelfHealResult {
  ok: boolean;
  queued?: boolean;     // the shared L2 pool was full (both leased) — the cycle hasn't started yet
  deviceId?: string;    // the device actually being broken (the borrowed pool L2), when the cycle started
  sessionId?: string;   // the agent chat session the heal narrates in, when the server returns one
  version?: string;     // the seeded (buggy) semver — the dot stays red until the device runs above it
  error?: string;
}

// Fire the real break-and-self-heal cascade (POST /api/demo/selfheal): a crash-loop fault the agent
// diagnoses, fixes and OTA-recovers. Shared by the babynff Overview "Try this" card and the
// Onboarding "Watch your fleet" step. Sends a per-break request_key so the borrow is idempotent and
// fair-share-capped (migration 0076); a 202 means the pool is full (queued), NOT success.
// `deviceId` is optional: for a pool-only demo (no own L2s) leave it empty and the server borrows a
// shared pool L2 (its id comes from the lease). Pass an id only to target a specific own device.
export async function triggerSelfHeal(deviceId: string, projectId: string, scenario: string = HEAL_SCENARIO): Promise<SelfHealResult> {
  try {
    const resp = await fetch('/api/demo/selfheal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, project_id: projectId, scenario, request_key: crypto.randomUUID() }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 202 || data?.lease_state === 'queued') return { ok: true, queued: true };
    if (!resp.ok) return { ok: false, error: (data?.error as string) ?? String(resp.status) };
    return {
      ok: true,
      deviceId: typeof data?.device_id === 'string' ? data.device_id : undefined,
      sessionId: typeof data?.session_id === 'string' ? data.session_id : undefined,
      version: typeof data?.version === 'string' ? data.version : undefined,
    };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) };
  }
}
