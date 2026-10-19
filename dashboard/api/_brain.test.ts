// Unit checks for the per-user brain ingest (api/_brain.ts).
//
// The client is stubbed, so this runs in CI with no database. What it actually
// guards is the handful of things that would be silent, expensive mistakes:
//
//   * the delete is scoped to origin='import' — an unscoped project-wide wipe
//     (which is what nff-admin's ingest does, safely, because ITS projects are
//     dedicated) would destroy the agent worker's brain in the user's real
//     personal workspace on every extension sync
//   * node ids carry the FULL token uuid — brain_nodes.id is a global PK, and
//     an 8-hex namespace collides against strangers' rows
//   * the solo-home-project guard fires BEFORE anything is written
//   * origin/project_id are server-set and `shared` is the only client flag kept

import { describe, expect, it } from 'vitest';
import { brainSync } from './_brain';

const TOKEN = 'test-token';
// sha256('test-token'), the value the handler looks up by.
const TOKEN_HASH = 'e2b6a49b7e0b1b7d24c1a3f1d90d4dd3ad4b5f0d2f6b1b0b4c5a5f0a1c2d3e4f';
const TOKEN_ID = '11111111-2222-4333-8444-555555555555';
const HOME_PROJECT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

interface Call { table: string; op: string; args: unknown[]; filters: [string, unknown][] }

/**
 * Minimal stand-in for the supabase-js query builder: every method returns the
 * same chainable object, which is also a thenable so `await` resolves it.
 */
function stubClient(opts: { tokenRow?: unknown; memberCount?: number } = {}) {
  const { tokenRow = { id: TOKEN_ID, home_project_id: HOME_PROJECT }, memberCount = 1 } = opts;
  const calls: Call[] = [];

  const make = (table: string) => {
    const call: Call = { table, op: '', args: [], filters: [] };
    const chain: Record<string, unknown> = {
      select(...a: unknown[]) { call.op ||= 'select'; call.args = a; return chain; },
      insert(...a: unknown[]) { call.op = 'insert'; call.args = a; calls.push(call); return chain; },
      update(...a: unknown[]) { call.op = 'update'; call.args = a; calls.push(call); return chain; },
      delete() { call.op = 'delete'; calls.push(call); return chain; },
      eq(c: string, v: unknown) { call.filters.push([c, v]); return chain; },
      is(c: string, v: unknown) { call.filters.push([c, v]); return chain; },
      maybeSingle() {
        calls.push(call);
        return Promise.resolve({ data: tokenRow, error: null });
      },
      // `await builder` — used by the head/count query and by insert/update/delete.
      then(resolve: (v: unknown) => unknown) {
        if (call.op === 'select' && !calls.includes(call)) calls.push(call);
        return Promise.resolve({ data: null, error: null, count: memberCount }).then(resolve);
      },
    };
    return chain;
  };

  return { client: { from: (t: string) => make(t) } as never, calls };
}

const node = (over: Record<string, unknown> = {}) => ({
  id: 'n1', title: 'Title', category: 'rules', content: 'body', ...over,
});

