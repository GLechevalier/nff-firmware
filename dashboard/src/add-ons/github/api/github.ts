// Shared server-side helper: ask nff-github to connect a repo to a device group.
// Used by both the Vercel function (api/github/connect.ts, prod) and the Vite dev
// middleware (vite.config.ts, `npm run dev`). The internal shared secret stays
// server-side — it is never exposed to the browser bundle.
//
// installation_id discovery needs the GitHub App private key, which only nff-github
// holds, so the connection MUST be created server-side via its /internal/connect-repo
// route rather than written to Supabase from the browser.

import { createHmac, timingSafeEqual } from 'node:crypto';

// Self-contained on purpose (node builtins only): nff-admin consumes this module as a synced
// committed copy (scripts/sync-addons.mjs), where sibling api/ helpers don't exist.
function isTimeoutError(e: unknown): boolean {
  const err = e as { name?: string; cause?: { name?: string } } | null;
  const name = err?.name ?? '';
  const causeName = err?.cause?.name ?? '';
  return name === 'TimeoutError' || name === 'AbortError'
    || causeName === 'TimeoutError' || causeName === 'AbortError';
}

// ─── Timeout budget ─────────────────────────────────────────────────────────
// Every call below crosses a Cloudflare tunnel to the self-hosted nff-github box, which then
// talks to GitHub itself (App JWT -> installation token -> REST). That is legitimately a few
// seconds, so 15s: long enough that a slow-but-alive repo read still succeeds, short enough to
// return a structured 504 inside api/github.ts's maxDuration (20s in vercel.json).
const GITHUB_TIMEOUT_MS = 15_000;
// The liveness probe is deliberately much tighter — see pingGithubTunnel.
const GITHUB_HEALTH_TIMEOUT_MS = 4_000;

// Shared 504 body for an aborted nff-github call, in this module's structured error shape.
function githubTimeout(): { ok: false; status: number; error: string } {
  return { ok: false, status: 504, error: `nff-github timed out after ${GITHUB_TIMEOUT_MS / 1000}s` };
}

export interface ConnectResult {
  ok: boolean;
  status: number;            // HTTP status to return to the client
  connection?: unknown;      // ConnectionInfo from nff-github, when ok
  error?: string;
}

export interface GithubCfg { githubUrl?: string; githubSecret?: string }

// The connect_repo params the dashboard form collects. repo_full_name, device_group_id
// and device_types are required; the rest carry sensible defaults on the nff-github side.
export interface ConnectRepoBody {
  repo_full_name?: unknown;
  device_group_id?: unknown;   // null/absent = code-only connection (no fleet target, policy forced to manual)
  installation_id?: unknown;   // from the repo picker; nff-github discovers it when absent
  project_id?: unknown;
  device_types?: unknown;
  production_branch?: unknown;
  deploy_policy?: unknown;
  fqbn?: unknown;
  sketch_path?: unknown;
  max_devices_in_flight?: unknown;
  retries?: unknown;
}

