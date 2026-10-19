import { useState, type ReactNode } from 'react';
import type { Device } from '../../../types/device';
import type { OnQueryClick } from '../../../types/query';
import { Queryable } from '../../../components/squeletton/Queryable';
import { StatusBadge } from './StatusBadge';
import { AgentBadge } from './AgentBadge';
import { formatRelativeTime } from '../../../utils/time';

type SortKey = keyof Device;
type SortDir = 'asc' | 'desc';

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

// A borrowed L2 from the shared pool has an id like `mock-b2b2b2b2-*` that spells out the pool
// project id. The lease overlay aliases the device NAME but not the id, so mask the id column too —
// show the neutral lease alias instead of the raw pool id, keeping the borrow invisible.
const POOL_ID_PREFIX = 'mock-b2b2b2b2';
function displayId(id: string, name: string): string {
  return id.startsWith(POOL_ID_PREFIX) ? name : id;
}

const columns: { key: SortKey; label: string }[] = [
  { key: 'id',              label: 'Device ID' },
  { key: 'name',            label: 'Device' },
  { key: 'status',          label: 'Status' },
  { key: 'firmwareVersion', label: 'Firmware' },
  { key: 'agentConnected',  label: 'Agent' },
  { key: 'lastSeen',        label: 'Last Seen' },
  { key: 'ipAddress',       label: 'IP Address' },
  { key: 'rssi',            label: 'RSSI' },
  { key: 'uptimeSeconds',   label: 'Uptime' },
];

// Inline rename for the "Device" column: shows the name with a ✎ affordance; clicking it
// swaps in a text input that commits on Enter/blur and reverts on Escape. The "Device ID"
// column keeps the immutable id, so the two stay visibly distinct. Only mounted outside
// query mode (where a cell click means "ask about this value", not "edit it").
function EditableName({ device, onRename }: {
  device: Device;
  onRename: (deviceId: string, name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(device.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function begin() {
    setValue(device.name);
    setErr(null);
    setEditing(true);
  }

  async function commit() {
    const next = value.trim();
    if (!next || next === device.name) { setEditing(false); return; }
    setBusy(true);
    try {
      await onRename(device.id, next);
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {device.name}
        <button
          onClick={e => { e.stopPropagation(); begin(); }}
          title="Rename device"
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: '#888', padding: 0, lineHeight: 1 }}
        >
          ✎
        </button>
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} onClick={e => e.stopPropagation()}>
      <input
        autoFocus
        value={value}
        disabled={busy}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') void commit();
          else if (e.key === 'Escape') { setEditing(false); setErr(null); }
        }}
        onBlur={() => void commit()}
        style={{ fontSize: 13, padding: '1px 4px', border: '1px solid #888', width: 140 }}
      />
      {err && <span style={{ color: '#ef4444', fontSize: 10 }} title={err}>!</span>}
    </span>
  );
}

function compareValues(a: Device, b: Device, key: SortKey, dir: SortDir): number {
  const av = a[key];
  const bv = b[key];
  let cmp = 0;
  if (av instanceof Date && bv instanceof Date) {
    cmp = av.getTime() - bv.getTime();
  } else if (typeof av === 'boolean' && typeof bv === 'boolean') {
    cmp = Number(av) - Number(bv);
  } else if (av === null) {
    cmp = 1;
  } else if (bv === null) {
    cmp = -1;
  } else if (typeof av === 'number' && typeof bv === 'number') {
    cmp = av - bv;
  } else {
    cmp = String(av).localeCompare(String(bv));
  }
  return dir === 'asc' ? cmp : -cmp;
}

