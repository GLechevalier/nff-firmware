// One serverless function for the whole /api/ota/* surface (Vercel Hobby caps 12 functions):
//   POST /api/ota/deploy?version=&group=&project=&name=&device_types=&max_in_flight=&retries=
//     body: raw artifact bytes (Content-Type: application/octet-stream)
//     -> { ok, deployment_id, version, delivered, failed, skipped, start_error | error }
//   GET  /api/ota/status?deployment_id=  -> { ok, deployment, jobs | error }
//   GET  /api/ota/deployments            -> { ok, deployments[], firmware_versions[] | error }
//   GET  /api/ota/devices                -> { ok, data: device[] | error }
// All routes: Authorization: Bearer <supabase JWT>. The user-facing entrypoints the core CLI's
// `nff ota` calls: authenticate the caller, resolve targets under their JWT (RLS proves
// membership), forward to nff-ota. Server-side secrets never reach the client.
// /api/ota/:action reaches here via the vercel.json rewrite (same pattern as demo/github/account).
// Local `npm run dev` is served by the equivalent Vite middleware in vite.config.ts.

import { deployFirmware, deploymentStatus, listDeployments, listDevices } from './_ota.js';

// Read the raw binary body ourselves — JSON body parsing would corrupt the artifact bytes.
export const config = { api: { bodyParser: false } };

export default async function handler(req: any, res: any) {
  const q = req.query ?? {};
  const action = typeof q.action === 'string' ? q.action : '';

  if (action === 'deploy') {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'method not allowed' });
      return;
    }

    const deviceTypes = (typeof q.device_types === 'string' ? q.device_types : '')
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean);
    const num = (v: unknown) => (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
    } catch (e) {
      res.status(400).json({ ok: false, error: `could not read body: ${(e as Error)?.message ?? e}` });
      return;
    }

    const r = await deployFirmware(req.headers['authorization'], Buffer.concat(chunks), {
      version: q.version,
      group: q.group,
      project: q.project,
      name: q.name,
      deviceTypes,
      maxInFlight: num(q.max_in_flight),
      retries: num(q.retries),
    });
    res.status(r.status).json(r.ok ? { ok: true, ...(r.data as object) } : r);
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  if (action === 'status') {
    const deploymentId = typeof q.deployment_id === 'string' && q.deployment_id ? q.deployment_id : null;
    const r = await deploymentStatus(req.headers['authorization'], deploymentId);
    res.status(r.status).json(r.ok ? { ok: true, ...(r.data as object) } : r);
    return;
  }

  if (action === 'deployments') {
    const r = await listDeployments(req.headers['authorization']);
    res.status(r.status).json(r.ok ? { ok: true, ...(r.data as object) } : r);
    return;
  }

  if (action === 'devices') {
    const r = await listDevices(req.headers['authorization']);
    res.status(r.status).json(r.ok ? { ok: true, data: r.data } : r);
    return;
  }

  res.status(404).json({ ok: false, error: `unknown ota action: ${action}` });
}
