import type React from 'react';
import { useMemo, useState } from 'react';
import { BRAND_ACCENT } from '../../../lib/brand';
import type { FirmwareVersion } from '../data/mockFirmwareVersions';
import type { DeviceGroup } from '../types/ota';

/**
 * "Trigger an update to group X" — the payoff of the Deploy walkthrough.
 *
 * A brand-new project has no deployable firmware: seed_demo_project inserts its
 * firmware_versions rows `on conflict (version) do nothing` against a GLOBAL version PK, so
 * only the first demo project ever created got them — and those rows carry no checksum or
 * storage_path anyway, which nff-ota rejects at delivery. So for a fleet of simulated
 * devices we mint a deployable release here from synthetic bytes: nff-ota hashes exactly the
 * bytes we upload and ships that digest, so a mock's SHA-256 check passes by construction
 * (the same trick nff-builder's canary deploy uses).
 *
 * That is only safe for mocks. A group holding real hardware would be flashed with garbage,
 * so there we insist on a real, already-uploaded artifact.
 */

const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 9999,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const panel: React.CSSProperties = {
  width: 420, maxWidth: '92vw',
  background: '#fff', border: '1px solid #000', boxShadow: '4px 4px 0 #000',
  boxSizing: 'border-box',
};

const header: React.CSSProperties = {
  background: BRAND_ACCENT, color: '#fff', padding: '6px 10px',
  fontSize: 12, fontWeight: 'bold',
};

const label: React.CSSProperties = { fontSize: 11, color: '#666', display: 'block', marginBottom: 3 };
const field: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', fontSize: 12,
  padding: '4px 6px', border: '1px solid #000', background: '#fff',
};

const baseBtn: React.CSSProperties = {
  fontSize: 11, fontWeight: 'bold',
  padding: '5px 12px', border: '1px solid #000', cursor: 'pointer',
};
const primaryBtn: React.CSSProperties = { ...baseBtn, background: BRAND_ACCENT, color: '#fff' };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: '#fff', color: '#000' };
const disabledBtn: React.CSSProperties = {
  ...baseBtn, background: '#eee', color: '#999', borderColor: '#ccc', cursor: 'not-allowed',
};

// nff classifies a device id prefixed `mock-` as simulated (cf. nff-builder canary/ops.py).
const isMock = (deviceId: string) => deviceId.startsWith('mock-');

/**
 * A 3-part numeric semver (what the device's anti-downgrade gate and /api/firmware/upload
 * both demand) that no other project will mint. `firmware_versions.version` is a GLOBAL
 * primary key and the upload upserts on it, so a colliding version would silently rewrite
 * another tenant's row: derive the middle field from the project id to make that impossible.
 */
function syntheticVersion(projectId: string): string {
  const slot = parseInt(projectId.replace(/-/g, '').slice(0, 8), 16);
  const stamp = Math.floor(Date.now() / 1000) % 1_000_000;
  return `0.${slot}.${stamp}`;
}

interface Props {
  groups: DeviceGroup[];
  versions: FirmwareVersion[];
  projectId: string;
  /** Preselect the group the user just made (the walkthrough's whole point). */
  initialGroupId?: string;
  onClose: () => void;
  /** Fired only when a rollout was actually created — the walkthrough's "the user shipped" proof. */
  onShipped?: (deploymentId: string) => void;
  uploadFirmware: (file: File, opts: { version: string; name?: string; deviceTypes?: string[] }) => Promise<void>;
  createDeployment: (opts: {
    name: string; targetVersion: string; deviceGroupId: string; maxDevicesInFlight?: number;
  }) => Promise<string>;
}

