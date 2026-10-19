// Shared server-side helper: store a firmware artifact and upsert its firmware_versions
// row so it becomes a deployable OTA target. Used by both the Vercel function
// (api/firmware/upload.ts, prod) and the Vite dev middleware (vite.config.ts, `npm run dev`).
// The service-role key stays server-side — it is never exposed to the browser bundle.
//
// Contract is dictated by nff-ota:
//   • the binary must live at `firmware/{safe_version}.bin` in the `artifacts` bucket, since
//     nff-ota's create_signed_url(version) recomputes that path from the version and ignores
//     the stored storage_path column (see nff-ota/nff_ota/storage.py::_safe_key);
//   • checksum_sha256 must match the bytes (the device hard-fails on mismatch);
//   • the on-wire version (release_version) must be a 3-part semver for the anti-downgrade gate.

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const ARTIFACT_BUCKET = 'artifacts';

export interface UploadMeta {
  version: unknown;
  projectId: unknown;
  name?: unknown;
  deviceTypes?: string[];
}

export interface UploadCfg {
  supabaseUrl?: string;
  serviceRoleKey?: string;
}

export interface UploadResult {
  ok: boolean;
  status: number;        // HTTP status to return to the client
  version?: string;
  storagePath?: string;
  checksumSha256?: string;
  sizeBytes?: number;
  error?: string;
}

// nff-ota's _safe_key: keep [A-Za-z0-9._-], everything else → '_'.
function safeKey(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, '_');
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(v);
}

export async function uploadFirmware(
  bytes: Buffer,
  meta: UploadMeta,
  cfg?: UploadCfg,
): Promise<UploadResult> {
  const supabaseUrl = cfg?.supabaseUrl ?? process.env.VITE_SUPABASE_URL ?? '';
  const serviceRoleKey = cfg?.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!supabaseUrl) return { ok: false, status: 500, error: 'VITE_SUPABASE_URL is not configured' };
  if (!serviceRoleKey) return { ok: false, status: 500, error: 'SUPABASE_SERVICE_ROLE_KEY is not configured' };

  const { version, projectId, name } = meta;
  if (typeof version !== 'string' || !version) {
    return { ok: false, status: 400, error: 'version is required' };
  }
  // The device's anti-downgrade gate compares 3-part semver, so the on-wire version must be one.
  if (!isSemver(version)) {
    return { ok: false, status: 400, error: `version must be 3-part semver (got "${version}")` };
  }
  if (typeof projectId !== 'string' || !projectId) {
    return { ok: false, status: 400, error: 'project_id is required' };
  }
  if (!bytes || bytes.length === 0) {
    return { ok: false, status: 400, error: 'empty artifact' };
  }

  const deviceTypes = meta.deviceTypes && meta.deviceTypes.length > 0 ? meta.deviceTypes : ['esp32'];
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  const sizeBytes = bytes.length;
  const storagePath = `firmware/${safeKey(version)}.bin`;

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Store the binary at the exact path nff-ota will sign a download URL for.
  const up = await supabase.storage
    .from(ARTIFACT_BUCKET)
    .upload(storagePath, bytes, { contentType: 'application/octet-stream', upsert: true });
  if (up.error) {
    return { ok: false, status: 502, error: `storage upload failed: ${up.error.message}` };
  }

  // 2) Upsert the deployable firmware_versions row. version is the global PK; lineage
  // columns (build_id/branch_name/author/committed_at) are nullable and intentionally omitted.
  const { error: dbErr } = await supabase.from('firmware_versions').upsert(
    {
      version,
      name: typeof name === 'string' && name ? name : null,
      device_types: deviceTypes,
      checksum_sha256: checksumSha256,
      size_bytes: sizeBytes,
      storage_path: storagePath,
      release_version: version,
      elf_stored: false,
      project_id: projectId,
    },
    { onConflict: 'version' },
  );
  if (dbErr) {
    return { ok: false, status: 502, error: `firmware_versions upsert failed: ${dbErr.message}` };
  }

  return { ok: true, status: 200, version, storagePath, checksumSha256, sizeBytes };
}
