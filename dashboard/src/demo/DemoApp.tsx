import { useEffect, useRef, useState } from 'react';
import type { Device } from '../types/device';
import { DeviceTable } from '../add-ons/observability/components/DeviceTable';
import { ChatPanel, type ChatMessage } from '../components/chat/ChatPanel';
import { ConsolePanel, type ConsoleEntry } from '../components/squeletton/ConsolePanel';
import { mockDevices } from '../data/mockDevices';
import { demoScript, DEMO_TARGET_DEVICE_ID } from './demoStream';

/**
 * Public, no-login demo surface embedded (via iframe) on the marketing site.
 *
 * It deliberately reuses the *real* presentational components — DeviceTable,
 * ChatPanel, ConsolePanel — so the embed is the genuine product UI, not a mock-up.
 * What it does NOT touch: AuthGate, the Supabase client, or any data hook. All data
 * is local: `mockDevices` for the fleet, and `demoScript` for a looping "agent at
 * work" timeline. No backend, no auth, no abuse surface.
 *
 * Layout mirrors App.tsx (static rail + split: fleet table on top, agent below),
 * trimmed to the fleet + agent-console scope.
 */

const PAUSE_BETWEEN_LOOPS = 4000;

// Mirror of the real Sidebar's nav groups (see components/TabBar NAV_GROUPS),
// inlined so the demo never imports TabBar — which would drag in the auth-bound
// ProfileMenu/ProjectSwitcher and the whole supabase-js client.
const DEMO_NAV = [
  { id: 'agents',     label: 'Agents',    icon: '⚙' },
  { id: 'dashboard',  label: 'Dashboard', icon: '▦' },
  { id: 'deploy',     label: 'Deploy',    icon: '⑂' },
  { id: 'crash',      label: 'Crashes',   icon: '✕' },
  { id: 'enrollment', label: 'Enroll',    icon: '⊞' },
];

export function DemoApp() {
  const [devices, setDevices]   = useState<Device[]>(mockDevices);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [entries, setEntries]   = useState<ConsoleEntry[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    let cancelled = false;

    function reset() {
      setDevices(mockDevices);
      setMessages([]);
      setEntries([]);
    }

    function playOnce() {
      if (cancelled) return;
      reset();
      let elapsed = 0;
      for (const step of demoScript) {
        elapsed += step.delay;
        const t = setTimeout(() => {
          if (cancelled) return;
          if ('chat' in step) {
            setMessages(prev => [...prev, { ...step.chat, timestamp: new Date() }]);
          } else {
            setEntries(prev => [...prev, { ...step.console, timestamp: new Date() }]);
            // The patch lands → flip the warning device back to online so the
            // fleet table visibly reacts.
            if (step.console.id === 'k11') {
              setDevices(prev => prev.map(d =>
                d.id === DEMO_TARGET_DEVICE_ID
                  ? { ...d, status: 'online', firmwareVersion: '2.3.9', currentFirmwareVersion: '2.3.9' }
                  : d,
              ));
            }
          }
        }, elapsed);
        timers.current.push(t);
      }
      // Schedule the next loop.
      const loop = setTimeout(playOnce, elapsed + PAUSE_BETWEEN_LOOPS);
      timers.current.push(loop);
    }

    playOnce();

    return () => {
      cancelled = true;
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  // demoScriptDuration is a stable module constant; play once on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const online = devices.filter(d => d.status === 'online').length;
  const total  = devices.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100%', background: '#fff', color: '#000' }}>
      {/* Static nav rail — mirrors the real Sidebar's look, non-interactive. */}
      <div style={{
        width: 180, flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderRight: '1px solid #000', height: '100%', overflow: 'hidden',
      }}>
        <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid #000' }}>
          <div style={{ fontSize: 13, fontWeight: 'bold' }}>nff</div>
          <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{online}/{total} online</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 4 }}>
          {DEMO_NAV.map(group => {
            const isActive = group.id === 'dashboard';
            return (
              <div
                key={group.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, padding: '7px 12px',
                  borderLeft: '3px solid transparent', fontSize: 13,
                  ...(isActive ? { background: '#000', color: '#fff', borderLeft: '3px solid #000' } : {}),
                }}
              >
                <span style={{ fontSize: 12, opacity: 0.7 }}>{group.icon}</span>
                {group.label}
              </div>
            );
          })}
        </div>
        <div style={{ flex: 1 }} />
      </div>

      {/* Main pane: fleet table on top, agent (chat + console) below. */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ height: '58%', minHeight: 0, overflowY: 'auto', padding: 8 }}>
          <DeviceTable devices={devices} />
        </div>

        <div style={{ height: 5, flexShrink: 0, background: '#000' }} />

        <div style={{ height: '42%', minHeight: 0, overflow: 'hidden', display: 'flex' }}>
          <div style={{ width: '45%', minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <ChatPanel messages={messages} />
          </div>
          <div style={{ width: 5, flexShrink: 0, background: '#000' }} />
          <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <ConsolePanel entries={entries} onClear={() => setEntries([])} />
          </div>
        </div>
      </div>
    </div>
  );
}