describe('brainSync — auth', () => {
  it('rejects a missing token without touching the database', async () => {
    const { client, calls } = stubClient();
    const r = await brainSync(undefined, false, {}, client);
    expect(r.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('rejects an unknown token', async () => {
    const { client } = stubClient({ tokenRow: null });
    const r = await brainSync(TOKEN, false, { nodes: [node()] }, client);
    expect(r.status).toBe(401);
  });

  it('looks the token up by hash, never by the raw value', async () => {
    const { client, calls } = stubClient();
    await brainSync(TOKEN, true, {}, client);
    const lookup = calls.find((c) => c.table === 'brain_sync_tokens');
    const hashFilter = lookup?.filters.find(([c]) => c === 'token_hash');
    expect(hashFilter?.[1]).not.toBe(TOKEN);
    expect(String(hashFilter?.[1])).toMatch(/^[0-9a-f]{64}$/);
    // and only live tokens resolve
    expect(lookup?.filters).toContainEqual(['revoked_at', null]);
  });

  it('ping writes nothing', async () => {
    const { client, calls } = stubClient();
    const r = await brainSync(TOKEN, true, {}, client);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(calls.filter((c) => c.op !== 'select')).toHaveLength(0);
  });
});

describe('brainSync — the delete must not eat the agent brain', () => {
  it('scopes the wipe to this project AND origin=import', async () => {
    const { client, calls } = stubClient();
    await brainSync(TOKEN, false, { nodes: [node()] }, client);
    const del = calls.find((c) => c.op === 'delete');
    expect(del?.table).toBe('brain_nodes');
    expect(del?.filters).toEqual([
      ['project_id', HOME_PROJECT],
      ['origin', 'import'],
    ]);
  });

  it('refuses to sync into a home project with other members, before any write', async () => {
    const { client, calls } = stubClient({ memberCount: 2 });
    const r = await brainSync(TOKEN, false, { nodes: [node()] }, client);
    expect(r.status).toBe(409);
    expect(calls.some((c) => ['delete', 'insert', 'update'].includes(c.op))).toBe(false);
  });
});

describe('brainSync — clamping and namespacing', () => {
  const run = async (body: Record<string, unknown>) => {
    const { client, calls } = stubClient();
    const r = await brainSync(TOKEN, false, body, client);
    const rows = (calls.find((c) => c.table === 'brain_nodes' && c.op === 'insert')
      ?.args[0] ?? []) as Record<string, unknown>[];
    const edges = (calls.find((c) => c.table === 'brain_edges' && c.op === 'insert')
      ?.args[0] ?? []) as Record<string, unknown>[];
    return { r, rows, edges };
  };

  it('prefixes ids with the full token uuid, not a truncated hash', async () => {
    const { rows } = await run({ nodes: [node()] });
    const expected = `u${TOKEN_ID.replace(/-/g, '')}-n1`;
    expect(rows[0].id).toBe(expected);
    // 32 hex of namespace, so two users can never collide on the global PK
    expect(String(rows[0].id)).toMatch(/^u[0-9a-f]{32}-/);
  });

  it('server-sets origin and project_id, and ignores a client attempt to set them', async () => {
    const { rows } = await run({
      nodes: [node({ origin: 'agent', project_id: 'somewhere-else', recall_count: 99 })],
    });
    expect(rows[0].origin).toBe('import');
    expect(rows[0].project_id).toBe(HOME_PROJECT);
    expect(rows[0].recall_count).toBe(0);
  });

  it('preserves shared — the one client-controlled flag', async () => {
    const { rows } = await run({ nodes: [node({ shared: true }), node({ id: 'n2' })] });
    expect(rows[0].shared).toBe(true);
    expect(rows[1].shared).toBe(false);
  });

  it('clamps title, content, size and falls back on an unknown category', async () => {
    const { rows } = await run({
      nodes: [node({ title: 'T'.repeat(200), content: 'c'.repeat(5000), size: 999, category: 'nope' })],
    });
    expect(String(rows[0].title)).toHaveLength(80);
    expect(String(rows[0].content)).toHaveLength(1200);
    expect(rows[0].size).toBe(48);
    expect(rows[0].category).toBe('strategy');
  });

  it('rejects an oversized push rather than truncating it', async () => {
    const nodes = Array.from({ length: 5001 }, (_, i) => node({ id: `n${i}` }));
    const { r } = await run({ nodes });
    expect(r.status).toBe(413);
  });

  it('drops edges with a missing endpoint, self-loops, and dedupes keeping max strength', async () => {
    const { edges } = await run({
      nodes: [node({ id: 'a' }), node({ id: 'b' })],
      edges: [
        { from: 'a', to: 'b', strength: 0.3 },
        { from: 'a', to: 'b', strength: 0.9 },   // dedupe → 0.9 wins
        { from: 'a', to: 'ghost', strength: 1 }, // endpoint not in the push → FK would fail
        { from: 'a', to: 'a', strength: 1 },     // self-loop
      ],
    });
    expect(edges).toHaveLength(1);
    expect(edges[0].strength).toBe(0.9);
  });

  it('reports what it wrote', async () => {
    const { r } = await run({
      nodes: [node({ id: 'a' }), node({ id: 'b' })],
      edges: [{ from: 'a', to: 'b', strength: 0.5 }],
    });
    expect(r.body).toMatchObject({ ok: true, synced: 2, edges: 1 });
  });
});

// Keeps the unused-constant lint quiet while documenting the fixture's intent.
void TOKEN_HASH;
