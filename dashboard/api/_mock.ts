// Shared server-side helper: ask the nff-mock controller (:3004) to spawn / list /
// tear down virtual ESP32 mock devices for a project. Used by both the Vercel function
// (api/demo/spawn.ts, prod) and the Vite dev middleware (vite.config.ts, `npm run dev`).
// The controller secret stays server-side — it is never exposed to the browser bundle.
//
// A spawned mock provisions a cert via fleet, connects over mTLS+MQTT, and heartbeats —
// which upserts a real `devices` row. The dashboard's realtime subscription (useDevices)
// then surfaces it live, so the caller only has to fire the spawn.
//
// Mirrors the conventions of api/_fleet.ts (502 on unreachable, surface controller JSON).

import { isTimeoutError } from './_fleet.js';

// ─── Timeout budget ─────────────────────────────────────────────────────────
// The controller SPAWNS DOCKER CONTAINERS INLINE (image pull on a cold box, cert provisioning
// via fleet, then the mock's mTLS handshake), so /mocks and the seed fan-out legitimately take
// tens of seconds — 30s, with api/demo.ts given maxDuration 60 in vercel.json for headroom.
const CTL_SPAWN_TIMEOUT_MS = 30_000;
// Everything else (list / presence / renew / inject-crash / delete) is a cheap in-memory or
// single-container operation. 10s is generous; past that the controller is hung, not busy.
const CTL_TIMEOUT_MS = 10_000;

export interface MockCtlCfg { ctlUrl?: string; controlSecret?: string }

export interface SpawnedMock { device_id: string; container_id: string; expires_at: string; name?: string }

export interface MockResult {
  ok: boolean;
  status: number;          // HTTP status to return to the client
  spawned?: SpawnedMock[]; // on spawn ok
  mocks?: unknown[];        // on list ok
  removed?: boolean;        // on delete ok
  error?: string;
}

interface CtlReply { spawned?: SpawnedMock[]; mocks?: unknown[]; removed?: boolean; ok?: boolean; error?: string }

function resolveCfg(cfg?: MockCtlCfg): { ctlUrl: string; controlSecret: string } | { error: string } {
  const ctlUrl = (cfg?.ctlUrl ?? process.env.NFF_MOCKCTL_URL ?? 'http://localhost:3004').replace(/\/+$/, '');
  const controlSecret = cfg?.controlSecret ?? process.env.NFF_MOCKCTL_CONTROL_SECRET ?? '';
  if (!controlSecret) return { error: 'NFF_MOCKCTL_CONTROL_SECRET is not configured' };
  return { ctlUrl, controlSecret };
}

async function callCtl(
  method: 'POST' | 'GET' | 'DELETE',
  path: string,
  body: Record<string, unknown> | null,
  cfg: { ctlUrl: string; controlSecret: string },
  timeoutMs: number = CTL_TIMEOUT_MS,
): Promise<{ status: number; data: CtlReply | null }> {
  const init: RequestInit = {
    method,
    headers: {
      'X-Control-Secret': cfg.controlSecret,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    // Bare fetch has no default deadline: a hung controller would otherwise pin the serverless
    // function open until the platform killed it (an opaque 504, no JSON body for the client).
    signal: AbortSignal.timeout(timeoutMs),
  };
  const resp = await fetch(`${cfg.ctlUrl}${path}`, init);
  let data: CtlReply | null = null;
  try { data = (await resp.json()) as CtlReply; } catch { /* non-JSON body */ }
  return { status: resp.status, data };
}

// Map a thrown fetch failure onto this module's structured error shape (never let an abort
// escape a helper). A timeout is a distinct condition from "can't reach it at all": 504 vs 502.
function ctlFailure(e: unknown, timeoutMs: number = CTL_TIMEOUT_MS): MockResult {
  if (isTimeoutError(e)) {
    return { ok: false, status: 504, error: `mock controller timed out after ${timeoutMs / 1000}s` };
  }
  return { ok: false, status: 502, error: `mock controller unreachable: ${(e as Error)?.message ?? e}` };
}

// Spawn mock devices bound to `projectId`, each living `ttlS` seconds (the controller reaps
// past that). `level` selects the fidelity tier (1 = Python sim, 2 = QEMU ESP32); omitted →
// the controller's default (1). Returns the spawned ids on success.
//
// Two spawn modes: pass `count` for a plain "add N more", or `target` for an idempotent
// "ensure N of this level for this project" — the controller then computes the deficit under
// a per-project lock, so racing callers converge on N instead of over-provisioning. When
// `target` is given it wins; `count` is ignored.
export async function spawnMocks(
  projectId: unknown,
  opts?: { count?: number; target?: number; ttlS?: number; namePrefix?: string; level?: number },
  cfg?: MockCtlCfg,
): Promise<MockResult> {
  const resolved = resolveCfg(cfg);
  if ('error' in resolved) return { ok: false, status: 500, error: resolved.error };
  if (typeof projectId !== 'string' || !projectId) {
    return { ok: false, status: 400, error: 'project_id is required' };
  }

  const body: Record<string, unknown> = { project_id: projectId };
  if (Number.isInteger(opts?.target) && (opts!.target as number) >= 0) {
    // Idempotent seed-to-target — controller owns the deficit math (see its per-project lock).
    body.target = opts!.target;
  } else {
    body.count = Number.isInteger(opts?.count) && (opts!.count as number) > 0 ? opts!.count : 4;
  }
  if (Number.isInteger(opts?.ttlS) && (opts!.ttlS as number) > 0) body.ttl_s = opts!.ttlS;
  // Complexity level (the controller also accepts it as `tier`); only send when specified.
  if (Number.isInteger(opts?.level)) body.level = opts!.level;
  // Optional friendly display name; the controller numbers them when count > 1.
  if (typeof opts?.namePrefix === 'string' && opts.namePrefix.trim()) {
    body.name_prefix = opts.namePrefix.trim();
  }

  let res: { status: number; data: CtlReply | null };
  try {
    res = await callCtl('POST', '/mocks', body, resolved, CTL_SPAWN_TIMEOUT_MS);
  } catch (e) {
    return ctlFailure(e, CTL_SPAWN_TIMEOUT_MS);
  }
  // Controller returns 201 on success.
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, error: res.data?.error ?? `controller returned ${res.status}` };
  }
  // A 2xx whose body isn't the controller's {spawned:[...]} JSON means the request never
  // reached the controller — typically it fell through to the SPA frontend (200 + HTML)
  // because the /internal/mock-control edge route isn't wired or NFF_MOCKCTL_URL is wrong.
  // Surface that instead of silently reporting "0 booting".
  if (!res.data || !Array.isArray(res.data.spawned)) {
    return {
      ok: false,
      status: 502,
      error: 'mock controller returned an unexpected response (not JSON) — check NFF_MOCKCTL_URL and the /internal/mock-control edge route',
    };
  }
  return { ok: true, status: 200, spawned: res.data.spawned };
}

