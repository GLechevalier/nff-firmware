import type React from 'react';
import { useMemo, useRef, useState } from 'react';
import type { Device } from '../../../types/device';
import type { OnQueryClick } from '../../../types/query';
import { Queryable } from '../../../components/squeletton/Queryable';
import { StatusBadge } from './StatusBadge';
import { ConsolePanel, type ConsoleEntry } from '../../../components/squeletton/ConsolePanel';
import { formatRelativeTime } from '../../../utils/time';
import { useDeviceTelemetry } from '../hooks/useDeviceTelemetry';
import { useWiredConsole, useWiredLinkDeviceId, useWiredLinkState } from '../hooks/useWiredLink';
import { clearConsole } from '../../../lib/ppplink/linkStore';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import { CRASH_SCENARIOS } from '../lib/crashScenarios';

// A serial line that names a fault (esp-idf error tag, mbedtls code, panic, …) renders as 'error'.
const SERIAL_ERROR_RE = /\bE \(|\berror\b|fail|mbedtls|-0x|panic|abort|assert|rst:0x/i;

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

// Flash size arrives in bytes from the heartbeat; show it as MB/KB.
function formatFlash(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

interface FieldProps {
  label: string;
  value: React.ReactNode;
  fieldKey?: string;
  rawValue?: string;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
  device?: Device;
}

function Field({ label, value, fieldKey, rawValue, queryMode, onQueryClick, device }: FieldProps) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '4px 0', borderBottom: '1px solid #eee', fontSize: 13 }}>
      <span style={{ width: 130, flexShrink: 0, color: '#666' }}>{label}</span>
      <Queryable
        as="span"
        queryMode={queryMode}
        onQueryClick={onQueryClick}
        field={fieldKey ?? label}
        value={rawValue}
        device={device}
        style={{ padding: '0 2px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        {value}
      </Queryable>
    </div>
  );
}

function DeviceNameHeader({ device, queryMode, onQueryClick }: { device: Device; queryMode?: boolean; onQueryClick?: OnQueryClick }) {
  return (
    <Queryable
      as="div"
      queryMode={queryMode}
      onQueryClick={onQueryClick}
      field="Device Name"
      value={device.name}
      device={device}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 16, padding: '2px 4px' }}
    >
      <StatusBadge status={device.status} deviceId={device.id} />
      <strong style={{ fontSize: 15 }}>{device.name}</strong>
    </Queryable>
  );
}


interface DeviceDetailTabProps {
  device: Device;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
  isMobile?: boolean;
}

