// POST /api/compile-flash  { project_id, repo_full_name, production_branch? }
//   (Authorization: Bearer <supabase token>)
//   -> application/x-ndjson stream: {"keepalive":true}... then a terminal
//      {"ok":true,"segments":[{name,offset,b64}],...} or {"ok":false,"error",...}
//
// Vercel serverless function (prod) backing the Code-tab "Flash (build & enroll)" button. Compiles
// the signed-in user's connected repo (production-branch HEAD) with enrollment injected and streams
// the flashable segment set back. Membership is enforced via the user's JWT in compileFlash; the
// nff-github internal secret stays server-side. Local `npm run dev` is served by the equivalent
// Vite middleware in vite.config.ts.

import { compileFlash } from './_compile-flash.js';

// An ESP32 arduino-cli build (clone + compile) can take well over a minute; give it room.
export const config = { maxDuration: 300 };

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body ?? {});
  const auth = req.headers['authorization'] ?? req.headers['Authorization'];
  const r = await compileFlash(auth, body);
  if (!r.ok) {
    res.status(r.status).json(r);
    return;
  }
  // Pipe the ndjson stream through so keepalives keep the connection warm during the build.
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson');
  const reader = r.upstream.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } catch {
    /* client disconnected or upstream aborted — end the response */
  } finally {
    res.end();
  }
}

function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s); } catch { return {}; }
}