// List the running mocks for a project (used to label the "fleet online" state).
export async function listMocks(projectId: unknown, cfg?: MockCtlCfg): Promise<MockResult> {
  const resolved = resolveCfg(cfg);
  if ('error' in resolved) return { ok: false, status: 500, error: resolved.error };
  const q = typeof projectId === 'string' && projectId
    ? `?project_id=${encodeURIComponent(projectId)}`
    : '';
  let res: { status: number; data: CtlReply | null };
  try {
    res = await callCtl('GET', `/mocks${q}`, null, resolved);
  } catch (e) {
    return ctlFailure(e);
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, error: res.data?.error ?? `controller returned ${res.status}` };
  }
  // 2xx + non-JSON ⇒ the request never reached the controller (e.g. SPA-frontend fallthrough).
  if (!res.data || !Array.isArray(res.data.mocks)) {
    return {
      ok: false,
      status: 502,
      error: 'mock controller returned an unexpected response (not JSON) — check NFF_MOCKCTL_URL and the /internal/mock-control edge route',
    };
  }
  return { ok: true, status: 200, mocks: res.data.mocks };
}

export interface SeedResult {
  ok: boolean;
  status: number;
  target?: { l1: number; l2: number };
  spawned?: { l1: number; l2: number }; // mocks NEWLY spawned by this call (0 when already at target)
  l2_note?: string;                      // set when the best-effort L2 tier couldn't fully seed
  error?: string;
}

// Seed a project's mock fleet to a fixed composition (`target.l1` Level-1 + `target.l2` Level-2).
// The deficit is computed by the CONTROLLER under a per-project lock (we pass the target, not a
// pre-counted count), so concurrent seeds — extra browser tabs, a StrictMode/HMR double-mount,
// overlapping serverless invocations — converge on the target instead of over-provisioning.
// L1 is the load-bearing tier; a hard failure there is surfaced as an error. L2 (QEMU) is
// BEST-EFFORT: when its image/firmware isn't available (e.g. plain `npm run dev`) those spawns
// soft-fail and we still return ok with the L1s (l2_note carries the reason).
export async function seedFleet(
  projectId: unknown,
  target: { l1: number; l2: number },
  cfg?: MockCtlCfg,
): Promise<SeedResult> {
  if (typeof projectId !== 'string' || !projectId) {
    return { ok: false, status: 400, error: 'project_id is required' };
  }

  // The two tiers are independent spawns against the same controller (different `level`), and
  // an L2 spawn is the slow one (QEMU image). Running them back-to-back made the seed take
  // L1+L2 wall-clock for no reason; fan them out and join. seedLevel never throws (spawnMocks
  // catches), so Promise.all can't reject and each tier's verdict is still judged separately
  // below — L1 load-bearing, L2 best-effort. Each tier is idempotent server-side, so an
  // already-satisfied target is a cheap no-op (200, spawned: []).
  const [l1, l2] = await Promise.all([
    seedLevel(projectId, 1, target.l1, cfg),
    seedLevel(projectId, 2, target.l2, cfg),
  ]);

  if (!l1.res.ok) {
    return { ok: false, status: l1.res.status, error: l1.res.error };
  }
  return {
    ok: true,
    status: 200,
    target,
    spawned: { l1: l1.spawned, l2: l2.spawned },
    ...(l2.res.ok ? {} : { l2_note: l2.res.error ?? 'level-2 mocks unavailable' }),
  };
}

