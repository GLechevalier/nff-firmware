// POST /api/provision  { project_id }  (Authorization: Bearer <supabase token>)
//   -> { ok, credentials_h, project_id, batch_id, reused | error }
// Vercel serverless function (prod). Same-origin, so the browser flasher calls it without CORS.
// Mints a batch bootstrap credential for the signed-in user's project (membership enforced via
// their JWT) by forwarding to the fleet's /internal/provision-batch with the server-side secret.
// Local `npm run dev` is served by the equivalent Vite middleware in vite.config.ts.

import { provisionBatch } from './_provision.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body ?? {});
  const auth = req.headers['authorization'] ?? req.headers['Authorization'];
  const r = await provisionBatch(auth, body.project_id);
  res.status(r.status).json(r);
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}
