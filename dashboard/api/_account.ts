// Shared server-side helper for the personal-account surface: export my data, delete my account.
// Used by both the Vercel function (api/account.ts, prod) and the Vite dev middleware
// (vite.config.ts), the same way api/_provision.ts backs api/provision.ts.
//
// The two actions deliberately use DIFFERENT privilege levels:
//
//   export — the USER's own JWT against PostgREST. RLS scopes every read to what that user may
//            see, so we never hand-filter by project_id and cannot leak another tenant's fleet.
//
//   delete — the SERVICE ROLE, because only auth.admin.deleteUser() hard-deletes an account.
//            Identity comes solely from the verified JWT (see deleteUserAccount); the endpoint
//            takes no user_id parameter, so one user can never delete another.

import { createClient } from '@supabase/supabase-js';

export interface AccountCfg {
  supabaseUrl?: string;
  anonKey?: string;
  serviceRoleKey?: string;
}

export interface ExportResult {
  ok: boolean;
  status: number;
  error?: string;
  data?: unknown;
}

export interface DeleteResult {
  ok: boolean;
  status: number;
  error?: string;
  /** Projects that block the delete, so the UI can name them. */
  blocking_projects?: { id: string; name: string }[];
}

/** Per-table row cap. Exceeding it sets `truncated` on that table rather than silently dropping rows. */
const EXPORT_ROW_CAP = 5000;

// Node's fetch has no default timeout, so without these a stalled Supabase hangs the function until
// the platform kills it. Both stay under the route's maxDuration (see vercel.json) so we fail with
// a real error rather than an opaque platform 504.
const AUTH_TIMEOUT_MS = 8_000;
// ONE budget for the whole export, shared by every table read, rather than a per-table timeout:
// 19 tables at concurrency 5 is 4 waves, so a per-table deadline would compound to 4x it and could
// blow past the route's maxDuration. A single signal bounds the total no matter how they interleave;
// whatever hasn't finished when it fires is recorded as `skipped` and the user still gets a dump.
const EXPORT_BUDGET_MS = 30_000;

/**
 * Tables pulled into the export. Every one is read under the user's JWT, so RLS decides which
 * rows come back — this list only decides which tables are *attempted*. A table that has been
 * renamed or dropped is recorded under `skipped` instead of failing the whole export.
 */
const EXPORT_TABLES = [
  'projects',
  'project_members',
  'devices',
  'device_telemetry',
  'firmware_versions',
  'crash_reports',
  'ota_jobs',
  'device_groups',
  'device_group_members',
  'deployments',
  'github_connections',
  'agent_messages',
  'agent_tasks',
  'agent_console_entries',
  'agent_config',
  'brain_nodes',
  'chat_sessions',
  'builder_features',
  'feedback',
] as const;

interface Env {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

function readEnv(cfg?: AccountCfg): Env {
  return {
    supabaseUrl: (cfg?.supabaseUrl ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, ''),
    anonKey: cfg?.anonKey ?? process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
    serviceRoleKey: cfg?.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  };
}

function bearer(authorization: unknown): string {
  return typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '').trim() : '';
}