// Ask the controller to bring `level` up to `target` for this project (idempotent seed-to-N;
// the controller no-ops when already at/above target, returning 200 with spawned: []).
async function seedLevel(projectId: string, level: number, target: number, cfg?: MockCtlCfg):
  Promise<{ res: MockResult; spawned: number }> {
  const res = await spawnMocks(projectId, { target, level }, cfg);
  return { res, spawned: res.spawned?.length ?? 0 };
}

// Keep-alive heartbeat: tell the controller a browser is connected to `projectId` right now,
// so it never TTL-reaps that project's Level-1 mocks while the user is online. Cheap + idempotent;
// the dashboard fires it on an interval. Errors are surfaced but callers treat it as best-effort.
export async function markPresence(projectId: unknown, cfg?: MockCtlCfg): Promise<MockResult> {
  const resolved = resolveCfg(cfg);
  if ('error' in resolved) return { ok: false, status: 500, error: resolved.error };
  if (typeof projectId !== 'string' || !projectId) {
    return { ok: false, status: 400, error: 'project_id is required' };
  }
  let res: { status: number; data: CtlReply | null };
  try {
    res = await callCtl('POST', '/mocks/presence', { project_id: projectId }, resolved);
  } catch (e) {
    return ctlFailure(e);
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, error: res.data?.error ?? `controller returned ${res.status}` };
  }
  return { ok: true, status: 200 };
}

// Reset a mock's idle lease — signals a Level-2 (heavy QEMU) mock is being employed (a
// compile / OTA / self-heal cycle against it), so the controller won't release it as idle for
// another `ttlS` seconds. A no-op on L1 lifetime (those are governed by presence). Best-effort.
export async function renewMock(deviceId: unknown, ttlS?: number, cfg?: MockCtlCfg): Promise<MockResult> {
  const resolved = resolveCfg(cfg);
  if ('error' in resolved) return { ok: false, status: 500, error: resolved.error };
  if (typeof deviceId !== 'string' || !deviceId) {
    return { ok: false, status: 400, error: 'device_id is required' };
  }
  const body: Record<string, unknown> = { device_id: deviceId };
  if (Number.isInteger(ttlS) && (ttlS as number) > 0) body.ttl_s = ttlS;
  let res: { status: number; data: CtlReply | null };
  try {
    res = await callCtl('POST', '/mocks/renew', body, resolved);
  } catch (e) {
    return ctlFailure(e);
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, error: res.data?.error ?? `controller returned ${res.status}` };
  }
  return { ok: true, status: 200 };
}

// Inject a PRERECORDED crash for a device (the instant-crash self-heal demo). A real L2 QEMU
// device has no `crash` command and would otherwise have to slowly crash-loop; instead the
// controller builds the crash from the shared scenario catalog and forwards it to fleet, which
// caches it (so the agent's fleet_get_crash returns it) and writes the durable crash_reports row.
// `buildId`/`fwVersion` come from the register-source step so the injected panic dump's build id
// matches get_firmware_source. Best-effort — the caller never fails the demo on this.
export async function injectCrashViaController(
  args: { deviceId: string; projectId: string; scenario: string; buildId: string; fwVersion: string },
  cfg?: MockCtlCfg,
): Promise<MockResult> {
  const resolved = resolveCfg(cfg);
  if ('error' in resolved) return { ok: false, status: 500, error: resolved.error };
  const body: Record<string, unknown> = {
    device_id: args.deviceId,
    project_id: args.projectId,
    scenario: args.scenario,
    build_id: args.buildId,
    fw_version: args.fwVersion,
  };
  let res: { status: number; data: CtlReply | null };
  try {
    res = await callCtl('POST', '/mocks/inject-crash', body, resolved);
  } catch (e) {
    return ctlFailure(e);
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, error: res.data?.error ?? `controller returned ${res.status}` };
  }
  return { ok: true, status: 200 };
}

// Tear down a single mock (controller restricts this to `mock-` prefixed ids).
export async function deleteMock(deviceId: unknown, cfg?: MockCtlCfg): Promise<MockResult> {
  const resolved = resolveCfg(cfg);
  if ('error' in resolved) return { ok: false, status: 500, error: resolved.error };
  if (typeof deviceId !== 'string' || !deviceId) {
    return { ok: false, status: 400, error: 'device_id is required' };
  }
  let res: { status: number; data: CtlReply | null };
  try {
    res = await callCtl('DELETE', `/mocks/${encodeURIComponent(deviceId)}`, null, resolved);
  } catch (e) {
    return ctlFailure(e);
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, status: res.status, error: res.data?.error ?? `controller returned ${res.status}` };
  }
  return { ok: true, status: 200, removed: res.data?.removed ?? true };
}
