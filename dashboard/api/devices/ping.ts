// POST /api/devices/ping  { device_id, project_id }  ->  { ok, rtt_ms, response | error }
// Vercel serverless function (prod). Holds the fleet secret server-side and forwards a
// signed ping through nff-fleet. Local `npm run dev` is served by the equivalent Vite
// middleware in vite.config.ts (Vite doesn't run api/ functions).

import { pingViaFleet } from '../_fleet.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body ?? {});
  const r = await pingViaFleet(body.device_id, body.project_id);
  res.status(r.status).json(r);
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}