function serviceClient(env: Env) {
  return createClient(env.supabaseUrl, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Gather everything the signed-in user can read, as JSON.
 *
 * Note for the reader of the dump: for a team project the user belongs to but does not own, RLS
 * legitimately returns the whole project's rows. That is data already visible to them in the app.
 */
export async function exportUserData(authorization: unknown, cfg?: AccountCfg): Promise<ExportResult> {
  const env = readEnv(cfg);
  if (!env.supabaseUrl || !env.anonKey) {
    return { ok: false, status: 500, error: 'Supabase env is not configured' };
  }

  const token = bearer(authorization);
  if (!token) return { ok: false, status: 401, error: 'sign in first (missing bearer token)' };

  // Identify the caller from the token itself (also validates it).
  const userRes = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: env.anonKey, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  }).catch(() => null);
  if (!userRes) return { ok: false, status: 502, error: 'auth backend unreachable' };
  if (userRes.status === 401 || userRes.status === 403) {
    return { ok: false, status: 401, error: 'session expired — sign in again' };
  }
  const user = (await userRes.json().catch(() => null)) as
    | { id?: string; email?: string; created_at?: string; user_metadata?: Record<string, unknown> }
    | null;
  if (!user?.id) return { ok: false, status: 401, error: 'could not resolve the signed-in user' };

  const tables: Record<string, unknown[]> = {};
  const truncated: string[] = [];
  const skipped: Record<string, string> = {};

  // One read per table. These are independent, so they run concurrently rather than as 19 serial
  // round-trips — the export was by far the slowest route in the app. Bounded so we don't open 19
  // sockets to PostgREST at once (and so a big table like device_telemetry doesn't have to share
  // bandwidth with every other one).
  const EXPORT_CONCURRENCY = 5;

  // One deadline for all of them (see EXPORT_BUDGET_MS).
  const deadline = AbortSignal.timeout(EXPORT_BUDGET_MS);

  async function readTable(table: string): Promise<void> {
    // limit = cap + 1 so we can tell "exactly at the cap" from "there was more".
    const url = `${env.supabaseUrl}/rest/v1/${table}?select=*&limit=${EXPORT_ROW_CAP + 1}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { apikey: env.anonKey, Authorization: `Bearer ${token}` },
        signal: deadline,
      });
    } catch (e) {
      // A timeout lands here too, and is recorded per-table like any other failure — one slow table
      // degrades to `skipped` instead of hanging the whole export until the platform kills it.
      skipped[table] = `unreachable: ${(e as Error)?.message ?? e}`;
      return;
    }
    if (!res.ok) {
      // A dropped/renamed table (404) or a table with no select policy must not sink the export.
      skipped[table] = `${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
      return;
    }
    const rows = (await res.json().catch(() => null)) as unknown[] | null;
    if (!Array.isArray(rows)) {
      skipped[table] = 'unexpected non-array response';
      return;
    }
    if (rows.length > EXPORT_ROW_CAP) {
      truncated.push(table);
      rows.length = EXPORT_ROW_CAP;
    }
    tables[table] = rows;
  }

  // readTable never rejects — every failure mode is already folded into `skipped` — so a simple
  // worker pool keeps the per-table error isolation the serial loop had.
  const queue = [...EXPORT_TABLES];
  await Promise.all(
    Array.from({ length: Math.min(EXPORT_CONCURRENCY, queue.length) }, async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) await readTable(t);
    }),
  );

  return {
    ok: true,
    status: 200,
    data: {
      exported_at: new Date().toISOString(),
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
        user_metadata: user.user_metadata ?? {},
      },
      note:
        'Rows are scoped by row-level security to what this account can read. Projects shared with ' +
        'you include their team data, which you can already see in the app.',
      row_cap: EXPORT_ROW_CAP,
      truncated_tables: truncated,
      skipped_tables: skipped,
      tables,
    },
  };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Hard-delete the calling user's account.
 *
 * The caller's identity is taken from the verified JWT and nothing else — there is no user_id
 * parameter. The browser holds the anon key, so any id supplied by the client would be
 * attacker-controlled, and the service-role client below bypasses RLS entirely.
 *
 * Two guards run first, both of which MUST use the service-role client:
 *
 *  1. Owned projects that have other members. The `project_members` select policy is
 *     `using (user_id = auth.uid())`, so the same query under the user's own JWT would only ever
 *     see their own membership row — every team project would look solo, the guard would never
 *     fire, and 0042's cascade would quietly destroy the team.
 *  2. Being the last platform admin, which cascades away and leaves the install unadministrable.
 *
 * Past the guards, migration 0042_user_delete_cascade.sql makes the DB cascade clean up the rest.
 */
export async function deleteUserAccount(authorization: unknown, cfg?: AccountCfg): Promise<DeleteResult> {
  const env = readEnv(cfg);
  if (!env.supabaseUrl || !env.serviceRoleKey) {
    return { ok: false, status: 500, error: 'Supabase service-role env is not configured' };
  }

  const token = bearer(authorization);
  if (!token) return { ok: false, status: 401, error: 'sign in first (missing bearer token)' };

  const svc = serviceClient(env);

  // The JWT is the sole source of identity.
  const { data: userData, error: userErr } = await svc.auth.getUser(token);
  const uid = userData?.user?.id;
  if (userErr || !uid) return { ok: false, status: 401, error: 'session expired — sign in again' };

  // Guard 1 — owned projects with at least one other member.
  const { data: owned, error: ownedErr } = await svc
    .from('projects')
    .select('id, name')
    .eq('owner_id', uid);
  if (ownedErr) return { ok: false, status: 502, error: `could not read projects: ${ownedErr.message}` };

  const ownedList = (owned ?? []) as { id: string; name: string }[];
  if (ownedList.length > 0) {
    const { data: others, error: othersErr } = await svc
      .from('project_members')
      .select('project_id')
      .in('project_id', ownedList.map(p => p.id))
      .neq('user_id', uid);
    if (othersErr) {
      return { ok: false, status: 502, error: `could not read project members: ${othersErr.message}` };
    }
    const blockedIds = new Set((others ?? []).map(r => (r as { project_id: string }).project_id));
    if (blockedIds.size > 0) {
      const blocking = ownedList.filter(p => blockedIds.has(p.id));
      const names = blocking.map(p => p.name).join(', ');
      return {
        ok: false,
        status: 409,
        blocking_projects: blocking,
        error:
          `You own ${blocking.length === 1 ? 'a project' : 'projects'} with other members: ${names}. ` +
          'Deleting your account would delete it and evict everyone. Transfer ownership or remove ' +
          'the other members first.',
      };
    }
  }

  // Guard 2 — the last platform admin would cascade away, locking everyone out of admin.
  const { data: admins, error: adminErr } = await svc.from('platform_admins').select('user_id');
  if (adminErr) return { ok: false, status: 502, error: `could not read platform admins: ${adminErr.message}` };
  const adminIds = (admins ?? []).map(r => (r as { user_id: string }).user_id);
  if (adminIds.includes(uid) && adminIds.length === 1) {
    return {
      ok: false,
      status: 409,
      error: 'You are the last platform admin. Promote another admin before deleting your account.',
    };
  }

  const { error: delErr } = await svc.auth.admin.deleteUser(uid);
  if (delErr) return { ok: false, status: 502, error: `delete failed: ${delErr.message}` };

  return { ok: true, status: 200 };
}
