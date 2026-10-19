import { useEffect, useMemo, useRef, useState } from 'react';
import { useCrashReports } from '../hooks/useCrashReports';
import { useDevices } from '../hooks/useDevices';
import type { CrashReport } from '../types/crash';

// Floating "fleet incident" card, docked bottom-right, that surfaces devices that just
// crashed — driven by the ⚡ break & self-heal demo, the Crash tab's "Repair with agent",
// or any real device panic. Mirrors BuildChecklistModal's pattern: App-level mount so it
// survives tab switches, a black header with minimize/dismiss, and an edge-triggered
// auto-open the moment a FRESH crash report arrives. Data is live: crash_reports over
// Realtime (useCrashReports) for the panic detail, and the devices table (useDevices) for
// the up-to-the-second recovered/still-broken status.

interface Props {
  onGoToCrash?: () => void;
  onGoToAgent?: () => void;
  // Fired once per genuinely-fresh crash (the same edge that pops the card open), with the newest
  // fresh report. The break-and-heal demo uses it to auto-advance to the Crash tab.
  onFreshCrash?: (crash: CrashReport) => void;
}

// A crash newer than this (when it lands) is treated as a fresh panic and pops the card
// open. Older crashes (e.g. on a page reload) are primed as "already seen" and never
// auto-open. WINDOW_MS bounds which crashes are LISTED as the current incident.
const FRESH_MS = 2 * 60 * 1000;
const WINDOW_MS = 6 * 60 * 1000;

interface Incident {
  deviceId: string;
  deviceName: string;
  scenario: string;          // crash reason / scenario id (e.g. "null_deref")
  summary: string;           // one-line panic summary
  crashCount: number;
  recovered: boolean;        // device is back online
  when: Date;
}

// The most informative one-liner for a crash: its first error-level pre-crash log line,
// else the top symbolicated frame, else the panic reason. Mirrors the CrashTab detail.
function panicSummary(c: CrashReport): string {
  const err = c.rtcLog.find(l => l.level === 'E');
  if (err) return `${err.tag}: ${err.message}`;
  const top = c.backtrace.find(f => f.resolved)?.resolved;
  return top ? `at ${top}` : c.reason;
}

