import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { BRAND_ACCENT } from '../../lib/brand';
import type { TabId } from '../squeletton/TabBar';

// A single, gentle "something's happening on another tab" toast for babynff mode. It replaces
// the demo's old auto-navigation (which yanked the user Dashboard→Crash→Code→Deploy→Dashboard):
// instead of teleporting them, we narrate the self-heal beat here and let them CHOOSE to follow
// via the "Open the X tab →" button. Bottom-left so it never collides with the top-right
// CrashToast or the bottom-right FleetIncidentModal. Portals to <body> so it survives tab
// switches (the console keeps tabs mounted via display:none).

export interface DemoActivity {
  id: string;        // stable per target tab: distinct beats reset the auto-dismiss timer, but a
                     // re-fire of the same beat coalesces instead of restarting it every frame
  message: string;
  targetTab: TabId;  // where "Open the X tab →" navigates
  tabLabel: string;  // human label for the button ("Code", "Deploy", "Dashboard")
  // Never auto-dismiss. The rollout beat waits on the device's real fix OTA (~15-18 min for an L2
  // recompile), so a 12s dismissal would leave the user staring at nothing for the entire wait.
  // Cleared by the next beat (recovery / expiry) or by the user.
  sticky?: boolean;
}

// Generous dwell — a beginner needs time to read + decide whether to follow along.
const AUTO_DISMISS_MS = 12000;

interface Props {
  activity: DemoActivity | null;
  onDismiss: () => void;
  onGo: (tab: TabId) => void;
}

export function DemoActivityToast({ activity, onDismiss, onGo }: Props) {
  const id = activity?.id;
  const sticky = activity?.sticky ?? false;
  // Held in a ref so the dismiss timer keys ONLY off the beat. While an incident runs,
  // DeviceHealthContext re-renders the tree once per second; with onDismiss in the deps its fresh
  // closure identity restarted the timer on every tick, so it never actually fired.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => { onDismissRef.current = onDismiss; });
  useEffect(() => {
    if (!id || sticky) return;
    const t = setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [id, sticky]);

  if (!activity) return null;

  return createPortal(
    <div style={{ position: 'fixed', left: 16, bottom: 16, zIndex: 10000, pointerEvents: 'none' }}>
      <div
        role="status"
        style={{
          width: 320, background: '#fff', color: '#000',
          border: '2px solid #000', boxShadow: '5px 5px 0 #000',
          pointerEvents: 'auto', animation: 'nff-toast-in 0.28s ease-out',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: BRAND_ACCENT, color: '#fff' }}>
          <span style={{ fontSize: 15, lineHeight: 1 }}>⚙</span>
          <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>nff is working on it</span>
          <button
            onClick={onDismiss}
            title="Dismiss"
            style={{ border: 'none', background: 'none', color: '#fff', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 0, textDecoration: 'underline' }}
          >
            dismiss
          </button>
        </div>
        <div style={{ padding: '10px', fontSize: 12, lineHeight: 1.5 }}>
          <div>{activity.message}</div>
          <button
            onClick={() => onGo(activity.targetTab)}
            className="press"
            style={{
              marginTop: 10, width: '100%', padding: '6px 0', background: BRAND_ACCENT, color: '#fff',
              border: '2px solid #000', cursor: 'pointer', fontSize: 12, fontWeight: 700,
            }}
          >
            Open the {activity.tabLabel} tab →
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
