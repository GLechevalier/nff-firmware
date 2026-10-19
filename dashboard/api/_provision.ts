// Shared server-side helper: provision a batch bootstrap credential for the signed-in user's
// project and return its credentials.h text. Used by both the Vercel function (api/provision.ts,
// prod) and the Vite dev middleware (vite.config.ts). Same-origin, so the browser flasher hits it
// without CORS — unlike nff-diagnosis's /api/provision-batch, which is not publicly exposed.
//
// Security: membership is enforced with the USER's own Supabase JWT (RLS) — we PATCH the project
// under their token, which only succeeds if they belong to it. The fleet shared secret is used
// only for the server->fleet hop and never reaches the browser.

import { isTimeoutError } from './_fleet.js';

// ─── Timeout budget ─────────────────────────────────────────────────────────
// Supabase REST is a managed, low-latency hop — a single PATCH under the user's JWT. 8s means
// something is badly wrong, not merely slow.
const SUPABASE_TIMEOUT_MS = 8_000;
// The fleet hop MINTS a batch bootstrap credential (CA-signed cert material) across the tunnel
// to the self-hosted box, so it does real crypto work: 15s, inside api/provision.ts's
// maxDuration (20s in vercel.json).
const FLEET_PROVISION_TIMEOUT_MS = 15_000;

export interface ProvisionResult {
  ok: boolean;
  status: number; // HTTP status to return to the client
  credentials_h?: string; // the bootstrap credentials.h text (patched into the golden image)
  project_id?: string;
  batch_id?: string;
  reused?: boolean;
  error?: string;
}

export interface ProvisionCfg {
  supabaseUrl?: string;
  anonKey?: string;
  fleetUrl?: string;
  fleetSecret?: string;
}

interface FleetBatchReply {
  batch_id?: string;
  reused?: boolean;
  bootstrap_header?: string;
  error?: string;
}

export async function provisionBatch(
  authorization: unknown,
  projectId: unknown,
  cfg?: ProvisionCfg,
): Promise<ProvisionResult> {
  const supabaseUrl = (cfg?.supabaseUrl ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const anonKey = cfg?.anonKey ?? process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
  const fleetUrl = (cfg?.fleetUrl ?? process.env.NFF_FLEET_URL ?? '').replace(/\/+$/, '');
  const fleetSecret = cfg?.fleetSecret ?? process.env.NFF_FLEET_SECRET ?? '';

  if (!supabaseUrl || !anonKey) return { ok: false, status: 500, error: 'Supabase env is not configured' };
  if (!fleetUrl || !fleetSecret) return { ok: false, status: 500, error: 'fleet env is not configured' };

  const token = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '').trim() : '';
  if (!token) return { ok: false, status: 401, error: 'sign in first (missing bearer token)' };
  if (typeof projectId !== 'string' || !projectId) {
    return { ok: false, status: 400, error: 'project_id is required' };
  }

  // 1) Enforce membership AND enable zero-touch accept in one call: PATCH the project under the
  //    user's JWT (RLS). A non-member gets an empty result → 403.
  let patchRows: unknown;
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ auto_accept_enrollments: true }),
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    });
    if (r.status === 401) return { ok: false, status: 401, error: 'session expired — sign in again' };
    patchRows = await r.json().catch(() => []);
  } catch (e) {
    if (isTimeoutError(e)) {
      return { ok: false, status: 504, error: `auth backend timed out after ${SUPABASE_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, status: 502, error: `auth backend unreachable: ${(e as Error)?.message ?? e}` };
  }
  if (!Array.isArray(patchRows) || patchRows.length === 0) {
    return { ok: false, status: 403, error: 'you are not a member of this project' };
  }

  // 2) Ask the fleet to mint a batch bootstrap credential for that project (server-side secret).
  let data: FleetBatchReply | null;
  try {
    const r = await fetch(`${fleetUrl}/internal/provision-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fleet-Secret': fleetSecret },
      body: JSON.stringify({ project_id: projectId }),
      signal: AbortSignal.timeout(FLEET_PROVISION_TIMEOUT_MS),
    });
    data = (await r.json().catch(() => null)) as FleetBatchReply | null;
    if (!r.ok) return { ok: false, status: 502, error: data?.error ?? `fleet returned ${r.status}` };
  } catch (e) {
    if (isTimeoutError(e)) {
      return { ok: false, status: 504, error: `fleet timed out after ${FLEET_PROVISION_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, status: 502, error: `fleet unreachable: ${(e as Error)?.message ?? e}` };
  }
  if (!data) {
    // A 200 with a non-JSON body means the request fell through to the SPA — i.e. the fleet's
    // /internal/provision-batch edge route isn't deployed. Surface that, not a generic message.
    return {
      ok: false,
      status: 502,
      error: 'fleet returned a non-JSON response — the /internal/provision-batch edge route is not deployed (the request fell through to the SPA).',
    };
  }
  if (!data.bootstrap_header) return { ok: false, status: 502, error: 'provisioning returned no credentials' };

  return {
    ok: true,
    status: 200,
    credentials_h: data.bootstrap_header,
    project_id: projectId,
    batch_id: data.batch_id,
    reused: data.reused,
  };
}
