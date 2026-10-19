// Shared server-side helper backing the user-facing OTA surface (`nff ota` in the core CLI and,
// later, the dashboard). Used by both the Vercel functions (api/ota/*.ts, prod) and the Vite dev
// middleware (vite.config.ts) — the same split as api/_provision.ts / api/_account.ts.
//
// This is the seam that "links the platform to the core package": the MIT CLI is a thin HTTP
// client, and ALL orchestration stays here + in nff-ota. Two privilege levels, deliberately:
//
//   reads (status/deployments/devices) — the USER's own JWT against PostgREST. RLS scopes every
//        row to the projects that user belongs to, so we never hand-filter and cannot leak another
//        tenant's fleet. (deployments/ota_jobs/device_groups/devices all have member-scoped RLS —
//        they are in api/_account.ts's export set, read the same way.)
//
//   deploy — resolve the target group under the USER's JWT (RLS proves membership), then forward
//        the rollout to nff-ota's /internal/build-deploy with the SERVER-side X-Fleet-Secret. The
//        binary is uploaded + a deployment created + started atomically by nff-ota; we duplicate
//        none of that state machine. ⚠ We forward an explicit device_group_id we resolved under the
//        user's token — never the raw group NAME — because nff-ota's /internal/build-deploy looks a
//        name up globally with no tenant filter, which would be a cross-tenant risk.

import { isTimeoutError } from './_fleet.js';

// Node's fetch has no default timeout. Both stay under the routes' maxDuration (vercel.json) so a
// stalled dependency fails with a real error rather than an opaque platform 504.
const SUPABASE_TIMEOUT_MS = 8_000;
// The nff-ota hop uploads the artifact + creates + starts the deployment (real work): 20s.
const OTA_TIMEOUT_MS = 20_000;

export interface OtaCfg {
  supabaseUrl?: string;
  anonKey?: string;
  otaUrl?: string;      // NFF_OTA_URL (default http://localhost:3002)
  fleetSecret?: string; // NFF_FLEET_SECRET (== nff-ota's fleet_secret; the X-Fleet-Secret it checks)
}

interface Env {
  supabaseUrl: string;
  anonKey: string;
  otaUrl: string;
  fleetSecret: string;
}

function readEnv(cfg?: OtaCfg): Env {
  return {
    supabaseUrl: (cfg?.supabaseUrl ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, ''),
    anonKey: cfg?.anonKey ?? process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
    otaUrl: (cfg?.otaUrl ?? process.env.NFF_OTA_URL ?? 'http://localhost:3002').replace(/\/+$/, ''),
    fleetSecret: cfg?.fleetSecret ?? process.env.NFF_FLEET_SECRET ?? '',
  };
}

function bearer(authorization: unknown): string {
  return typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '').trim() : '';
}

const isSemver = (v: string) => /^\d+\.\d+\.\d+$/.test(v);

export interface OtaResult {
  ok: boolean;
  status: number; // HTTP status to return to the client
  data?: unknown;
  error?: string;
}

