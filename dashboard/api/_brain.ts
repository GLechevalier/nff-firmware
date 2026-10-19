// Per-user brain ingest for nff-app.
//
// This is the ONE piece of the brain that cannot be RLS + direct-Supabase: the
// nff-brain CLI, Chrome extension and VS Code extension authenticate with an
// opaque `x-brain-sync-token`, not a Supabase JWT, so nothing can run as
// `authenticated` and the service role has to resolve the token. Everything
// else the brain does in nff-app (read, layout, author, merge, search, the
// company overlay) is a direct Supabase call under RLS — see migration 0156.
//
// Token → project resolution goes through brain_sync_tokens (migration 0141),
// NEVER employee_brains (0138). employee_brains is nff-admin's vendor registry
// and its project ids point at the vendor's own workspace; that whole table,
// and ADMIN_BRAIN_PROJECT_ID with it, stays on nff-admin's side of the fence.
//
// Ported from nff-admin's handleBrainIngest (api/_lib/brain.ts:859-950) with
// three deliberate deviations, each marked below:
//   1. brain_sync_tokens, not employee_brains
//   2. the delete is scoped to origin='import' — see deleteOwnRowsOnly
//   3. a single-member guard on the home project — see assertSoloHomeProject
//
// ponytail: full replace, no diffing, no retry queue — the same call nff-admin
// made; the extension re-syncs on the next brain change.

import { createHash } from 'node:crypto';
import { getServiceSupabase } from './_supabase.js';

// The service client this module operates through. NonNullable<> of the helper's
// return type, so it tracks _supabase.ts without importing @supabase/supabase-js
// types directly (that package is a devDependency at the api/ layer).
type ServiceClient = NonNullable<ReturnType<typeof getServiceSupabase>>;

// Mirrors @nff-brain/core's CATEGORIES and migration 0138's CHECK constraint.
// Deliberately not imported from core: this shapes a DTO, and keeping the
// serverless bundle dependency-free keeps core out of it (nff-admin's brain.ts
// carries the same hand-maintained mirror for the same reason).
const CATEGORIES = new Set([
  'core', 'analysis', 'rules', 'strategy', 'decision', 'preference', 'task',
]);

const MAX_NODES = 5000;
const CHUNK = 200;

const digest = (t: string) => createHash('sha256').update(t).digest('hex');
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, max: number, d = '') =>
  (typeof v === 'string' && v ? v : d).slice(0, max);

export interface BrainSyncResult {
  status: number;
  body: Record<string, unknown>;
}

const err = (status: number, error: string): BrainSyncResult => ({
  status,
  body: { ok: false, error },
});

/**
 * POST /api/brain/ingest  (ping = false) — full replace of this user's imported brain
 * GET  /api/brain/ping    (ping = true)  — token liveness check, writes nothing
 *
 * The token is valid on these two paths and nowhere else: api/account.ts routes
 * only these two actions here, and vercel.json maps only these two literal
 * sources. (nff-admin has to re-derive and string-compare the path itself,
 * because tables.ts funnels every route through one function.)
 */
