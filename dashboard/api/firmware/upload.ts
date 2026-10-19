// POST /api/firmware/upload?version=&project_id=&name=&device_types=
//   body: raw artifact bytes (Content-Type: application/octet-stream)
//   -> { ok, version, storagePath, checksumSha256, sizeBytes | error }
// Vercel serverless function (prod). Holds the service-role key server-side and stores the
// artifact + upserts its firmware_versions row. Local `npm run dev` is served by the
// equivalent Vite middleware in vite.config.ts (Vite doesn't run api/ functions).

import { uploadFirmware } from '../_firmware.js';

// Read the raw binary body ourselves — JSON body parsing would corrupt the artifact bytes.
export const config = { api: { bodyParser: false } };

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  const q = req.query ?? {};
  const deviceTypesRaw = typeof q.device_types === 'string' ? q.device_types : '';
  const deviceTypes = deviceTypesRaw
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);

  const chunks: Buffer[] = [];
  try {
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
  } catch (e) {
    res.status(400).json({ ok: false, error: `could not read body: ${(e as Error)?.message ?? e}` });
    return;
  }
  const bytes = Buffer.concat(chunks);

  const r = await uploadFirmware(bytes, {
    version: q.version,
    projectId: q.project_id,
    name: q.name,
    deviceTypes,
  });
  res.status(r.status).json(r);
}
