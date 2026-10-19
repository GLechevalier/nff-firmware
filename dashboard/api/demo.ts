// Consolidated demo serverless function (prod). Vercel's Hobby plan caps a deployment at 12
// Serverless Functions, so the per-action demo routes (mocks, retire, spawn, selfheal,
// seed-fleet) are folded into this single function dispatched on ?action=…. The pretty
// sub-paths /api/demo/<action> are mapped here by explicit rewrites in vercel.json that run
// BEFORE the SPA catch-all — a plain function file (not a dynamic [action] route), because
// dynamic API routes are matched AFTER user rewrites and would be swallowed by /(.*) -> /.
// Client URLs are unchanged, and local `npm run dev` is still served by the equivalent Vite
// middleware in vite.config.ts.
//
// NOTE: every action here leans on dev-compose infra (nff-mock controller / nff-ota / agent
// worker); prod deployment of that infra is deferred, so each degrades gracefully (500) when
// its secret / Supabase service key is unset.
//
//   GET  /api/demo/mocks     ?project_id=…                       -> { ok, mocks | error }
//   POST /api/demo/retire    { device_id }                       -> { ok, removed | error }
//   POST /api/demo/spawn     { project_id, count?, name_prefix? } -> { ok, spawned | error }
//   POST /api/demo/selfheal  { device_id, project_id, scenario } -> { ok, mode, ... | error }
//   POST /api/demo/build     { project_id, session_id }          -> { ok, session_id, feature_title | error }
//   POST /api/demo/seed-fleet { project_id, l1_only? }           -> { ok, target, spawned | error }
//   POST /api/demo/presence  { project_id }                      -> { ok }  (L1 keep-alive)

import { listMocks, deleteMock, spawnMocks, seedFleet, markPresence } from './_mock.js';
import { selfHeal, poolPresencePing } from './_selfheal.js';
import { buildFeature } from './_build.js';

export default async function handler(req: any, res: any) {
  const action = String(req.query?.action ?? '');
  const method = req.method;

  switch (action) {
    case 'mocks': {
      if (method !== 'GET') return methodNotAllowed(res);
      const projectId = req.query?.project_id ?? '';
      const r = await listMocks(projectId);
      // The ONLY cacheable action here — everything else mutates. Keyed by ?project_id= (the CDN
      // includes the query in the cache key) and holds no user-specific data beyond that id, so
      // `public` is sound. Kept deliberately SHORT: this list is the live fleet, and a spawn/
      // retire must show up promptly. 5s is enough to absorb the poll fan-in without the user
      // ever noticing lag; errors are never cached.
      cacheable(res, r.ok, 5, 10);
      return res.status(r.status).json(r);
    }
    case 'retire': {
      if (method !== 'POST') return methodNotAllowed(res);
      const body = parseBody(req);
      const deviceId = body.device_id;
      // Defensive: the controller also restricts teardown to 'mock-' ids, but reject early.
      if (typeof deviceId !== 'string' || !deviceId.startsWith('mock-')) {
        res.status(400).json({ ok: false, error: "a 'mock-' device_id is required" });
        return;
      }
      const r = await deleteMock(deviceId);
      return res.status(r.status).json(r);
    }
    case 'spawn': {
      if (method !== 'POST') return methodNotAllowed(res);
      const body = parseBody(req);
      const count = typeof body.count === 'number' ? body.count : undefined;
      const namePrefix = typeof body.name_prefix === 'string' ? body.name_prefix : undefined;
      const r = await spawnMocks(body.project_id, { count, namePrefix });
      return res.status(r.status).json(r);
    }
    case 'selfheal': {
      if (method !== 'POST') return methodNotAllowed(res);
      const body = parseBody(req);
      const r = await selfHeal(body.device_id, body.project_id, body.scenario, body.request_key);
      return res.status(r.status).json(r);
    }
    case 'build': {
      // Develop-a-feature DEMO: autonomously plan + build + validate ONE prechosen feature
      // (Low-battery alert) on a mock canary. Inserts an engineered agent_messages row into the
      // caller's builder session; the worker picks it up over Realtime. See api/_build.ts.
      if (method !== 'POST') return methodNotAllowed(res);
      const body = parseBody(req);
      const r = await buildFeature(body.project_id, body.session_id);
      return res.status(r.status).json(r);
    }
    case 'seed-fleet': {
      if (method !== 'POST') return methodNotAllowed(res);
      const body = parseBody(req);
      // `l1_only` is the recurring keep-alive top-up (backstop for a crashed L1). L2 is a scarce
      // shared resource seeded once on the full first pass and released when idle, so the interval
      // never re-spawns it (l2: 0 → deficit <= 0 → no-op).
      // L2 defaults to 0: demo projects seed NO own (heavy QEMU) L2s — every L2 self-heal borrows
      // one from the shared pool (migration 0075/0076) for the few minutes a cycle needs it. Set
      // NFF_DEMO_SEED_L2>0 only to intentionally give a project its own dedicated L2s.
      const target = {
        l1: intEnv(process.env.NFF_DEMO_SEED_L1, 8),
        l2: body.l1_only === true ? 0 : intEnv(process.env.NFF_DEMO_SEED_L2, 0),
      };
      const r = await seedFleet(body.project_id, target);
      return res.status(r.status).json(r);
    }
    case 'presence': {
      // Keep-alive heartbeat: mark the demo project 'user online' so the controller never
      // TTL-reaps its Level-1 mocks while the tab is open.
      if (method !== 'POST') return methodNotAllowed(res);
      const body = parseBody(req);
      // Two presence sinks on the same tick: the controller (keeps L1 mocks alive) and the
      // Postgres l2_pool_presence table (feeds the L2 fair-share cap). Both best-effort.
      const [r] = await Promise.all([markPresence(body.project_id), poolPresencePing(body.project_id)]);
      return res.status(r.status).json(r);
    }
    default:
      res.status(404).json({ ok: false, error: `unknown demo action: ${action}` });
      return;
  }
}

function methodNotAllowed(res: any) {
  res.status(405).json({ ok: false, error: 'method not allowed' });
}

// Edge-cache a read-only GET. `max-age=0` confines it to the SHARED cache (a bare `public` with
// no freshness is heuristically cacheable in the browser, which could pin a stale fleet list in
// one tab). Errors get `no-store` — a 502 from a briefly-down controller must not be pinned.
function cacheable(res: any, ok: boolean, sMaxAge: number, swr: number) {
  if (!ok) {
    res.setHeader('Cache-Control', 'no-store');
    return;
  }
  res.setHeader(
    'Cache-Control',
    `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`,
  );
}

function intEnv(v: string | undefined, dflt: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}

function parseBody(req: any): Record<string, unknown> {
  const b = req.body;
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { return {}; }
  }
  return b ?? {};
}
