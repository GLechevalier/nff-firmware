import { useEffect, useState } from 'react';
import { useCurrentProject } from '../../context/CurrentProjectContext';

interface WelcomeBannerProps {
  onConnectDevice: () => void;
}

const LS_PREFIX = 'nff.demoBannerDismissed.';
const SPAWN_COUNT = 4;

type SpawnState = 'idle' | 'spawning' | 'done' | 'error';

export function WelcomeBanner({ onConnectDevice }: WelcomeBannerProps) {
  const { currentProject } = useCurrentProject();
  const lsKey = LS_PREFIX + currentProject.id;
  const [dismissed, setDismissed] = useState(() => !!localStorage.getItem(lsKey));
  const [spawn, setSpawn] = useState<SpawnState>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const [liveCount, setLiveCount] = useState<number | null>(null);

  // Reflect any mocks already running for this project so the button reads
  // "Add more devices" rather than "Bring fleet online" after a reap/refresh.
  useEffect(() => {
    if (!currentProject.is_demo) return;
    let cancelled = false;
    fetch(`/api/demo/mocks?project_id=${encodeURIComponent(currentProject.id)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d?.ok && Array.isArray(d.mocks)) setLiveCount(d.mocks.length); })
      .catch(() => { /* controller not running locally — leave count unknown */ });
    return () => { cancelled = true; };
  }, [currentProject.id, currentProject.is_demo]);

  if (!currentProject.is_demo || dismissed) return null;

  function dismiss() {
    localStorage.setItem(lsKey, '1');
    setDismissed(true);
  }

  async function bringFleetOnline() {
    setSpawn('spawning');
    setMsg(null);
    try {
      const resp = await fetch('/api/demo/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id, count: SPAWN_COUNT }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.ok) {
        setSpawn('error');
        setMsg(data?.error ?? `spawn failed (${resp.status})`);
        return;
      }
      const n = Array.isArray(data.spawned) ? data.spawned.length : SPAWN_COUNT;
      setSpawn('done');
      setLiveCount(prev => (prev ?? 0) + n);
      setMsg(`${n} mock device${n === 1 ? '' : 's'} booting — they'll appear in the fleet below as they connect.`);
    } catch (e) {
      setSpawn('error');
      setMsg(`mock controller unreachable: ${(e as Error)?.message ?? e}`);
    }
  }

  const hasLive = (liveCount ?? 0) > 0;
  const buttonLabel =
    spawn === 'spawning' ? 'Spawning…'
    : hasLive ? `+ Add ${SPAWN_COUNT} more mock devices`
    : `Bring demo fleet online (${SPAWN_COUNT} mock devices) →`;

  return (
    <div style={{
      flexShrink: 0,
      margin: '8px 8px 0',
      border: '1px solid #000',
      background: '#fff',
      fontSize: 12,
      padding: '10px 14px',
      position: 'relative',
    }}>
      <button
        onClick={dismiss}
        aria-label="Dismiss welcome banner"
        style={{
          position: 'absolute', top: 6, right: 8,
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 14, color: '#666', lineHeight: 1,
        }}
      >×</button>

      <div style={{ fontWeight: 'bold', fontSize: 13, marginBottom: 4 }}>
        Welcome to nff — Mock Fleet Trial
      </div>
      <div style={{ color: '#444', marginBottom: 8 }}>
        Spawn a fleet of live virtual ESP32 devices — real MQTT, real OTA, real crashes.
        No hardware needed. Mocks run for a while then auto-retire; re-spawn any time.
      </div>

      <div style={{ color: '#555', lineHeight: 1.7, marginBottom: 10 }}>
        <span style={{ color: '#000' }}>▸</span> <strong>Dashboard</strong> — watch devices come online, ping them, push OTA{' '}
        <span style={{ color: '#000' }}>▸</span> <strong>Crashes</strong> — inject a fault and inspect the real stack trace + RTC log{' '}
        <span style={{ color: '#000' }}>▸</span> <strong>Brain</strong> — explore the agent knowledge graph for your fleet
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={bringFleetOnline}
          disabled={spawn === 'spawning'}
          style={{
            fontSize: 11,
            border: '1px solid #000', background: spawn === 'spawning' ? '#666' : '#000', color: '#fff',
            padding: '4px 10px', cursor: spawn === 'spawning' ? 'default' : 'pointer',
          }}
        >
          {buttonLabel}
        </button>

        <button
          onClick={onConnectDevice}
          style={{
            fontSize: 11,
            border: '1px solid #000', background: '#fff', color: '#000',
            padding: '4px 10px', cursor: 'pointer',
          }}
        >
          Connect real hardware →
        </button>
      </div>

      {msg && (
        <div style={{
          marginTop: 8, fontSize: 11,
          color: spawn === 'error' ? '#b00' : '#070',
        }}>
          {msg}
        </div>
      )}
    </div>
  );
}
