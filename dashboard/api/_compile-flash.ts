// Shared server-side helper: compile a connected repo's production-branch HEAD into a full
// USB-flashable ESP32 segment set (bootloader/partitions/app), with the nff enrollment machinery
// injected server-side. Backs the Code-tab "Flash (build & enroll)" button. Used by both the
// Vercel function (api/compile-flash.ts, prod) and the Vite dev middleware (vite.config.ts).
//
// Security: membership is enforced with the USER's own Supabase JWT (RLS) — we PATCH the project
// under their token (which also flips auto_accept_enrollments so the freshly-flashed device is
// auto-accepted). A non-member gets an empty result → 403. The nff-github internal secret is used
// only for the server->nff-github hop and never reaches the browser. fqbn/sketch_path are resolved
// by nff-github from the connection row — never trusted from the client.
//
// Unlike provisionBatch this returns the upstream STREAMING Response (application/x-ndjson: the
// arduino-cli build emits {"keepalive":true} lines then a terminal result line) so the caller can
// pipe it straight through — an ESP32 build can outlast a proxy's idle timeout.

import { isTimeoutError } from './_fleet.js';

// Membership PATCH is a single managed Supabase hop — 8s means something is wrong, not slow.
const SUPABASE_TIMEOUT_MS = 8_000;
// The build itself streams keepalives, but cap the whole nff-github hop under the function's
// maxDuration (300s in vercel.json) so a wedged build still returns rather than hanging forever.
const COMPILE_TIMEOUT_MS = 290_000;

export interface CompileFlashCfg {
  supabaseUrl?: string;
  anonKey?: string;
  githubUrl?: string;
  githubSecret?: string;
}

export interface CompileFlashBody {
  project_id?: unknown;
  repo_full_name?: unknown;
  production_branch?: unknown;
}

export type CompileFlashResult =
  | { ok: false; status: number; error: string }
  | { ok: true; status: 200; upstream: Response };

export async function compileFlash(
  authorization: unknown,
  body: CompileFlashBody,
  cfg?: CompileFlashCfg,
): Promise<CompileFlashResult> {
  const supabaseUrl = (cfg?.supabaseUrl ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const anonKey = cfg?.anonKey ?? process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
  const githubUrl = (cfg?.githubUrl ?? process.env.NFF_GITHUB_INTERNAL_URL ?? '').replace(/\/+$/, '');
  const githubSecret = cfg?.githubSecret ?? process.env.NFF_GITHUB_INTERNAL_SECRET ?? '';

  if (!supabaseUrl || !anonKey) return { ok: false, status: 500, error: 'Supabase env is not configured' };
  if (!githubUrl) return { ok: false, status: 500, error: 'NFF_GITHUB_INTERNAL_URL is not configured' };
  if (!githubSecret) return { ok: false, status: 500, error: 'NFF_GITHUB_INTERNAL_SECRET is not configured' };

  const token = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '').trim() : '';
  if (!token) return { ok: false, status: 401, error: 'sign in first (missing bearer token)' };

  const projectId = body.project_id;
  const repo = body.repo_full_name;
  if (typeof projectId !== 'string' || !projectId) return { ok: false, status: 400, error: 'project_id is required' };
  if (typeof repo !== 'string' || !repo.trim()) return { ok: false, status: 400, error: 'repo_full_name is required' };
  const branch =
    typeof body.production_branch === 'string' && body.production_branch.trim()
      ? body.production_branch.trim()
      : 'main';

  // 1) Enforce membership AND enable zero-touch accept in one call: PATCH the project under the
  //    user's JWT (RLS). A non-member gets an empty result → 403. Mirrors provisionBatch.
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

  // 2) Forward to nff-github's /internal/compile-flash (server-side secret). Return the streaming
  //    response verbatim; the caller pipes the ndjson body straight to the browser.
  let upstream: Response;
  try {
    upstream = await fetch(`${githubUrl}/internal/compile-flash`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Fleet-Secret': githubSecret },
      body: JSON.stringify({ repo_full_name: repo.trim(), production_branch: branch, project_id: projectId }),
      signal: AbortSignal.timeout(COMPILE_TIMEOUT_MS),
    });
  } catch (e) {
    if (isTimeoutError(e)) {
      return { ok: false, status: 504, error: `nff-github build timed out after ${COMPILE_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, status: 502, error: `nff-github unreachable: ${(e as Error)?.message ?? e}` };
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return { ok: false, status: 502, error: `nff-github returned ${upstream.status}. ${detail.slice(0, 200)}` };
  }
  return { ok: true, status: 200, upstream };
}