export function FleetIncidentModal({ onGoToCrash, onGoToAgent, onFreshCrash }: Props) {
  const { crashes } = useCrashReports();
  const { allDevices } = useDevices();
  // Held in a ref so the fresh-crash effect below keeps `[crashes]` as its only dependency (a
  // changing callback identity must not re-run the edge detection and re-fire on stale crashes).
  const onFreshCrashRef = useRef(onFreshCrash);
  useEffect(() => { onFreshCrashRef.current = onFreshCrash; }, [onFreshCrash]);
  const [minimized, setMinimized] = useState(false);
  const [dismissed, setDismissed] = useState(true); // hidden until a fresh crash arrives
  // A ticking "now" sourced from the clock (an external system) so the recency math below
  // can run in a pure useMemo instead of calling Date.now() during render. Seeded once via a
  // lazy initializer, then advanced by an interval (setState in a subscription callback).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  // Escape minimizes (never dismisses) so an in-flight incident isn't lost by accident.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMinimized(true);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Edge-trigger: pop the card open when a NEW, recent crash id arrives. Prime the seen-set on
  // first load with existing crash history so a page reload never pops the card for old crashes
  // — only genuinely new panics open it. The wall-clock read lives here (an effect), never in
  // render. Only constant setState (dismiss/minimize flags) happens here, like BuildChecklistModal.
  const seenRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seenRef.current === null) {
      seenRef.current = new Set(crashes.map(c => c.id)); // prime; no auto-open on first load
      return;
    }
    const t = Date.now();
    let freshest: CrashReport | null = null;
    for (const c of crashes) {
      if (!seenRef.current.has(c.id)) {
        seenRef.current.add(c.id);
        if (t - c.timestamp.getTime() < FRESH_MS) {
          if (!freshest || c.timestamp.getTime() > freshest.timestamp.getTime()) freshest = c;
        }
      }
    }
    if (freshest) {
      setDismissed(false);
      setMinimized(false);
      onFreshCrashRef.current?.(freshest);
    }
  }, [crashes]);

  // Derived (pure): the latest crash per device within the window + its live recovered/broken
  // status. `crashes` is ordered newest-first, so the first match for a device is its most
  // recent panic. `now` is a value (not a Date.now() call), keeping this memo pure.
  const incidents = useMemo<Incident[]>(() => {
    const byDevice = new Map<string, Incident>();
    for (const c of crashes) {
      if (now > 0 && now - c.timestamp.getTime() > WINDOW_MS) continue;
      if (byDevice.has(c.deviceId)) continue;
      const status = allDevices.find(d => d.id === c.deviceId)?.status ?? c.deviceStatus;
      byDevice.set(c.deviceId, {
        deviceId: c.deviceId,
        deviceName: c.deviceName,
        scenario: c.reason,
        summary: panicSummary(c),
        crashCount: c.crashCount,
        recovered: status === 'online',
        when: c.timestamp,
      });
    }
    return [...byDevice.values()].sort((a, b) => b.when.getTime() - a.when.getTime());
  }, [crashes, allDevices, now]);

  if (dismissed || incidents.length === 0) return null;

  const stillBroken = incidents.filter(i => !i.recovered).length;
  const allRecovered = stillBroken === 0;

  const headerBar = (
    <div
      onClick={() => setMinimized(m => !m)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
        background: '#000', color: '#fff', cursor: 'pointer',
      }}
    >
      <span style={{ color: allRecovered ? '#22c55e' : '#ef4444', flexShrink: 0 }}>
        {allRecovered ? '✓' : '⚠'}
      </span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 'bold' }}>
        {allRecovered
          ? `Fleet recovered (${incidents.length} device${incidents.length === 1 ? '' : 's'})`
          : `Fleet incident — ${stillBroken} crash-looping`}
      </span>
      <button
        onClick={e => { e.stopPropagation(); setMinimized(m => !m); }}
        title={minimized ? 'Expand' : 'Minimize'}
        style={{ border: 'none', background: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}
      >
        {minimized ? '▢' : '–'}
      </button>
      <button
        onClick={e => { e.stopPropagation(); setDismissed(true); }}
        title="Dismiss (devices keep recovering)"
        style={{ border: 'none', background: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}
      >
        ×
      </button>
    </div>
  );

  return (
    <div
      onClick={e => e.stopPropagation()}
      style={{
        position: 'fixed', bottom: 16, right: 16, zIndex: 9998, width: 340,
        background: '#fff', border: '1.5px solid #000', boxShadow: '4px 4px 0 #000',
        display: 'flex', flexDirection: 'column', maxHeight: '70vh',
      }}
    >
      {headerBar}
      {!minimized && (
        <div style={{ padding: '8px 10px', overflowY: 'auto', fontSize: 12, lineHeight: 1.5 }}>
          {incidents.map(i => (
            <div key={i.deviceId} style={{ padding: '4px 0', borderBottom: '1px solid #f0f0f0' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ flexShrink: 0, color: i.recovered ? '#22c55e' : '#ef4444', fontSize: 12 }}>
                  {i.recovered ? '✓' : '●'}
                </span>
                <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {i.deviceName}
                </span>
                <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 10, color: '#888' }}>
                  {i.recovered ? 'recovered' : i.scenario}
                </span>
              </div>
              <div style={{ paddingLeft: 18, fontSize: 10, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {i.recovered ? `was ${i.scenario}` : i.summary}
                {!i.recovered && i.crashCount > 1 && (
                  <span style={{ color: '#b91c1c' }}> · ×{i.crashCount}</span>
                )}
              </div>
            </div>
          ))}

          {!allRecovered && (
            <div style={{ marginTop: 6, fontSize: 11, fontStyle: 'italic', color: '#000' }}>
              ▸ agent is diagnosing &amp; OTA-recovering…
            </div>
          )}
          {allRecovered && (
            <div style={{ marginTop: 6, fontSize: 11, color: '#15803d' }}>
              All devices recovered.
            </div>
          )}

          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            {onGoToCrash && (
              <button
                onClick={onGoToCrash}
                style={{
                  flex: 1, padding: '4px 0', background: 'none', border: '1px solid #000',
                  color: '#000', cursor: 'pointer', fontSize: 11,
                }}
              >
                View crash logs →
              </button>
            )}
            {onGoToAgent && (
              <button
                onClick={onGoToAgent}
                style={{
                  flex: 1, padding: '4px 0', background: 'none', border: '1px solid #000',
                  color: '#000', cursor: 'pointer', fontSize: 11,
                }}
              >
                Agent console →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
