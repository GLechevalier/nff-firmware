import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import type { FirmwareVersion } from '../data/mockFirmwareVersions';

export interface UploadFirmwareOpts {
  version: string;
  name?: string;
  deviceTypes?: string[];
}

function mapRow(row: Record<string, unknown>): FirmwareVersion {
  return {
    version: row.version as string,
    // build_id / branch_name / committed_at / author are nullable: an nff-ota artifact
    // upload need not carry git-build lineage. Default so the (git-oriented) Firmware
    // graph renders such rows on the main spine instead of crashing on null.
    buildId: (row.build_id as string | null) ?? '',
    parentVersion: (row.parent_version as string | null) ?? null,
    mergedInto: (row.merged_into as string | null) ?? undefined,
    branchName: (row.branch_name as string | null) ?? 'main',
    committedAt: new Date((row.committed_at as string | null) ?? (row.created_at as string)),
    author: (row.author as string | null) ?? '',
    changelog: (row.changelog as string | null) ?? '',
    elfStored: row.elf_stored as boolean,
    size: row.size_bytes as number,
    tag: (row.tag as 'latest' | 'stable' | null) ?? undefined,
    deviceCount: 0,
    checksumSha256: (row.checksum_sha256 as string | null) ?? null,
    signature: (row.signature as string | null) ?? null,
    storagePath: (row.storage_path as string | null) ?? null,
    deviceTypes: Array.isArray(row.device_types) ? (row.device_types as string[]) : [],
  };
}

export function useFirmware() {
  const { currentProjectId } = useCurrentProject();
  const [versions, setVersions] = useState<FirmwareVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!currentProjectId) return;
    const { data, error: err } = await supabase
      .from('firmware_versions')
      .select('*')
      .eq('project_id', currentProjectId)
      .order('committed_at', { ascending: false });
    if (err) setError(err.message);
    else setVersions((data ?? []).map(row => mapRow(row as Record<string, unknown>)));
    setLoading(false);
  }, [currentProjectId]);

  useEffect(() => { void reload(); }, [reload]);

  // Upload a firmware artifact (any file) and create its deployable firmware_versions row.
  // The file bytes are POSTed raw to the server-side function, which stores them in the
  // `artifacts` bucket (at the exact path nff-ota signs a download URL for), computes the
  // SHA-256, and upserts the row. On success the firmware list is refreshed.
  async function uploadFirmware(file: File, opts: UploadFirmwareOpts): Promise<void> {
    if (!currentProjectId) throw new Error('no project selected');
    const params = new URLSearchParams({ version: opts.version, project_id: currentProjectId });
    if (opts.name) params.set('name', opts.name);
    if (opts.deviceTypes && opts.deviceTypes.length > 0) {
      params.set('device_types', opts.deviceTypes.join(','));
    }
    const resp = await fetch(`/api/firmware/upload?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    let data: { ok?: boolean; error?: string } = {};
    try { data = await resp.json(); } catch { /* non-JSON body */ }
    if (!resp.ok || !data.ok) {
      throw new Error(data.error ?? `upload failed (${resp.status})`);
    }
    await reload();
  }

  return { versions, loading, error, reload, uploadFirmware };
}