export function TriggerUpdateModal({
  groups, versions, projectId, initialGroupId, onClose, onShipped, uploadFirmware, createDeployment,
}: Props) {
  const [groupId, setGroupId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Groups can still be loading on open, so resolve against whatever has arrived: the user's
  // explicit pick, else the group the walkthrough just had them create, else the newest.
  const group =
    groups.find(g => g.id === groupId) ??
    groups.find(g => g.id === initialGroupId) ??
    groups[0] ?? null;

  // Only firmware with an uploaded artifact can actually be delivered — nff-ota's _deliver_wave
  // rejects a row with no checksum/storage_path (which is exactly what the demo seed leaves behind).
  const deployable = useMemo(
    () => versions.filter(v => v.checksumSha256 && v.storagePath),
    [versions],
  );

  const empty = !group || group.memberIds.length === 0;
  const mockOnly = !!group && group.memberIds.length > 0 && group.memberIds.every(isMock);
  // Real hardware must be sent a real binary; mocks can be handed synthetic bytes.
  const needsRealArtifact = !!group && !mockOnly;

  // Firmware may still be loading when the modal opens, so fall back to the newest deployable
  // release rather than pinning an empty selection.
  const [versionId, setVersionId] = useState('');
  const chosen = deployable.find(v => v.version === versionId) ?? deployable[0] ?? null;

  const blocked =
    busy || !group || empty || (needsRealArtifact && !chosen);

  async function trigger() {
    if (!group) return;
    setBusy(true);
    setErr(null);
    try {
      let targetVersion: string;
      if (needsRealArtifact) {
        if (!chosen) throw new Error('pick a firmware version');
        targetVersion = chosen.version;
      } else {
        // Mint a deployable release for the mocks. /api/firmware/upload is service-role and
        // stamps project_id + checksum_sha256 + storage_path, which the seeded rows lack.
        targetVersion = syntheticVersion(projectId);
        const body = `nff demo release ${targetVersion} for ${group.name}\n`;
        const file = new File([body], `${targetVersion}.bin`, { type: 'application/octet-stream' });
        await uploadFirmware(file, { version: targetVersion, name: `Demo release for ${group.name}` });
      }

      const deploymentId = await createDeployment({
        name: `OTA ${targetVersion} → ${group.name}`,
        targetVersion,
        deviceGroupId: group.id,
        maxDevicesInFlight: 10,
      });
      onShipped?.(deploymentId);
      onClose();
    } catch (e) {
      // Surface the upload/deploy 4xx rather than swallowing it — a silent no-op here would
      // strand the user on a walkthrough step that waits for a deployment that never lands.
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div style={backdrop} onClick={busy ? undefined : onClose}>
      <div style={panel} onClick={e => e.stopPropagation()}>
        <div style={header}>Trigger an update</div>

        <div style={{ padding: '12px 12px 4px', fontSize: 12, color: '#333', lineHeight: 1.6 }}>
          Roll a new firmware release out to every device in a group. Each one downloads it,
          verifies the checksum, installs, and reboots — you'll watch it happen.
        </div>

        <div style={{ padding: '8px 12px 0' }}>
          <label style={label}>Target group</label>
          <select
            value={group?.id ?? ''}
            onChange={e => setGroupId(e.target.value)}
            disabled={busy}
            style={field}
          >
            {groups.length === 0 && <option value="">no groups yet</option>}
            {groups.map(g => (
              <option key={g.id} value={g.id}>
                {g.name} ({g.memberCount} {g.memberCount === 1 ? 'device' : 'devices'})
              </option>
            ))}
          </select>
        </div>

        {needsRealArtifact && (
          <div style={{ padding: '8px 12px 0' }}>
            <label style={label}>Firmware</label>
            <select
              value={chosen?.version ?? ''}
              onChange={e => setVersionId(e.target.value)}
              disabled={busy}
              style={field}
            >
              {deployable.length === 0 && <option value="">no uploaded firmware</option>}
              {deployable.map(v => <option key={v.version} value={v.version}>v{v.version}</option>)}
            </select>
          </div>
        )}

        <div style={{ padding: '10px 12px 0', fontSize: 11, lineHeight: 1.6, color: '#666' }}>
          {empty && (
            <span style={{ color: '#ef4444' }}>
              “{group?.name ?? 'This group'}” has no devices yet. Add some on the Groups tab first.
            </span>
          )}
          {!empty && mockOnly && (
            <>Every device in <b>{group!.name}</b> is simulated, so nff will build a demo
            release for this rollout. Nothing is flashed to real hardware.</>
          )}
          {!empty && needsRealArtifact && deployable.length === 0 && (
            <span style={{ color: '#ef4444' }}>
              <b>{group!.name}</b> contains real hardware. Upload a firmware binary on the
              Releases tab before rolling one out to it.
            </span>
          )}
          {!empty && needsRealArtifact && deployable.length > 0 && (
            <><b>{group!.name}</b> contains real hardware — it will be flashed with the
            firmware you pick above.</>
          )}
        </div>

        {err && (
          <div style={{ padding: '8px 12px 0', fontSize: 11, color: '#ef4444', wordBreak: 'break-word' }}>
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '12px' }}>
          <button onClick={onClose} disabled={busy} style={busy ? disabledBtn : ghostBtn}>Cancel</button>
          <button onClick={trigger} disabled={blocked} style={blocked ? disabledBtn : primaryBtn}>
            {busy ? 'Shipping…' : `Trigger update${group ? ` → ${group.name}` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
