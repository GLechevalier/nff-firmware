// Shared server-side helper: ask nff-fleet to ping a device and measure the
// round-trip. Used by both the Vercel function (api/devices/ping.ts, prod) and the
// Vite dev middleware (vite.config.ts, `npm run dev`). The fleet shared secret stays
// server-side — it is never exposed to the browser bundle.
//
// rtt is measured around the call to fleet's /internal/command, i.e. the full
// server -> fleet -> device -> fleet -> server round-trip (the server<->fleet hop is
// sub-ms on the same host/network, so this tracks the device latency closely).

import { getServiceSupabase } from './_supabase.js';

// ─── Timeout budget ─────────────────────────────────────────────────────────
// Three nested deadlines, and they MUST stay ordered:
//
//   inner (fleet waits for the device)  <  outer (we wait for fleet)  <  maxDuration
//        FLEET_DEVICE_TIMEOUT_S = 6s   <   FLEET_FETCH_TIMEOUT_MS = 8s  <  15s (vercel.json)
//
// The inner one is the `timeout` field fleet honours while waiting for the device to answer
// on MQTT. It used to be 10s against an UNBOUNDED outer fetch and Vercel's ~10s default cap,
// so pinging an offline device raced the platform: the function was killed and the caller got
// an opaque 504 instead of fleet's clean "the device didn't answer". Now fleet always gets to
// give up first and report that itself; the outer fetch only fires when fleet ITSELF is hung
// (a dead Cloudflare tunnel), and even then we return a structured 504 well inside maxDuration.
const FLEET_DEVICE_TIMEOUT_S = 6;
const FLEET_FETCH_TIMEOUT_MS = 8_000;

// AbortSignal.timeout() rejects with a TimeoutError; an explicit .abort() gives an AbortError.
// Node's fetch also surfaces either wrapped in a TypeError with `cause`, so check both.
// Exported: every outbound-fetch helper in api/ needs the same discrimination (an abort must
// return the helper's structured error shape, never throw out of the helper).
export function isTimeoutError(e: unknown): boolean {
  const err = e as { name?: string; cause?: { name?: string } } | null;
  const name = err?.name ?? '';
  const causeName = err?.cause?.name ?? '';
  return name === 'TimeoutError' || name === 'AbortError'
    || causeName === 'TimeoutError' || causeName === 'AbortError';
}

interface FleetReply {
  response?: unknown;
  error?: string;
}

export interface PingResult {
  ok: boolean;
  status: number;       // HTTP status to return to the client
  rtt_ms?: number;
  response?: unknown;   // the device's pong payload, when ok
  error?: string;
}

export interface FleetCfg { fleetUrl?: string; fleetSecret?: string }

// Generic: sign+deliver any command to a device via nff-fleet's /internal/command and
// return the device's response (or an error). pingViaFleet and crashViaFleet are thin
// wrappers. The fleet shared secret stays server-side.
export async function sendCommandViaFleet(
  deviceId: unknown,
  projectId: unknown,
  payload: Record<string, unknown>,
  opts?: { timeout?: number } & FleetCfg,
): Promise<PingResult> {
  const fleetUrl = (opts?.fleetUrl ?? process.env.NFF_FLEET_URL ?? '').replace(/\/+$/, '');
  const fleetSecret = opts?.fleetSecret ?? process.env.NFF_FLEET_SECRET ?? '';

  if (!fleetUrl) return { ok: false, status: 500, error: 'NFF_FLEET_URL is not configured' };
  if (!fleetSecret) return { ok: false, status: 500, error: 'NFF_FLEET_SECRET is not configured' };
  if (typeof deviceId !== 'string' || !deviceId) {
    return { ok: false, status: 400, error: 'device_id is required' };
  }
  if (typeof projectId !== 'string' || !projectId) {
    return { ok: false, status: 400, error: 'project_id is required' };
  }

  const body = JSON.stringify({
    device_id: deviceId,
    project_id: projectId,
    payload,
    timeout: opts?.timeout ?? FLEET_DEVICE_TIMEOUT_S,
  });

  const t0 = Date.now();
  let resp: Response;
  try {
    resp = await fetch(`${fleetUrl}/internal/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fleet-Secret': fleetSecret },
      body,
      signal: AbortSignal.timeout(FLEET_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTimeoutError(e)) {
      return {
        ok: false,
        status: 504,
        rtt_ms: Date.now() - t0,
        error: `fleet timed out after ${FLEET_FETCH_TIMEOUT_MS / 1000}s`,
      };
    }
    return { ok: false, status: 502, error: `fleet unreachable: ${(e as Error)?.message ?? e}` };
  }
  const rtt_ms = Date.now() - t0;

  let data: FleetReply | null = null;
  try { data = (await resp.json()) as FleetReply; } catch { /* non-JSON body */ }

  if (!resp.ok) {
    // 504 = device did not answer in time; surface fleet's message.
    return { ok: false, status: resp.status, rtt_ms, error: data?.error ?? `fleet returned ${resp.status}` };
  }
  return { ok: true, status: 200, rtt_ms, response: data?.response };
}

export async function pingViaFleet(
  deviceId: unknown,
  projectId: unknown,
  cfg?: FleetCfg,
): Promise<PingResult> {
  // A device that is "broken" in the self-heal demo must be unreachable. The demo marks it
  // broken only in the durable plane (devices.status='error' + demo_fault_above, migration
  // 0080) while the underlying mock keeps answering pong — so refuse the ping here, otherwise
  // a green rtt would contradict the red "broken" dot. Best-effort: if the check can't run we
  // fall through to the real MQTT ping and never block a genuine one.
  // 503 (device unavailable), NOT 504: the refusal is instant, so a "timeout" label would be a
  // lie — the UI maps 503 to "unreachable" and keeps 504 for genuine fleet/device timeouts.
  if (typeof deviceId === 'string' && deviceId && (await isDemoBroken(deviceId))) {
    return { ok: false, status: 503, error: 'device unreachable — firmware crashed' };
  }
  return sendCommandViaFleet(deviceId, projectId, { action: 'ping' }, cfg);
}

// True when the device's durable row shows the self-heal demo fault armed: upsert_device_heartbeat
// (migration 0080) flips status to 'error' only while demo_fault_above is set, within the window,
// and the running firmware hasn't climbed above it — so this faithfully reuses the DB's own
// determination without re-deriving semver, and auto-clears when the fix OTA lands. Scoped to
// demo_fault_above so an unrelated real error state stays pingable. Any failure returns false.
async function isDemoBroken(deviceId: string): Promise<boolean> {
  try {
    const supabase = getServiceSupabase();
    if (!supabase) return false;
    const { data, error } = await supabase
      .from('devices')
      .select('status, demo_fault_above')
      .eq('id', deviceId)
      .maybeSingle();
    if (error || !data) return false;
    return data.status === 'error' && data.demo_fault_above != null;
  } catch {
    return false;
  }
}

// Demo: inject a crash scenario on a mock device. `scenario` is a nff-mock scenario id
// (e.g. "null_deref", "transient_load"). The mock crashes, reboots, and publishes a
// retained crash report; an OTA-recoverable scenario then crash-loops until repaired.
export async function crashViaFleet(
  deviceId: unknown,
  projectId: unknown,
  scenario: unknown,
  cfg?: FleetCfg,
): Promise<PingResult> {
  const s = typeof scenario === 'string' && scenario ? scenario : 'transient_load';
  return sendCommandViaFleet(deviceId, projectId, { action: 'crash', scenario: s }, cfg);
}