export function DeviceTable({ devices, onOpenDevice, onRenameDevice, queryMode, onQueryClick }: {
  devices: Device[];
  onOpenDevice?: (device: Device) => void;
  onRenameDevice?: (deviceId: string, name: string) => Promise<void>;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [pinging, setPinging] = useState<string | null>(null);
  const [pingResult, setPingResult] = useState<Record<string, { ok: boolean; text: string }>>({});

  async function handlePing(device: Device) {
    setPinging(device.id);
    try {
      const res = await fetch('/api/devices/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: device.id, project_id: device.projectId }),
      });
      const data = await res.json();
      const ok = res.ok && data.ok;
      const text = ok
        ? `${data.rtt_ms} ms`
        : res.status === 503 ? 'unreachable'   // broken device refused the ping (instant)
        : res.status === 504 ? 'timeout'        // genuine fleet/device round-trip timeout
        : 'failed';
      setPingResult(prev => ({ ...prev, [device.id]: { ok, text } }));
    } catch {
      setPingResult(prev => ({ ...prev, [device.id]: { ok: false, text: 'error' } }));
    } finally {
      setPinging(null);
    }
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const sorted = [...devices].sort((a, b) => compareValues(a, b, sortKey, sortDir));
  const indicator = sortDir === 'asc' ? '↑' : '↓';

  function QCell({ device, field, value, children }: { device: Device; field: string; value: string; children: ReactNode }) {
    return (
      <Queryable
        as="td"
        queryMode={queryMode}
        onQueryClick={onQueryClick}
        field={field}
        value={value}
        device={device}
        style={{ padding: '4px 8px' }}
      >
        {children}
      </Queryable>
    );
  }

  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '2px solid #000' }}>
          {columns.flatMap(col => {
            const th = (
              <th
                key={col.key}
                onClick={() => handleSort(col.key)}
                style={{ textAlign: 'left', cursor: 'pointer', padding: '4px 8px', userSelect: 'none', fontWeight: 'bold', whiteSpace: 'nowrap' }}
              >
                {col.label}
                {sortKey === col.key && <span style={{ marginLeft: 4 }}>{indicator}</span>}
              </th>
            );
            if (col.key === 'status' && onOpenDevice) {
              return [th, <th key="open-header" style={{ padding: '4px 8px' }} />];
            }
            return [th];
          })}
        </tr>
      </thead>
      <tbody>
        {sorted.map(device => (
          <tr key={device.id} style={{ borderBottom: '1px solid #ccc' }}>
            <td style={{ padding: '4px 8px' }}>{displayId(device.id, device.name)}</td>
            <QCell device={device} field="Device Name" value={device.name}>
              {onRenameDevice && !queryMode
                ? <EditableName device={device} onRename={onRenameDevice} />
                : device.name}
            </QCell>
            <QCell device={device} field="Status" value={device.status}><StatusBadge status={device.status} deviceId={device.id} /></QCell>
            {onOpenDevice && (
              <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
                <button
                  onClick={() => onOpenDevice(device)}
                  style={{ background: 'none', border: '1px solid #000', cursor: 'pointer', fontSize: 12, padding: '1px 6px' }}
                  title="View details"
                >
                  →
                </button>
                <button
                  onClick={() => handlePing(device)}
                  disabled={pinging === device.id}
                  style={{ marginLeft: 4, background: 'none', border: '1px solid #000', cursor: 'pointer', fontSize: 12, padding: '1px 6px' }}
                  title="Ping device (round-trip time)"
                >
                  {pinging === device.id ? '…' : 'ping'}
                </button>
                {pingResult[device.id] && (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 11,
                      color: pingResult[device.id].ok ? '#16a34a' : '#dc2626',
                    }}
                  >
                    {pingResult[device.id].text}
                  </span>
                )}
              </td>
            )}
            <QCell device={device} field="Firmware Version" value={device.firmwareVersion}>{device.firmwareVersion}</QCell>
            <td style={{ padding: '4px 8px' }}><AgentBadge connected={device.agentConnected} /></td>
            <QCell device={device} field="Last Seen" value={formatRelativeTime(device.lastSeen)}>{formatRelativeTime(device.lastSeen)}</QCell>
            <QCell device={device} field="IP Address" value={device.ipAddress}>{device.ipAddress}</QCell>
            <QCell device={device} field="RSSI" value={formatRssi(device.rssi)}>{formatRssi(device.rssi)}</QCell>
            <QCell device={device} field="Uptime" value={formatUptime(device.uptimeSeconds)}>{formatUptime(device.uptimeSeconds)}</QCell>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