export async function brainSync(
  token: unknown,
  ping: boolean,
  body: { nodes?: unknown; edges?: unknown },
  // Injected service client. Prod passes nothing and getServiceSupabase() reads
  // process.env; the Vite dev middleware passes one built from loadEnv(), which
  // never reaches process.env. Same seam as AuthCfg in _auth.ts.
  clientOverride?: ServiceClient | null,
): Promise<BrainSyncResult> {
  if (typeof token !== 'string' || !token) return err(401, 'missing sync token');

  const db = clientOverride ?? getServiceSupabase();
  if (!db) return err(503, 'supabase not configured');

  // ── Deviation 1: brain_sync_tokens (0141), never employee_brains (0138) ──
  const tokenRow = await db
    .from('brain_sync_tokens')
    .select('id,home_project_id')
    .eq('token_hash', digest(token))
    .is('revoked_at', null)
    .maybeSingle();
  if (tokenRow.error) return err(500, tokenRow.error.message);
  if (!tokenRow.data) return err(401, 'invalid sync token');

  if (ping) return { status: 200, body: { ok: true } };

  const projectId = tokenRow.data.home_project_id as string;
  const tokenId = tokenRow.data.id as string;

  const solo = await assertSoloHomeProject(db, projectId);
  if (solo) return solo;

  const rawNodes = Array.isArray(body.nodes) ? body.nodes : [];
  const rawEdges = Array.isArray(body.edges) ? body.edges : [];
  if (rawNodes.length > MAX_NODES) return err(413, `too many nodes (max ${MAX_NODES})`);

  // brain_nodes.id is a GLOBAL text primary key shared by every project, so a
  // pushed id must be namespaced. nff-admin uses 8 hex of the employee uuid
  // (brain.ts:889) — a 32-bit namespace on a global PK, which reaches a ~50%
  // birthday collision around 77k brains and surfaces as a hard insert failure
  // against a stranger's row. Use the whole token-row uuid: same amount of
  // code, no collision. It is stable across token rotation (0141 upserts on
  // conflict (user_id), so `id` survives) and the `u` distinguishes it from
  // nff-admin's `e…` namespace, so the two can never intersect.
  const prefix = `u${tokenId.replace(/-/g, '')}-`;
  const now = new Date().toISOString();

  const rowById = new Map<string, Record<string, unknown>>();
  for (const raw of rawNodes) {
    const n = (raw ?? {}) as Record<string, unknown>;
    if (typeof n.id !== 'string' || !n.id) continue;
    const id = prefix + n.id.slice(0, 80);
    const lastUpdated = typeof n.lastUpdated === 'string' && !Number.isNaN(Date.parse(n.lastUpdated))
      ? n.lastUpdated
      : now;
    rowById.set(id, {
      id,
      title: str(n.title, 80, '(untitled)'),
      category: typeof n.category === 'string' && CATEGORIES.has(n.category) ? n.category : 'strategy',
      color: str(n.color, 32, '#22d3ee'),
      x: num(n.x, 120 + Math.random() * 560),
      y: num(n.y, 100 + Math.random() * 400),
      size: Math.min(48, Math.max(8, num(n.size, 16))),
      last_updated: lastUpdated,
      content: str(n.content, 1200),
      project_id: projectId,
      origin: 'import',
      recall_count: 0,
      // The ONE client-controlled flag preserved: it is the user's opt-in
      // publish decision and the sole input to company_brain_shared_nodes
      // (0141). @nff-brain/core's buildCompanySyncPayload has already dropped
      // every private:true node before this payload was built.
      shared: !!n.shared,
    });
  }

  const edgeByPair = new Map<string, { from_id: string; to_id: string; strength: number }>();
  for (const raw of rawEdges) {
    const e = (raw ?? {}) as Record<string, unknown>;
    if (typeof e.from !== 'string' || typeof e.to !== 'string') continue;
    const from = prefix + e.from.slice(0, 80);
    const to = prefix + e.to.slice(0, 80);
    // Both endpoints must be in this push, or the FK to brain_nodes fails.
    if (from === to || !rowById.has(from) || !rowById.has(to)) continue;
    const strength = Math.min(1, Math.max(0, num(e.strength, 0.5)));
    // brain_edges PK is (from_id, to_id). JSON-joined, not space-joined: a
    // client id may itself contain a space, and "a b"+"c" must not collide
    // with "a"+"b c".
    const key = JSON.stringify([from, to]);
    const prev = edgeByPair.get(key);
    if (!prev || strength > prev.strength) edgeByPair.set(key, { from_id: from, to_id: to, strength });
  }

  const cleared = await deleteOwnRowsOnly(db, projectId);
  if (cleared) return cleared;

  const rows = [...rowById.values()];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await db.from('brain_nodes').insert(rows.slice(i, i + CHUNK));
    if (error) return err(500, error.message);
  }
  const edgeRows = [...edgeByPair.values()];
  for (let i = 0; i < edgeRows.length; i += CHUNK) {
    const { error } = await db.from('brain_edges').insert(edgeRows.slice(i, i + CHUNK));
    if (error) return err(500, error.message);
  }

  await db
    .from('brain_sync_tokens')
    .update({ last_synced_at: now, node_count: rows.length })
    .eq('id', tokenId);

  return { status: 200, body: { ok: true, synced: rows.length, edges: edgeRows.length } };
}

/**
 * Deviation 3. Opt-in publish only holds while the home project is solo.
 *
 * `members select brain_nodes` (0019) exposes EVERY node in a project to every
 * member of it — shared:false included. 0141 points home_project_id at the
 * user's real personal workspace via ensure_personal_project(), which always
 * creates a solo project, so this can only fire if the user later invited
 * someone into it. Refuse the sync rather than silently over-share a brain the
 * user believes is private.
 */
async function assertSoloHomeProject(
  db: ServiceClient,
  projectId: string,
): Promise<BrainSyncResult | null> {
  const { count, error } = await db
    .from('project_members')
    .select('user_id', { count: 'exact', head: true })
    .eq('project_id', projectId);
  if (error) return err(500, error.message);
  if ((count ?? 1) > 1) {
    return err(409, 'your home brain workspace has other members — sync refused');
  }
  return null;
}

/**
 * Deviation 2. Scope the wipe to the rows this endpoint owns.
 *
 * nff-admin's ingest deletes the whole project (brain.ts:934), which is safe
 * there only because an employee brain project is dedicated and member-less
 * (0138). 0141's home_project_id is the user's REAL workspace: it also holds
 * the agent worker's origin:'agent' brain, its seeds, and anything authored in
 * the UI as origin:'seed'. An unqualified delete would wipe all of that on
 * every extension sync.
 *
 * brain_nodes has no CHECK on origin (verified: the origin CHECKs in this
 * schema are on pentester_vuln_tree_nodes), so origin='import' is a stable
 * partition owned solely by this endpoint. Edges cascade via the from_id/to_id
 * FKs (0001 ON DELETE CASCADE).
 */
async function deleteOwnRowsOnly(
  db: ServiceClient,
  projectId: string,
): Promise<BrainSyncResult | null> {
  const { error } = await db
    .from('brain_nodes')
    .delete()
    .eq('project_id', projectId)
    .eq('origin', 'import');
  return error ? err(500, error.message) : null;
}
