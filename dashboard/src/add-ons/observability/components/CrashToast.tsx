import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { CrashReport } from '../types/crash';

// Top-right, auto-dismissing warning toasts that pop the instant a device panics — the loud,
// unmissable counterpart to the bottom-right FleetIncidentModal (which is the persistent
// incident tracker). Fed by App's fresh-crash edge (FleetIncidentModal.onFreshCrash), so a
// toast fires exactly once per genuinely-new crash.

// The most informative one-liner for a crash. Mirrors FleetIncidentModal.panicSummary: first
// error-level pre-crash log line, else the top symbolicated frame, else the raw panic reason.
function panicSummary(c: CrashReport): string {
  const err = c.rtcLog.find(l => l.level === 'E');
  if (err) return `${err.tag}: ${err.message}`;
  const top = c.backtrace.find(f => f.resolved)?.resolved;
  return top ? `at ${top}` : c.reason;
}

const AUTO_DISMISS_MS = 8000;

interface ItemProps {
  crash: CrashReport;
  onDismiss: () => void;
  onView?: () => void;
}

function CrashToastItem({ crash, onDismiss, onView }: ItemProps) {
  useEffect(() => {
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [onDismiss]);

  const summary = panicSummary(crash);

  // Compact operator toast: red-accent bar, device + panic one-liner, quiet "view" link.
  return (
    <div
      role="alert"
      style={{
        width: 320, background: '#fff', color: '#000',
        border: '1.5px solid #000', borderLeft: '4px solid #ef4444', boxShadow: '4px 4px 0 #000',
        fontSize: 12, padding: '8px 10px',
        display: 'flex', alignItems: 'flex-start', gap: 8,
        animation: 'nff-toast-in 0.22s ease-out',
      }}
    >
      <span style={{ color: '#ef4444', flexShrink: 0, lineHeight: 1.4 }}>⚠</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {crash.deviceName}
          </span>
          <span style={{ flexShrink: 0, fontSize: 10, color: '#888' }}>crashed</span>
        </div>
        <div style={{ color: '#666', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </div>
        {onView && (
          <button
            onClick={onView}
            style={{
              marginTop: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              color: '#000', fontSize: 11, textDecoration: 'underline',
            }}
          >
            View crash →
          </button>
        )}
      </div>
      <button
        onClick={onDismiss}
        title="Dismiss"
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 0, color: '#000', flexShrink: 0, textDecoration: 'underline' }}
      >
        dismiss
      </button>
    </div>
  );
}

interface Props {
  // Active crash toasts, newest first — App pushes one per fresh crash and drops them on dismiss.
  toasts: CrashReport[];
  onDismiss: (id: string) => void;
  // Jump to the crash detail for this device (App wires it to the Crash tab).
  onView?: (crash: CrashReport) => void;
}

// Fixed top-right stack, portalled to <body> so it survives tab switches (tabs stay mounted via
// display:none). zIndex above every modal so a fresh panic is never occluded.
export function CrashToast({ toasts, onDismiss, onView }: Props) {
  if (toasts.length === 0) return null;
  return createPortal(
    <div
      style={{
        position: 'fixed', top: 16, right: 16, zIndex: 10001,
        display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end',
        pointerEvents: 'none',
      }}
    >
      {toasts.map(c => (
        <div key={c.id} style={{ pointerEvents: 'auto' }}>
          <CrashToastItem
            crash={c}
            onDismiss={() => onDismiss(c.id)}
            onView={onView ? () => onView(c) : undefined}
          />
        </div>
      ))}
    </div>,
    document.body,
  );
}