export async function connectRepoViaGithub(
  body: ConnectRepoBody,
  opts?: GithubCfg,
): Promise<ConnectResult> {
  const githubUrl = (opts?.githubUrl ?? process.env.NFF_GITHUB_INTERNAL_URL ?? '').replace(/\/+$/, '');
  const githubSecret = opts?.githubSecret ?? process.env.NFF_GITHUB_INTERNAL_SECRET ?? '';

  if (!githubUrl) return { ok: false, status: 500, error: 'NFF_GITHUB_INTERNAL_URL is not configured' };
  if (!githubSecret) return { ok: false, status: 500, error: 'NFF_GITHUB_INTERNAL_SECRET is not configured' };

  const repo = body.repo_full_name;
  if (typeof repo !== 'string' || !repo.trim()) {
    return { ok: false, status: 400, error: 'repo_full_name is required' };
  }
  const groupId = typeof body.device_group_id === 'string' && body.device_group_id ? body.device_group_id : null;
  const deviceTypes = Array.isArray(body.device_types)
    ? body.device_types.map(t => String(t).trim()).filter(Boolean)
    : [];
  if (groupId && deviceTypes.length === 0) {
    return { ok: false, status: 400, error: 'device_types must be a non-empty list (e.g. ["esp32"])' };
  }

  // Pass through only the fields nff-github's ConnectRepoParams accepts; it applies
  // defaults (production_branch=main, deploy_policy=auto, fqbn="", sketch_path=".").
  // No device group = a code-only connection: nff-github stores NULL and forces 'manual'.
  const payload: Record<string, unknown> = {
    repo_full_name: repo.trim(),
    device_group_id: groupId,
    device_types: deviceTypes,
  };
  if (typeof body.installation_id === 'number' && Number.isInteger(body.installation_id)) payload.installation_id = body.installation_id;
  if (typeof body.project_id === 'string' && body.project_id) payload.project_id = body.project_id;
  if (typeof body.production_branch === 'string' && body.production_branch) payload.production_branch = body.production_branch;
  if (typeof body.deploy_policy === 'string' && body.deploy_policy) payload.deploy_policy = body.deploy_policy;
  if (typeof body.fqbn === 'string') payload.fqbn = body.fqbn;
  if (typeof body.sketch_path === 'string' && body.sketch_path) payload.sketch_path = body.sketch_path;
  if (typeof body.max_devices_in_flight === 'number') payload.max_devices_in_flight = body.max_devices_in_flight;
  if (typeof body.retries === 'number') payload.retries = body.retries;

  let resp: Response;
  try {
    resp = await fetch(`${githubUrl}/internal/connect-repo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fleet-Secret': githubSecret },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTimeoutError(e)) return githubTimeout();
    return { ok: false, status: 502, error: `nff-github unreachable: ${(e as Error)?.message ?? e}` };
  }

  let data: { connection?: unknown; error?: unknown } | null = null;
  try { data = (await resp.json()) as { connection?: unknown; error?: unknown }; } catch { /* non-JSON body */ }

  if (!resp.ok || data?.error) {
    const err = data?.error;
    const msg = typeof err === 'string' ? err : err ? JSON.stringify(err) : `nff-github returned ${resp.status}`;
    return { ok: false, status: resp.ok ? 400 : resp.status, error: msg };
  }
  return { ok: true, status: 200, connection: data?.connection };
}

// ─── Tunnel liveness probe ───────────────────────────────────────────────────
// nff-github heartbeats into Supabase from *inside* its box, so that beat stays
// fresh even when the public Cloudflare tunnel that fronts it (NFF_GITHUB_INTERNAL_URL)
// is down — and the tunnel is the only path the dashboard/Vercel has to reach it.
// This GETs nff-github's unauthenticated /internal/health THROUGH that tunnel URL,
// so a success proves the tunnel is actually carrying traffic. The dashboard ANDs
// this with the heartbeat to show nff-github green only when online AND reachable.

export interface TunnelHealthResult {
  ok: boolean;
  status: number;
  reachable: boolean;        // true only when the probe traversed the tunnel and got 2xx
  error?: string;
}

export async function pingGithubTunnel(opts?: GithubCfg): Promise<TunnelHealthResult> {
  const githubUrl = (opts?.githubUrl ?? process.env.NFF_GITHUB_INTERNAL_URL ?? '').replace(/\/+$/, '');
  if (!githubUrl) {
    return { ok: false, status: 500, reachable: false, error: 'NFF_GITHUB_INTERNAL_URL is not configured' };
  }

  // Keep the timeout short: a dead tunnel should flip the node red quickly, not
  // hang the dashboard's status poll. (A hung tunnel is an unreachable tunnel here — the abort
  // lands in the same catch and reports reachable:false, which is exactly the truth.)
  let resp: Response;
  try {
    resp = await fetch(`${githubUrl}/internal/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(GITHUB_HEALTH_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: true, status: 200, reachable: false, error: `tunnel unreachable: ${(e as Error)?.message ?? e}` };
  }
  // The probe call itself succeeded (status 200): `reachable` reports whether the
  // tunnel returned a healthy nff-github response.
  return { ok: true, status: 200, reachable: resp.ok };
}

// ─── Read-through proxy: repo tree + single file ─────────────────────────────
// The "Code" tab renders the WHOLE repo file structure with the agent's edits highlighted.
// The browser holds no GitHub credentials, so these forward to nff-github's read-only
// /internal/repo-tree and /internal/repo-file GET routes (only connected repos mint a
// token there). Same NFF_GITHUB_INTERNAL_URL/SECRET as the connect helper — no new env.

export interface RepoTreeEntry { path: string; type: 'blob' | 'tree' }
export interface RepoTreeResult {
  ok: boolean;
  status: number;
  ref?: string;
  sha?: string | null;
  truncated?: boolean;
  entries?: RepoTreeEntry[];
  error?: string;
}
export interface RepoFileResult {
  ok: boolean;
  status: number;
  path?: string;
  ref?: string;
  content?: string | null;
  sha?: string | null;
  error?: string;
}
export interface RepoBranch { name: string; commit_sha?: string | null; is_default?: boolean }
export interface RepoBranchesResult {
  ok: boolean;
  status: number;
  default_branch?: string | null;
  branches?: RepoBranch[];
  error?: string;
}

function githubCfg(opts?: GithubCfg): { url: string; secret: string } | { error: string } {
  const url = (opts?.githubUrl ?? process.env.NFF_GITHUB_INTERNAL_URL ?? '').replace(/\/+$/, '');
  const secret = opts?.githubSecret ?? process.env.NFF_GITHUB_INTERNAL_SECRET ?? '';
  if (!url) return { error: 'NFF_GITHUB_INTERNAL_URL is not configured' };
  if (!secret) return { error: 'NFF_GITHUB_INTERNAL_SECRET is not configured' };
  return { url, secret };
}

export async function fetchRepoTreeViaGithub(
  params: { repo_full_name?: unknown; ref?: unknown },
  opts?: GithubCfg,
): Promise<RepoTreeResult> {
  const cfg = githubCfg(opts);
  if ('error' in cfg) return { ok: false, status: 500, error: cfg.error };

  const repo = params.repo_full_name;
  if (typeof repo !== 'string' || !repo.trim()) {
    return { ok: false, status: 400, error: 'repo_full_name is required' };
  }
  const qs = new URLSearchParams({ repo_full_name: repo.trim() });
  if (typeof params.ref === 'string' && params.ref) qs.set('ref', params.ref);

  let resp: Response;
  try {
    resp = await fetch(`${cfg.url}/internal/repo-tree?${qs.toString()}`, {
      method: 'GET',
      headers: { 'X-Fleet-Secret': cfg.secret },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTimeoutError(e)) return githubTimeout();
    return { ok: false, status: 502, error: `nff-github unreachable: ${(e as Error)?.message ?? e}` };
  }

  type TreeBody = { ref?: string; sha?: string | null; truncated?: boolean; entries?: RepoTreeEntry[]; error?: unknown };
  let data: TreeBody | null = null;
  try { data = (await resp.json()) as TreeBody; } catch { /* non-JSON body */ }
  if (!resp.ok || data?.error) {
    const err = data?.error;
    const msg = typeof err === 'string' ? err : err ? JSON.stringify(err) : `nff-github returned ${resp.status}`;
    return { ok: false, status: resp.ok ? 400 : resp.status, error: msg };
  }
  return {
    ok: true, status: 200,
    ref: data?.ref, sha: data?.sha ?? null,
    truncated: !!data?.truncated, entries: data?.entries ?? [],
  };
}

export async function fetchRepoBranchesViaGithub(
  params: { repo_full_name?: unknown },
  opts?: GithubCfg,
): Promise<RepoBranchesResult> {
  const cfg = githubCfg(opts);
  if ('error' in cfg) return { ok: false, status: 500, error: cfg.error };

  const repo = params.repo_full_name;
  if (typeof repo !== 'string' || !repo.trim()) {
    return { ok: false, status: 400, error: 'repo_full_name is required' };
  }
  const qs = new URLSearchParams({ repo_full_name: repo.trim() });

  let resp: Response;
  try {
    resp = await fetch(`${cfg.url}/internal/repo-branches?${qs.toString()}`, {
      method: 'GET',
      headers: { 'X-Fleet-Secret': cfg.secret },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTimeoutError(e)) return githubTimeout();
    return { ok: false, status: 502, error: `nff-github unreachable: ${(e as Error)?.message ?? e}` };
  }

  type BranchesBody = { default_branch?: string | null; branches?: RepoBranch[]; error?: unknown };
  let data: BranchesBody | null = null;
  try { data = (await resp.json()) as BranchesBody; } catch { /* non-JSON body */ }
  if (!resp.ok || data?.error) {
    const err = data?.error;
    const msg = typeof err === 'string' ? err : err ? JSON.stringify(err) : `nff-github returned ${resp.status}`;
    return { ok: false, status: resp.ok ? 400 : resp.status, error: msg };
  }
  return {
    ok: true, status: 200,
    default_branch: data?.default_branch ?? null, branches: data?.branches ?? [],
  };
}

export async function fetchRepoFileViaGithub(
  params: { repo_full_name?: unknown; path?: unknown; ref?: unknown },
  opts?: GithubCfg,
): Promise<RepoFileResult> {
  const cfg = githubCfg(opts);
  if ('error' in cfg) return { ok: false, status: 500, error: cfg.error };

  const repo = params.repo_full_name;
  const path = params.path;
  if (typeof repo !== 'string' || !repo.trim()) {
    return { ok: false, status: 400, error: 'repo_full_name is required' };
  }
  if (typeof path !== 'string' || !path.trim()) {
    return { ok: false, status: 400, error: 'path is required' };
  }
  const qs = new URLSearchParams({ repo_full_name: repo.trim(), path: path.trim() });
  if (typeof params.ref === 'string' && params.ref) qs.set('ref', params.ref);

  let resp: Response;
  try {
    resp = await fetch(`${cfg.url}/internal/repo-file?${qs.toString()}`, {
      method: 'GET',
      headers: { 'X-Fleet-Secret': cfg.secret },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTimeoutError(e)) return githubTimeout();
    return { ok: false, status: 502, error: `nff-github unreachable: ${(e as Error)?.message ?? e}` };
  }

  type FileBody = { path?: string; ref?: string; content?: string | null; sha?: string | null; error?: unknown };
  let data: FileBody | null = null;
  try { data = (await resp.json()) as FileBody; } catch { /* non-JSON body */ }
  if (!resp.ok || data?.error) {
    const err = data?.error;
    const msg = typeof err === 'string' ? err : err ? JSON.stringify(err) : `nff-github returned ${resp.status}`;
    return { ok: false, status: resp.ok ? 400 : resp.status, error: msg };
  }
  return {
    ok: true, status: 200,
    path: data?.path, ref: data?.ref,
    content: data?.content ?? null, sha: data?.sha ?? null,
  };
}

// ─── Feature-cancel branch cleanup ───────────────────────────────────────────
// The Builder tab's Cancel/Remove actions delete the feature's nff-feature/* branch.
// Two-step posture (same privilege split as api/_ota.ts deploy):
//   1. read the builder_features row UNDER THE CALLER'S JWT — RLS proves project
//      membership, and repo/branch come from that row, never from the client;
//   2. forward to nff-github's /internal/delete-branch with the server-side
//      X-Fleet-Secret. nff-github refuses anything outside nff-feature/*, nff-fix/*.

const SUPABASE_TIMEOUT_MS = 8_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeleteFeatureBranchResult {
  ok: boolean;
  status: number;
  branch_name?: string | null; // null ⇔ the feature never had a branch (no-op success)
  deleted?: boolean;
  error?: string;
}

export async function deleteFeatureBranchViaGithub(
  authorization: unknown,
  body: { feature_id?: unknown },
  opts?: GithubCfg & { supabaseUrl?: string; anonKey?: string },
): Promise<DeleteFeatureBranchResult> {
  const cfg = githubCfg(opts);
  if ('error' in cfg) return { ok: false, status: 500, error: cfg.error };
  const supabaseUrl = (opts?.supabaseUrl ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const anonKey = opts?.anonKey ?? process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !anonKey) return { ok: false, status: 500, error: 'Supabase env is not configured' };

  const token = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '').trim() : '';
  if (!token) return { ok: false, status: 401, error: 'sign in to cancel a feature' };

  const featureId = typeof body.feature_id === 'string' ? body.feature_id.trim() : '';
  if (!UUID_RE.test(featureId)) return { ok: false, status: 400, error: 'feature_id must be a uuid' };

  // 1. The feature row under the caller's JWT. An empty result means "not found
  //    OR not your project" — RLS makes those indistinguishable on purpose.
  let rows: Array<{ repo_full_name?: string | null; branch_name?: string | null }>;
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/builder_features?id=eq.${featureId}&select=repo_full_name,branch_name`,
      {
        headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
      },
    );
    if (res.status === 401 || res.status === 403) return { ok: false, status: 401, error: 'session expired — sign in again' };
    if (!res.ok) return { ok: false, status: 502, error: `feature lookup failed (${res.status})` };
    const parsed: unknown = await res.json().catch(() => null);
    if (!Array.isArray(parsed)) return { ok: false, status: 502, error: 'unexpected non-array response' };
    rows = parsed;
  } catch (e) {
    if (isTimeoutError(e)) return { ok: false, status: 504, error: `data backend timed out after ${SUPABASE_TIMEOUT_MS / 1000}s` };
    return { ok: false, status: 502, error: `data backend unreachable: ${(e as Error)?.message ?? e}` };
  }
  if (rows.length === 0) return { ok: false, status: 404, error: 'feature not found (or not in one of your projects)' };

  const repo = rows[0].repo_full_name ?? null;
  const branch = rows[0].branch_name ?? null;
  if (!repo || !branch) return { ok: true, status: 200, branch_name: null, deleted: false };

  // 2. Delete the branch via nff-github.
  let resp: Response;
  try {
    resp = await fetch(`${cfg.url}/internal/delete-branch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fleet-Secret': cfg.secret },
      body: JSON.stringify({ repo_full_name: repo, branch_name: branch }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTimeoutError(e)) return githubTimeout();
    return { ok: false, status: 502, error: `nff-github unreachable: ${(e as Error)?.message ?? e}` };
  }

  let data: { deleted?: boolean; error?: unknown } | null = null;
  try { data = (await resp.json()) as { deleted?: boolean; error?: unknown }; } catch { /* non-JSON body */ }
  if (!resp.ok || data?.error) {
    const err = data?.error;
    const msg = typeof err === 'string' ? err : err ? JSON.stringify(err) : `nff-github returned ${resp.status}`;
    return { ok: false, status: resp.ok ? 400 : resp.status, error: msg };
  }
  return { ok: true, status: 200, branch_name: branch, deleted: !!data?.deleted };
}

// Remove a repo connection (stops auto-deploys; pipeline history is preserved). Routes
// through nff-github so the deletion happens with its service-role client, not the browser.
export async function disconnectRepoViaGithub(
  body: { repo_full_name?: unknown; production_branch?: unknown },
  opts?: GithubCfg,
): Promise<ConnectResult> {
  const githubUrl = (opts?.githubUrl ?? process.env.NFF_GITHUB_INTERNAL_URL ?? '').replace(/\/+$/, '');
  const githubSecret = opts?.githubSecret ?? process.env.NFF_GITHUB_INTERNAL_SECRET ?? '';

  if (!githubUrl) return { ok: false, status: 500, error: 'NFF_GITHUB_INTERNAL_URL is not configured' };
  if (!githubSecret) return { ok: false, status: 500, error: 'NFF_GITHUB_INTERNAL_SECRET is not configured' };
  if (typeof body.repo_full_name !== 'string' || !body.repo_full_name.trim()) {
    return { ok: false, status: 400, error: 'repo_full_name is required' };
  }
  // Optional: scope the removal to one branch target. Omitted, nff-github unlinks the repo
  // entirely (every branch → group connection it has).
  const branch = typeof body.production_branch === 'string' ? body.production_branch.trim() : '';

  let resp: Response;
  try {
    resp = await fetch(`${githubUrl}/internal/disconnect-repo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fleet-Secret': githubSecret },
      body: JSON.stringify({
        repo_full_name: body.repo_full_name.trim(),
        ...(branch ? { production_branch: branch } : {}),
      }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTimeoutError(e)) return githubTimeout();
    return { ok: false, status: 502, error: `nff-github unreachable: ${(e as Error)?.message ?? e}` };
  }

  let data: { connection?: unknown; error?: unknown } | null = null;
  try { data = (await resp.json()) as { connection?: unknown; error?: unknown }; } catch { /* non-JSON body */ }

  if (!resp.ok || data?.error) {
    const err = data?.error;
    const msg = typeof err === 'string' ? err : err ? JSON.stringify(err) : `nff-github returned ${resp.status}`;
    return { ok: false, status: resp.ok ? 400 : resp.status, error: msg };
  }
  return { ok: true, status: 200, connection: data?.connection };
}

// Set a connection's deploy policy ('auto' | 'manual'). Same tunnel + secret as
// connect/disconnect; nff-github's /internal/set-deploy-policy mirrors its MCP tool.
export async function setDeployPolicyViaGithub(
  body: { repo_full_name?: unknown; deploy_policy?: unknown; production_branch?: unknown },
  opts?: GithubCfg,
): Promise<ConnectResult> {
  const githubUrl = (opts?.githubUrl ?? process.env.NFF_GITHUB_INTERNAL_URL ?? '').replace(/\/+$/, '');
  const githubSecret = opts?.githubSecret ?? process.env.NFF_GITHUB_INTERNAL_SECRET ?? '';

  if (!githubUrl) return { ok: false, status: 500, error: 'NFF_GITHUB_INTERNAL_URL is not configured' };
  if (!githubSecret) return { ok: false, status: 500, error: 'NFF_GITHUB_INTERNAL_SECRET is not configured' };
  if (typeof body.repo_full_name !== 'string' || !body.repo_full_name.trim()) {
    return { ok: false, status: 400, error: 'repo_full_name is required' };
  }
  if (body.deploy_policy !== 'auto' && body.deploy_policy !== 'manual') {
    return { ok: false, status: 400, error: "deploy_policy must be 'auto' or 'manual'" };
  }
  const branch = typeof body.production_branch === 'string' ? body.production_branch.trim() : '';

  let resp: Response;
  try {
    resp = await fetch(`${githubUrl}/internal/set-deploy-policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fleet-Secret': githubSecret },
      body: JSON.stringify({
        repo_full_name: body.repo_full_name.trim(),
        deploy_policy: body.deploy_policy,
        ...(branch ? { production_branch: branch } : {}),
      }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTimeoutError(e)) return githubTimeout();
    return { ok: false, status: 502, error: `nff-github unreachable: ${(e as Error)?.message ?? e}` };
  }

  let data: { connection?: unknown; error?: unknown } | null = null;
  try { data = (await resp.json()) as { connection?: unknown; error?: unknown }; } catch { /* non-JSON body */ }

  if (!resp.ok || data?.error) {
    const err = data?.error;
    const msg = typeof err === 'string' ? err : err ? JSON.stringify(err) : `nff-github returned ${resp.status}`;
    return { ok: false, status: resp.ok ? 400 : resp.status, error: msg };
  }
  return { ok: true, status: 200, connection: data?.connection };
}

// ─── GitHub App install flow ─────────────────────────────────────────────────
// "Connect GitHub" = install the nff GitHub App on the user's account/org. The dashboard asks
// for a signed install URL (install-url, JWT-gated: RLS proves project membership), GitHub sends
// the user back to the App's Setup URL (installed: /api/github/installed?installation_id=&state=)
// and that callback binds installation → project in nff-github (POST /internal/installations).
// The state is `<project_id>.<exp>.<hmac>` keyed by the internal secret, so a forged callback
// cannot bind someone's installation to an arbitrary project. Shared with nff-admin (synced copy).

export const PLATFORM_PROJECT_ID = 'ad000000-0000-4000-8000-000000000001';
const INSTALL_STATE_TTL_S = 3600;

export function signInstallState(projectId: string, secret: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + INSTALL_STATE_TTL_S;
  const mac = createHmac('sha256', secret).update(`${projectId}.${exp}`).digest('hex');
  return `${projectId}.${exp}.${mac}`;
}

export function verifyInstallState(state: unknown, secret: string, now = Date.now()): { projectId: string } | { error: string } {
  if (typeof state !== 'string') return { error: 'missing state' };
  const [projectId, expStr, mac] = state.split('.');
  if (!projectId || !expStr || !mac || !UUID_RE.test(projectId)) return { error: 'malformed state' };
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp * 1000 < now) return { error: 'state expired — start the connection again' };
  const expected = createHmac('sha256', secret).update(`${projectId}.${exp}`).digest('hex');
  const a = Buffer.from(mac, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { error: 'invalid state signature' };
  return { projectId };
}

export interface UserRowsOpts { supabaseUrl?: string; anonKey?: string }

// Fetch rows from PostgREST under the CALLER's JWT so RLS decides what they may see. An empty
// array means "not found OR not yours" — RLS makes those indistinguishable on purpose.
export async function userRows<T = Record<string, unknown>>(
  authorization: unknown,
  restQuery: string,
  opts?: UserRowsOpts,
): Promise<{ rows: T[] } | { status: number; error: string }> {
  const supabaseUrl = (opts?.supabaseUrl ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const anonKey = opts?.anonKey ?? process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !anonKey) return { status: 500, error: 'Supabase env is not configured' };
  const token = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '').trim() : '';
  if (!token) return { status: 401, error: 'sign in first' };
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/${restQuery}`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) return { status: 401, error: 'session expired — sign in again' };
    if (!res.ok) return { status: 502, error: `lookup failed (${res.status})` };
    const parsed: unknown = await res.json().catch(() => null);
    if (!Array.isArray(parsed)) return { status: 502, error: 'unexpected non-array response' };
    return { rows: parsed as T[] };
  } catch (e) {
    if (isTimeoutError(e)) return { status: 504, error: `data backend timed out after ${SUPABASE_TIMEOUT_MS / 1000}s` };
    return { status: 502, error: `data backend unreachable: ${(e as Error)?.message ?? e}` };
  }
}

// The caller must be a member of the project (RLS on `projects`).
async function requireProjectMember(
  authorization: unknown,
  projectId: unknown,
  opts?: UserRowsOpts,
): Promise<{ projectId: string } | { status: number; error: string }> {
  const pid = typeof projectId === 'string' ? projectId.trim() : '';
  if (!UUID_RE.test(pid)) return { status: 400, error: 'project_id must be a uuid' };
  const r = await userRows(authorization, `projects?id=eq.${pid}&select=id`, opts);
  if ('error' in r) return r;
  if (r.rows.length === 0) return { status: 404, error: 'project not found (or not one of yours)' };
  return { projectId: pid };
}

export interface InstallFlowCfg extends GithubCfg, UserRowsOpts { appSlug?: string; adminOrigin?: string }

export async function githubInstallUrlFor(
  authorization: unknown,
  params: { project_id?: unknown },
  opts?: InstallFlowCfg,
): Promise<{ ok: boolean; status: number; url?: string; error?: string }> {
  const cfg = githubCfg(opts);
  if ('error' in cfg) return { ok: false, status: 500, error: cfg.error };
  const slug = opts?.appSlug ?? process.env.NFF_GITHUB_APP_SLUG ?? '';
  if (!slug) return { ok: false, status: 500, error: 'NFF_GITHUB_APP_SLUG is not configured' };
  const m = await requireProjectMember(authorization, params.project_id, opts);
  if ('error' in m) return { ok: false, status: m.status, error: m.error };
  const state = signInstallState(m.projectId, cfg.secret);
  return { ok: true, status: 200, url: `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}` };
}

// Setup-URL callback. Always resolves to a redirect (never an error page): the dashboard shows
// `github_error` in the GitHub tab. The platform project lands back on the admin console.
export async function githubInstalled(
  params: { installation_id?: unknown; state?: unknown; setup_action?: unknown },
  opts?: InstallFlowCfg,
): Promise<{ redirect: string }> {
  const back = (projectId: string | null, error?: string) => {
    const adminOrigin = (opts?.adminOrigin ?? process.env.NFF_ADMIN_ORIGIN ?? 'https://admin.nanoforgeflow.com').replace(/\/+$/, '');
    const base = projectId === PLATFORM_PROJECT_ID ? `${adminOrigin}/?tab=repo` : '/?tab=github';
    return { redirect: error ? `${base}&github_error=${encodeURIComponent(error)}` : base };
  };
  const cfg = githubCfg(opts);
  if ('error' in cfg) return back(null, cfg.error);
  const v = verifyInstallState(params.state, cfg.secret);
  if ('error' in v) return back(null, v.error);
  const installationId = Number(params.installation_id);
  if (!Number.isInteger(installationId) || installationId <= 0) return back(v.projectId, 'missing installation_id');

  try {
    const resp = await fetch(`${cfg.url}/internal/installations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fleet-Secret': cfg.secret },
      body: JSON.stringify({
        installation_id: installationId,
        project_id: v.projectId,
        setup_action: typeof params.setup_action === 'string' ? params.setup_action : null,
      }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    let data: { error?: unknown } | null = null;
    try { data = (await resp.json()) as { error?: unknown }; } catch { /* non-JSON */ }
    if (!resp.ok || data?.error) {
      const err = data?.error;
      return back(v.projectId, typeof err === 'string' ? err : `nff-github returned ${resp.status}`);
    }
    return back(v.projectId);
  } catch (e) {
    return back(v.projectId, isTimeoutError(e) ? 'nff-github timed out' : `nff-github unreachable: ${(e as Error)?.message ?? e}`);
  }
}

export interface InstallationRepo { full_name: string; default_branch: string; private: boolean; installation_id: number }

export async function installationReposViaGithub(
  authorization: unknown,
  params: { project_id?: unknown },
  opts?: InstallFlowCfg,
): Promise<{ ok: boolean; status: number; repos?: InstallationRepo[]; error?: string }> {
  const cfg = githubCfg(opts);
  if ('error' in cfg) return { ok: false, status: 500, error: cfg.error };
  const m = await requireProjectMember(authorization, params.project_id, opts);
  if ('error' in m) return { ok: false, status: m.status, error: m.error };
  const r = await internalGet<{ repos?: InstallationRepo[] }>(cfg, `/internal/installations/repos?project_id=${encodeURIComponent(m.projectId)}`);
  return 'error' in r ? { ok: false, status: r.status, error: r.error } : { ok: true, status: 200, repos: r.data.repos ?? [] };
}

// ─── Repo graph (branches + commits + open PRs) ──────────────────────────────
// Consumed by nff-admin's Repo/Improve tabs through its synced copy of this module. The shape is
// nff-github's /internal/repo-graph (camelCase, mirrors src/add-ons/dev/hooks/useRepoGraph.ts).
export async function fetchRepoGraphViaGithub(
  params: { repo_full_name?: unknown; max_branches?: unknown },
  opts?: GithubCfg,
): Promise<{ ok: boolean; status: number; graph?: Record<string, unknown>; error?: string }> {
  const cfg = githubCfg(opts);
  if ('error' in cfg) return { ok: false, status: 500, error: cfg.error };
  const repo = typeof params.repo_full_name === 'string' ? params.repo_full_name.trim() : '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, status: 400, error: 'repo_full_name must be owner/repo' };
  const qs = new URLSearchParams({ repo_full_name: repo });
  if (typeof params.max_branches === 'number') qs.set('max_branches', String(params.max_branches));
  const r = await internalGet<Record<string, unknown>>(cfg, `/internal/repo-graph?${qs}`);
  return 'error' in r ? { ok: false, status: r.status, error: r.error } : { ok: true, status: 200, graph: r.data };
}

async function internalGet<T extends object>(
  cfg: { url: string; secret: string },
  path: string,
): Promise<{ data: T } | { status: number; error: string }> {
  let resp: Response;
  try {
    resp = await fetch(`${cfg.url}${path}`, {
      headers: { 'X-Fleet-Secret': cfg.secret },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTimeoutError(e)) return githubTimeout();
    return { status: 502, error: `nff-github unreachable: ${(e as Error)?.message ?? e}` };
  }
  let data: (T & { error?: unknown }) | null = null;
  try { data = (await resp.json()) as T & { error?: unknown }; } catch { /* non-JSON body */ }
  if (!resp.ok || data?.error) {
    const err = data?.error;
    const msg = typeof err === 'string' ? err : err ? JSON.stringify(err) : `nff-github returned ${resp.status}`;
    return { status: resp.ok ? 400 : resp.status, error: msg };
  }
  return { data: data ?? ({} as T) };
}
