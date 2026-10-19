import type React from 'react';
import { useEffect, useState } from 'react';
import { useCurrentProject } from '../../../context/CurrentProjectContext';

// Demo-only spawn control for the Overview tab. A persistent counterpart to the dismissable
// WelcomeBanner: lets the user bring a virtual ESP32 fleet online (and re-spawn) at any time.
// Reuses the existing controller plumbing (POST /api/demo/spawn, GET /api/demo/mocks); the
// controller mints certs + connects each mock over mTLS/MQTT, which surfaces real `devices` rows
// via the dashboard's realtime subscription. Renders nothing outside the demo project.

const DEFAULT_COUNT = 4;
const MAX_COUNT = 10; // soft client cap; the controller enforces the real per-project limit (429)

type SpawnState = 'idle' | 'spawning' | 'done' | 'error';
type LiveCount = number | null; // null = unknown (controller offline / not yet loaded)

const card: React.CSSProperties = {
  border: '1px solid #3b82f6',
  background: '#eff6ff',
  boxShadow: '2px 2px 0 #bfdbfe',
  marginBottom: 12,
};

const header: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid #3b82f6',
  fontSize: 12,
  fontWeight: 'bold',
  color: '#1e40af',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

export function DemoSpawnPanel() {
  const { currentProject } = useCurrentProject();
  const [count, setCount] = useState(DEFAULT_COUNT);
  const [namePrefix, setNamePrefix] = useState('');
  const [spawn, setSpawn] = useState<SpawnState>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const [liveCount, setLiveCount] = useState<LiveCount>(null);

  // Reflect mocks already running for this project so the panel shows the current fleet size.
  useEffect(() => {
    if (!currentProject.is_demo) return;
    let cancelled = false;
    fetch(`/api/demo/mocks?project_id=${encodeURIComponent(currentProject.id)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d?.ok && Array.isArray(d.mocks)) setLiveCount(d.mocks.length); })
      .catch(() => { /* controller not running locally — leave count unknown */ });
    return () => { cancelled = true; };
  }, [currentProject.id, currentProject.is_demo]);

  // Self-gate so this can be dropped anywhere without leaking to real projects.
  if (!currentProject.is_demo) return null;

  const effectiveCount = Math.max(1, Math.min(count, MAX_COUNT));

  async function bringFleetOnline() {
    setSpawn('spawning');
    setMsg(null);
    try {
      const trimmedPrefix = namePrefix.trim();
      const resp = await fetch('/api/demo/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: currentProject.id,
          count: effectiveCount,
          ...(trimmedPrefix ? { name_prefix: trimmedPrefix } : {}),
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.ok) {
        setSpawn('error');
        setMsg(data?.error ?? `spawn failed (${resp.status})`);
        return;
      }
      const n = Array.isArray(data.spawned) ? data.spawned.length : effectiveCount;
      setSpawn('done');
      setLiveCount(prev => (prev ?? 0) + n);
      setMsg(`${n} mock device${n === 1 ? '' : 's'} booting — they'll appear in the fleet below as they connect.`);
    } catch (e) {
      setSpawn('error');
      setMsg(`mock controller unreachable: ${(e as Error)?.message ?? e}`);
    }
  }

  const runningLabel =
    liveCount === null ? 'fleet status unknown (controller offline?)'
    : liveCount === 0 ? 'no mock devices running'
    : `${liveCount} mock device${liveCount === 1 ? '' : 's'} running`;

  return (
    <div style={card}>
      <div style={header}>
        <span>▸ Mock fleet</span>
        <span style={{ fontSize: 9, border: '1px solid #3b82f6', color: '#3b82f6', padding: '0 3px', letterSpacing: 0.5 }}>
          DEMO
        </span>
      </div>
      <div style={{ padding: '8px 10px', fontSize: 12 }}>
        <div style={{ color: '#1e40af', marginBottom: 8 }}>
          Spawn live virtual ESP32 devices — real MQTT, real OTA, real crashes. No hardware needed.
          Mocks auto-retire after a while; re-spawn any time.
        </div>

        <div style={{ marginBottom: 8, color: '#1d4ed8' }}>● {runningLabel}</div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: '#1e40af' }}>spawn</span>
            <input
              type="number"
              min={1}
              max={MAX_COUNT}
              value={count}
              onChange={e => setCount(Number(e.target.value))}
              disabled={spawn === 'spawning'}
              style={{ width: 52, fontSize: 12, padding: '3px 4px', border: '1px solid #3b82f6', background: '#fff' }}
            />
            <span style={{ color: '#1e40af' }}>device{effectiveCount === 1 ? '' : 's'}</span>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: '#1e40af' }}>named</span>
            <input
              type="text"
              value={namePrefix}
              onChange={e => setNamePrefix(e.target.value)}
              disabled={spawn === 'spawning'}
              placeholder="(optional)"
              title="Optional friendly name. Multiple devices get a numbered suffix (e.g. “Sensor 1”, “Sensor 2”)."
              style={{ width: 110, fontSize: 12, padding: '3px 4px', border: '1px solid #3b82f6', background: '#fff' }}
            />
          </label>

          <button
            onClick={bringFleetOnline}
            disabled={spawn === 'spawning'}
            style={{
              fontSize: 11,
              border: '1px solid #1e40af',
              background: spawn === 'spawning' ? '#2563eb' : '#1e40af',
              color: '#fff',
              padding: '4px 10px',
              cursor: spawn === 'spawning' ? 'default' : 'pointer',
            }}
          >
            {spawn === 'spawning' ? 'Spawning…' : `Spawn (${effectiveCount}) →`}
          </button>
        </div>

        {msg && (
          <div style={{ marginTop: 8, fontSize: 11, color: spawn === 'error' ? '#b00' : '#1e40af' }}>
            {msg}
          </div>
        )}
      </div>
    </div>
  );
}