// ── shared: read a table under the caller's JWT (RLS scopes it to their projects) ──────────────
async function readUnderRls(env: Env, token: string, query: string): Promise<OtaResult> {
  let res: Response;
  try {
    res = await fetch(`${env.supabaseUrl}/rest/v1/${query}`, {
      headers: { apikey: env.anonKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTimeoutError(e)) return { ok: false, status: 504, error: `data backend timed out after ${SUPABASE_TIMEOUT_MS / 1000}s` };
    return { ok: false, status: 502, error: `data backend unreachable: ${(e as Error)?.message ?? e}` };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, status: 401, error: 'session expired — sign in again' };
  if (!res.ok) return { ok: false, status: 502, error: `read failed (${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}` };
  const rows = await res.json().catch(() => null);
  if (!Array.isArray(rows)) return { ok: false, status: 502, error: 'unexpected non-array response' };
  return { ok: true, status: 200, data: rows };
}

function guardEnv(env: Env, needFleet = false): OtaResult | null {
  if (!env.supabaseUrl || !env.anonKey) return { ok: false, status: 500, error: 'Supabase env is not configured' };
  if (needFleet && !env.fleetSecret) return { ok: false, status: 500, error: 'NFF_FLEET_SECRET is not configured' };
  return null;
}

// ── deploy ─────────────────────────────────────────────────────────────────────────────────────
export interface DeployMeta {
  version: unknown;
  group: unknown;         // device group NAME (resolved to an id under the user's token)
  project?: unknown;      // optional project id to disambiguate a group name shared across projects
  name?: unknown;
  deviceTypes?: string[];
  maxInFlight?: number;
  retries?: number;
}

export async function deployFirmware(
  authorization: unknown,
  bytes: Buffer,
  meta: DeployMeta,
  cfg?: OtaCfg,
): Promise<OtaResult> {
  const env = readEnv(cfg);
  const bad = guardEnv(env, true);
  if (bad) return bad;

  const token = bearer(authorization);
  if (!token) return { ok: false, status: 401, error: 'sign in first (missing bearer token)' };

  const { version, group } = meta;
  if (typeof version !== 'string' || !version) return { ok: false, status: 400, error: 'version is required' };
  // The device's anti-downgrade gate compares 3-part semver, so the on-wire version must be one.
  if (!isSemver(version)) return { ok: false, status: 400, error: `version must be 3-part semver (got "${version}")` };
  if (typeof group !== 'string' || !group) return { ok: false, status: 400, error: 'group is required' };
  if (!bytes || bytes.length === 0) return { ok: false, status: 400, error: 'empty artifact' };

  // 1) Resolve the group by name UNDER THE USER'S JWT. RLS proves membership: a group they cannot
  //    see returns zero rows → 404. An explicit ?project= narrows a name shared across projects.
  const projectId = typeof meta.project === 'string' && meta.project ? meta.project : null;
  let q = `device_groups?select=id,name,project_id&name=eq.${encodeURIComponent(group)}`;
  if (projectId) q += `&project_id=eq.${encodeURIComponent(projectId)}`;
  const groups = await readUnderRls(env, token, q);
  if (!groups.ok) return groups;
  const rows = groups.data as { id: string; project_id: string }[];
  if (rows.length === 0) {
    return { ok: false, status: 404, error: `device group "${group}" not found (or you're not a member)` };
  }
  if (rows.length > 1) {
    const projects = rows.map(r => r.project_id).join(', ');
    return {
      ok: false,
      status: 409,
      error: `group name "${group}" exists in multiple projects (${projects}) — pass --project <id> to choose one`,
    };
  }
  const groupId = rows[0].id;

  // 2) Forward to nff-ota's atomic upload+create+start. We send the resolved group_id (never the
  //    name) so nff-ota targets exactly the tenant we authorized. device_types omitted → nff-ota
  //    derives them from the group's members.
  const body: Record<string, unknown> = {
    version,
    name: typeof meta.name === 'string' && meta.name ? meta.name : version,
    device_group_id: groupId,
    artifact_b64: bytes.toString('base64'),
  };
  if (meta.deviceTypes && meta.deviceTypes.length > 0) body.device_types = meta.deviceTypes;
  if (typeof meta.maxInFlight === 'number') body.max_devices_in_flight = meta.maxInFlight;
  if (typeof meta.retries === 'number') body.retries = meta.retries;

  let resp: Response;
  try {
    resp = await fetch(`${env.otaUrl}/internal/build-deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fleet-Secret': env.fleetSecret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(OTA_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTimeoutError(e)) return { ok: false, status: 504, error: `nff-ota timed out after ${OTA_TIMEOUT_MS / 1000}s` };
    return { ok: false, status: 502, error: `nff-ota unreachable: ${(e as Error)?.message ?? e}` };
  }
  const data = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!resp.ok) {
    return { ok: false, status: resp.status === 400 ? 400 : 502, error: (data?.error as string) ?? `nff-ota returned ${resp.status}` };
  }
  if (!data) {
    return { ok: false, status: 502, error: 'nff-ota returned a non-JSON response (is the /internal/build-deploy route deployed?)' };
  }
  return {
    ok: true,
    status: 200,
    data: {
      deployment_id: data.deployment_id,
      version: data.version ?? version,
      delivered: data.delivered ?? 0,
      failed: data.failed ?? 0,
      skipped: data.skipped ?? 0,
      start_error: data.start_error ?? null,
    },
  };
}

// ── reads (all RLS-scoped to the caller's projects) ─────────────────────────────────────────────

// One deployment's per-device job rows + the deployment row, or the caller's most recent
// deployment when no id is given.
export async function deploymentStatus(
  authorization: unknown,
  deploymentId: string | null,
  cfg?: OtaCfg,
): Promise<OtaResult> {
  const env = readEnv(cfg);
  const bad = guardEnv(env);
  if (bad) return bad;
  const token = bearer(authorization);
  if (!token) return { ok: false, status: 401, error: 'sign in first (missing bearer token)' };

  let depId = deploymentId;
  if (!depId) {
    const latest = await readUnderRls(env, token, 'deployments?select=id&order=created_at.desc&limit=1');
    if (!latest.ok) return latest;
    const l = latest.data as { id: string }[];
    if (l.length === 0) return { ok: true, status: 200, data: { deployment: null, jobs: [] } };
    depId = l[0].id;
  }

  const dep = await readUnderRls(env, token, `deployments?select=*&id=eq.${encodeURIComponent(depId)}`);
  if (!dep.ok) return dep;
  const depRows = dep.data as unknown[];
  if (depRows.length === 0) return { ok: false, status: 404, error: `deployment ${depId} not found (or not yours)` };

  const jobs = await readUnderRls(env, token, `ota_jobs?select=*&deployment_id=eq.${encodeURIComponent(depId)}&order=updated_at.desc`);
  if (!jobs.ok) return jobs;

  return { ok: true, status: 200, data: { deployment: depRows[0], jobs: jobs.data } };
}

export async function listDeployments(authorization: unknown, cfg?: OtaCfg): Promise<OtaResult> {
  const env = readEnv(cfg);
  const bad = guardEnv(env);
  if (bad) return bad;
  const token = bearer(authorization);
  if (!token) return { ok: false, status: 401, error: 'sign in first (missing bearer token)' };

  const deployments = await readUnderRls(env, token, 'deployments?select=*&order=created_at.desc&limit=50');
  if (!deployments.ok) return deployments;
  const versions = await readUnderRls(
    env, token,
    'firmware_versions?select=version,name,device_types,size_bytes,release_version,created_at&order=created_at.desc&limit=50',
  );
  if (!versions.ok) return versions;

  return { ok: true, status: 200, data: { deployments: deployments.data, firmware_versions: versions.data } };
}

export async function listDevices(authorization: unknown, cfg?: OtaCfg): Promise<OtaResult> {
  const env = readEnv(cfg);
  const bad = guardEnv(env);
  if (bad) return bad;
  const token = bearer(authorization);
  if (!token) return { ok: false, status: 401, error: 'sign in first (missing bearer token)' };

  return readUnderRls(
    env, token,
    'devices?select=id,name,project_id,device_type,status,ota_status,firmware_version,current_firmware_version&order=name.asc&limit=500',
  );
}
