import { useFloorData } from './useFloorData';
import { FloorGrid } from './FloorGrid';
import { ChatPanel } from '../components/chat/ChatPanel';
import { ConsolePanel } from '../components/squeletton/ConsolePanel';

/**
 * Public, no-login "floor" page (app.nanoforgeflow.com/floor).
 *
 * Unlike the scripted demo embed (src/demo/DemoApp.tsx), this is the REAL thing wired to
 * LIVE data: it reads the single fixed floor project over Supabase Realtime with the anon
 * key (public-read RLS, migration 0062) and renders it read-only. The fleet, the agent
 * chat, the console, and the Current Task breadcrumb are all produced at runtime by 20
 * nff-mock devices + the dedicated floor agent-worker + the nff-floor-showrunner.
 *
 * Read-only by construction: ChatPanel has no onSend, ConsolePanel's clear is a no-op,
 * and no action endpoints are wired — so the page is safe to expose unauthenticated.
 */

const NAV = [
  { id: 'floor', label: 'Floor', icon: '▦' },
  { id: 'agents', label: 'Agents', icon: '⚙' },
  { id: 'deploy', label: 'Deploy', icon: '⑂' },
  { id: 'crash', label: 'Crashes', icon: '✕' },
];

export function FloorApp() {
  const { devices, messages, entries, updatingIds, task } = useFloorData();

  const online = devices.filter(d => d.status === 'online').length;
  const total = devices.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'row', height: '100%', background: '#fff', color: '#000' }}>
      {/* Static nav rail — mirrors the real Sidebar's look, non-interactive. */}
      <div style={{ width: 180, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #000', height: '100%', overflow: 'hidden' }}>
        <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid #000' }}>
          <div style={{ fontSize: 13, fontWeight: 'bold' }}>nff_ floor</div>
          <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>{online}/{total} online · live</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 4 }}>
          {NAV.map(g => {
            const isActive = g.id === 'floor';
            return (
              <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 12px', borderLeft: '3px solid transparent', fontSize: 13, ...(isActive ? { background: '#000', color: '#fff', borderLeft: '3px solid #000' } : {}) }}>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{g.icon}</span>
                {g.label}
              </div>
            );
          })}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ padding: '8px 12px', borderTop: '1px solid #000', fontSize: 10, color: '#999' }}>
          Real devices. Real agent. Live.
        </div>
      </div>

      {/* Main pane: live floor + current task on top, agent chat + console below. */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ height: '56%', minHeight: 0, overflowY: 'auto', padding: 12 }}>
          {/* Current Task breadcrumb strip */}
          <div style={{ marginBottom: 12, minHeight: 18, fontSize: 12, color: '#333' }}>
            {task ? (
              <span>
                <span style={{ color: '#000', fontWeight: 'bold' }}>{task.title}</span>
                {task.steps.length > 0 && (
                  <span style={{ color: '#888' }}> &nbsp;›&nbsp; {task.steps.slice(-3).join(' › ')}</span>
                )}
              </span>
            ) : (
              <span style={{ color: '#aaa' }}>Fleet steady — agent idle</span>
            )}
          </div>
          <FloorGrid devices={devices} updatingIds={updatingIds} />
          <div style={{ display: 'flex', gap: 20, marginTop: 16, fontSize: 12, color: '#555' }}>
            <Legend color="#22c55e" label="running" />
            <Legend color="#eab308" label="nff_ mid-fix" />
            <Legend color="#1d4ed8" label="updating live" />
            <Legend color="#3f3f46" label="offline" />
          </div>
        </div>

        <div style={{ height: 5, flexShrink: 0, background: '#000' }} />

        <div style={{ height: '44%', minHeight: 0, overflow: 'hidden', display: 'flex' }}>
          <div style={{ width: '45%', minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {/* Read-only: no onSend → no composer, no writes. */}
            <ChatPanel messages={messages} emptyState={<span style={{ color: '#888' }}>Agent on standby…</span>} />
          </div>
          <div style={{ width: 5, flexShrink: 0, background: '#000' }} />
          <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {/* Read-only: clear is a no-op (the live feed owns the entries). */}
            <ConsolePanel entries={entries} onClear={() => {}} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span aria-hidden style={{ width: 12, height: 12, background: color, border: '1px solid #000' }} />
      {label}
    </span>
  );
}
