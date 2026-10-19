// POST /api/devices/crash  { device_id, project_id, scenario }  ->  { ok, response | error }
// Vercel serverless function (prod). Demo-only: injects a crash scenario on a mock device
// via nff-fleet (signed `crash` command). Local `npm run dev` is served by the equivalent
// Vite middleware in vite.config.ts.

import { crashViaFleet } from '../_fleet.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body ?? {});
  const r = await crashViaFleet(body.device_id, body.project_id, body.scenario);
  res.status(r.status).json(r);
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}
