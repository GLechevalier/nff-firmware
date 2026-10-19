// POST /api/link-token  { project_id }   (Authorization: Bearer <supabase token>)
//   -> { ok: true, url: "wss://.../link?token=..." } | { ok: false, error }
//
// Vercel serverless function (prod) minting a short-lived WS URL for nff-fleet's /link bridge —
// the wired (USB/PPPoS) onboarding data path. Membership enforced in mintLinkToken; the fleet
// secret stays server-side. Local `npm run dev` is served by the equivalent Vite middleware.

import { mintLinkToken } from './_link-token.js';

interface Req {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  status: (code: number) => Res;
  json: (body: unknown) => void;
}

export default async function handler(req: Req, res: Res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  const body: Record<string, unknown> =
    typeof req.body === 'string' ? safeParse(req.body)
    : req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>)
    : {};
  const auth = req.headers['authorization'] ?? req.headers['Authorization'];
  const r = await mintLinkToken(auth, body.project_id, body.dst);
  res.status(r.status).json(r);
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}
