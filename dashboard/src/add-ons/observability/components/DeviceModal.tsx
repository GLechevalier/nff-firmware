import type React from 'react';
import { useEffect, useState } from 'react';
import { BRAND_ACCENT } from '../../../lib/brand';
import type { Device, OtaEnrollmentStatus } from '../../../types/device';
import { StatusBadge } from './StatusBadge';
import { Queryable } from '../../../components/squeletton/Queryable';
import type { OnQueryClick } from '../../../types/query';
import { formatRelativeTime } from '../../../utils/time';

const OTA_STATUS_COLOR: Record<OtaEnrollmentStatus, string> = {
  pending:        '#d97706',
  preauthorized:  '#1d4ed8',
  accepted:       '#22c55e',
  rejected:       '#ef4444',
  decommissioned: '#6b7280',
};

function formatUptime(seconds: number): string {
  if (seconds === 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatRssi(rssi: number | null): string {
  if (rssi === null) return 'Wired';
  return `${rssi} dBm`;
}

function Field({
  label, value, queryValue, device, queryMode, onQueryClick,
}: {
  label: string;
  value: React.ReactNode;
  // Raw string handed to the agent when query mode is on. Omit to leave the row un-queryable.
  queryValue?: string | null;
  device?: Device;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '4px 0', borderBottom: '1px solid #eee', fontSize: 13 }}>
      <span style={{ width: 110, flexShrink: 0, color: '#666' }}>{label}</span>
      <Queryable
        queryMode={queryMode} onQueryClick={onQueryClick}
        field={label} value={queryValue} device={device}
        as="span"
      >
        {value}
      </Queryable>
    </div>
  );
}

interface DeviceModalProps {
  device: Device;
  onClose: () => void;
  onSetTags: (tags: string[]) => Promise<void>;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}

export function DeviceModal({ device, onClose, onSetTags, queryMode, onQueryClick }: DeviceModalProps) {
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function commitTags(tags: string[]) {
    setBusy(true);
    setErr(null);
    try {
      await onSetTags(tags);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addTag() {
    const t = tagInput.trim();
    if (!t || device.tags.includes(t)) { setTagInput(''); return; }
    setTagInput('');
    await commitTags([...device.tags, t]);
  }

  async function removeTag(tag: string) {
    await commitTags(device.tags.filter(t => t !== tag));
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 380, maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto',
          background: '#fff', border: '1.5px solid #000', boxShadow: '4px 4px 0 #000',
          display: 'flex', flexDirection: 'column', fontSize: 12,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderBottom: '1px solid #000', background: BRAND_ACCENT, color: '#fff' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <StatusBadge status={device.status} deviceId={device.id} />
            <strong style={{ letterSpacing: 0.3 }}>{device.name}</strong>
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>×</button>
        </div>

        <div style={{ padding: '10px 12px' }}>
          {(() => {
            const firmwareText = device.currentFirmwareVersion && device.currentFirmwareVersion !== device.firmwareVersion
              ? `${device.firmwareVersion} → ${device.currentFirmwareVersion}`
              : device.firmwareVersion;
            const q = { device, queryMode, onQueryClick };
            return (
              <>
                <Field label="Device ID" value={device.id} queryValue={device.id} {...q} />
                <Field
                  label="Enrollment"
                  value={<span style={{ color: OTA_STATUS_COLOR[device.otaStatus], fontWeight: 'bold', textTransform: 'capitalize' }}>{device.otaStatus}</span>}
                  queryValue={device.otaStatus}
                  {...q}
                />
                <Field
                  label="Connectivity"
                  value={<span style={{ textTransform: 'capitalize' }}>{device.status}</span>}
                  queryValue={device.status}
                  {...q}
                />
                <Field label="Firmware" value={firmwareText} queryValue={firmwareText} {...q} />
                <Field label="Agent" value={device.agentConnected ? 'Connected' : '—'} queryValue={device.agentConnected ? 'Connected' : null} {...q} />
                <Field label="IP Address" value={device.ipAddress || '—'} queryValue={device.ipAddress || null} {...q} />
                <Field label="RSSI" value={formatRssi(device.rssi)} queryValue={formatRssi(device.rssi)} {...q} />
                <Field label="Uptime" value={formatUptime(device.uptimeSeconds)} queryValue={device.uptimeSeconds > 0 ? formatUptime(device.uptimeSeconds) : null} {...q} />
                <Field label="Last Seen" value={formatRelativeTime(device.lastSeen)} queryValue={formatRelativeTime(device.lastSeen)} {...q} />
              </>
            );
          })()}

          {/* Tags / group signal */}
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 'bold', color: '#666', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Tags / Group
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {device.tags.length === 0 && <span style={{ color: '#aaa', fontSize: 11 }}>no tags</span>}
              {device.tags.map(tag => (
                <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid #000', background: '#f4f4f4', padding: '1px 4px 1px 6px', fontSize: 11 }}>
                  <Queryable
                    queryMode={queryMode} onQueryClick={onQueryClick}
                    field="Tag" value={tag} device={device} as="span"
                  >
                    {tag}
                  </Queryable>
                  <button
                    onClick={() => void removeTag(tag)}
                    disabled={busy}
                    style={{ border: 'none', background: 'none', cursor: busy ? 'default' : 'pointer', fontSize: 12, lineHeight: 1, padding: 0, color: '#666' }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void addTag(); }}
                placeholder="add tag"
                disabled={busy}
                style={{ flex: 1, fontSize: 12, padding: '3px 6px', border: '1px solid #000' }}
              />
              <button
                onClick={() => void addTag()}
                disabled={busy}
                style={{ fontSize: 12, fontWeight: 'bold', border: '1px solid #000', background: BRAND_ACCENT, color: '#fff', cursor: busy ? 'default' : 'pointer', padding: '2px 10px', opacity: busy ? 0.5 : 1 }}
              >
                +
              </button>
            </div>
            {err && <div style={{ marginTop: 6, fontSize: 11, color: '#ef4444' }}>{err}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