export function DeviceDetailTab({ device, queryMode, onQueryClick, isMobile }: DeviceDetailTabProps) {
  const [splitPct, setSplitPct]   = useState(38);
  const [dragging, setDragging]   = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'info' | 'signals'>('info');
  const [rightTab, setRightTab]   = useState<'signals' | 'serial'>('signals');
  const containerRef              = useRef<HTMLDivElement>(null);
  const { entries, loading: telemetryLoading } = useDeviceTelemetry(device.id);
  const { currentProjectId }      = useCurrentProject();

  // Serial Monitor: the device's live serial console, carried over the wired PPP link (0xC0FF
  // frames) and demuxed into the linkStore ring-buffer. Available only while a wired link is up,
  // and (when known) only for the device it's attached to.
  const linkState    = useWiredLinkState();
  const linkDeviceId = useWiredLinkDeviceId();
  const serialLines  = useWiredConsole();
  const wiredActive     = linkState !== null && linkState !== 'closed' && linkState !== 'error';
  const serialAvailable = wiredActive && (linkDeviceId === null || linkDeviceId === device.id);
  const serialEntries: ConsoleEntry[] = useMemo(() => {
    if (serialLines.length === 0) {
      return [{ id: 'serial-empty', type: 'info',
        content: wiredActive ? 'Waiting for device serial output…' : 'No wired link to this device.',
        timestamp: new Date() }];
    }
    return serialLines.map((line, i) => ({
      id: `serial-${i}`,
      type: SERIAL_ERROR_RE.test(line) ? 'error' : 'output',
      content: line,
      timestamp: new Date(),
    }));
  }, [serialLines, wiredActive]);

  // Mock-only demo control: inject a crash scenario via /api/devices/crash (mocks are
  // spawned with a "mock-" device id by the controller).
  const isMock = device.id.startsWith('mock-');
  const [scenario, setScenario]   = useState(CRASH_SCENARIOS[0].id);
  const [injecting, setInjecting] = useState(false);
  const [injectMsg, setInjectMsg] = useState<string | null>(null);

  async function injectCrash() {
    setInjecting(true);
    setInjectMsg(null);
    try {
      const resp = await fetch('/api/devices/crash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: device.id, project_id: currentProjectId, scenario }),
      });
      const data = await resp.json().catch(() => ({}));
      setInjectMsg(resp.ok ? `injected ${scenario}` : (data.error ?? `error ${resp.status}`));
    } catch (e) {
      setInjectMsg(`error: ${(e as Error)?.message ?? e}`);
    } finally {
      setInjecting(false);
    }
  }

  const displayEntries: ConsoleEntry[] = telemetryLoading
    ? [{ id: 'loading', type: 'info', content: `Connecting to ${device.name}…`, timestamp: new Date() }]
    : entries.length === 0
      ? [{ id: 'empty', type: 'info', content: 'No telemetry data yet', timestamp: new Date() }]
      : entries;

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    setDragging(true);
    function onMove(ev: MouseEvent) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct  = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(70, Math.max(20, pct)));
    }
    function onUp() {
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const infoPanel = (
    <div style={{ overflowY: 'auto', padding: 16, flex: 1 }}>
      <DeviceNameHeader device={device} queryMode={isMobile ? false : queryMode} onQueryClick={isMobile ? undefined : onQueryClick} />
      <Field label="Device ID"   value={device.id} />
      <Field label="Status"      value={<span style={{ textTransform: 'capitalize' }}>{device.status}</span>}
             fieldKey="Status"   rawValue={device.status} queryMode={isMobile ? false : queryMode} onQueryClick={isMobile ? undefined : onQueryClick} device={device} />
      <Field label="Firmware"    value={device.firmwareVersion}
             fieldKey="Firmware Version" rawValue={device.firmwareVersion} queryMode={isMobile ? false : queryMode} onQueryClick={isMobile ? undefined : onQueryClick} device={device} />
      <Field label="Agent"       value={device.agentConnected ? 'Connected' : '—'} />
      <Field label="IP Address"  value={device.ipAddress}
             fieldKey="IP Address" rawValue={device.ipAddress} queryMode={isMobile ? false : queryMode} onQueryClick={isMobile ? undefined : onQueryClick} device={device} />
      <Field label="RSSI"        value={formatRssi(device.rssi)}
             fieldKey="RSSI"    rawValue={formatRssi(device.rssi)} queryMode={isMobile ? false : queryMode} onQueryClick={isMobile ? undefined : onQueryClick} device={device} />
      <Field label="Uptime"      value={formatUptime(device.uptimeSeconds)}
             fieldKey="Uptime"  rawValue={formatUptime(device.uptimeSeconds)} queryMode={isMobile ? false : queryMode} onQueryClick={isMobile ? undefined : onQueryClick} device={device} />
      <Field label="Last Seen"   value={formatRelativeTime(device.lastSeen)}
             fieldKey="Last Seen" rawValue={formatRelativeTime(device.lastSeen)} queryMode={isMobile ? false : queryMode} onQueryClick={isMobile ? undefined : onQueryClick} device={device} />

      {/* Hardware identity, self-attested in the device heartbeat (fqbn, chip, …). */}
      <div style={{ marginTop: 14, marginBottom: 4, fontSize: 11, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: '#999' }}>
        Hardware
      </div>
      <Field label="Device Type" value={device.deviceType ?? '—'}
             fieldKey="Device Type" rawValue={device.deviceType ?? undefined} queryMode={isMobile ? false : queryMode} onQueryClick={isMobile ? undefined : onQueryClick} device={device} />
      <Field label="FQBN"        value={device.hardware.fqbn ?? '—'}
             fieldKey="FQBN"     rawValue={device.hardware.fqbn ?? undefined} queryMode={isMobile ? false : queryMode} onQueryClick={isMobile ? undefined : onQueryClick} device={device} />
      <Field label="Chip"        value={device.hardware.chip ?? '—'}
             fieldKey="Chip"     rawValue={device.hardware.chip ?? undefined} queryMode={isMobile ? false : queryMode} onQueryClick={isMobile ? undefined : onQueryClick} device={device} />
      <Field label="Revision"    value={device.hardware.rev !== undefined ? `rev ${device.hardware.rev}` : '—'} />
      <Field label="Flash"       value={device.hardware.flash !== undefined ? formatFlash(device.hardware.flash) : '—'} />

      {isMock && (
        <div style={{ marginTop: 18 }}>
          <div style={{ marginBottom: 6, fontSize: 11, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: '#999' }}>
            Demo — inject crash
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              value={scenario}
              onChange={e => setScenario(e.target.value)}
              style={{ flex: 1, fontSize: 12, padding: '3px 4px', border: '1px solid #ccc' }}
            >
              {CRASH_SCENARIOS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
            <button
              onClick={injectCrash}
              disabled={injecting || !currentProjectId}
              style={{
                fontSize: 12, padding: '4px 12px',
                cursor: injecting || !currentProjectId ? 'default' : 'pointer',
                border: '1px solid #000', background: injecting ? '#eee' : '#000',
                color: injecting ? '#888' : '#fff',
              }}
            >
              {injecting ? '…' : 'Inject'}
            </button>
          </div>
          {injectMsg && (
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{injectMsg}</div>
          )}
        </div>
      )}
    </div>
  );

  const rightTabBtn = (active: boolean, last?: boolean): React.CSSProperties => ({
    padding: '4px 14px', fontSize: 12,
    border: 'none', borderRight: last ? 'none' : '1px solid #000', borderBottom: '1px solid #000',
    background: active ? '#000' : '#fff', color: active ? '#fff' : '#000', cursor: 'pointer',
  });

  // Right side: telemetry Signals, plus a Serial tab when this device is on the wired link.
  const showSerial = serialAvailable && rightTab === 'serial';
  const signalsPanel = (
    <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      {serialAvailable && (
        <div style={{ display: 'flex', flexShrink: 0 }}>
          <button onClick={() => setRightTab('signals')} style={rightTabBtn(rightTab === 'signals')}>◈ Signals</button>
          <button onClick={() => setRightTab('serial')} style={rightTabBtn(rightTab === 'serial', true)}>
            ⌁ Serial{serialLines.length ? ` (${serialLines.length})` : ''}
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {showSerial
          ? <ConsolePanel entries={serialEntries} onClear={clearConsole} />
          : <ConsolePanel entries={displayEntries} onClear={() => {}} />}
      </div>
    </div>
  );

  if (isMobile) {
    const btnStyle = (active: boolean, last?: boolean): React.CSSProperties => ({
      flex: 1, padding: '6px 0', fontSize: 12,
      border: 'none', borderRight: last ? 'none' : '1px solid #000',
      background: active ? '#000' : '#fff', color: active ? '#fff' : '#000', cursor: 'pointer',
    });
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
        <div style={{ display: 'flex', flexShrink: 0, borderBottom: '1px solid #000' }}>
          <button onClick={() => setMobilePanel('info')} style={btnStyle(mobilePanel === 'info')}>◉ Info</button>
          <button onClick={() => setMobilePanel('signals')} style={btnStyle(mobilePanel === 'signals', true)}>◈ Signals</button>
        </div>
        <div style={{ display: mobilePanel === 'info' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          {infoPanel}
        </div>
        <div style={{ display: mobilePanel === 'signals' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          {signalsPanel}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ display: 'flex', flex: 1, flexDirection: 'row', overflow: 'hidden', userSelect: dragging ? 'none' : 'auto' }}
    >
      {/* Left: device info */}
      <div style={{ width: `${splitPct}%`, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {infoPanel}
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={startDrag}
        style={{ width: 5, flexShrink: 0, background: '#000', cursor: 'col-resize' }}
      />

      {/* Right: signals console */}
      {signalsPanel}
    </div>
  );
}
