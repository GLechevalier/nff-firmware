import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import { useMarkBreaking, useMarkDemoBroken } from '../../../context/DeviceHealthContext';
import { supabase } from '../../../lib/supabase';
import { CRASH_SCENARIOS } from '../lib/crashScenarios';

// Pool-only: a demo project owns no L2s — every break BORROWS a shared pool L2 (migration 0075/0076),
// so the most you can break in parallel is the pool size. Fair-share caps how many YOU actually get
// (solo → both; two users → one each); any surplus queues and starts automatically when one frees.
const POOL_L2_COUNT = 2;

// Demo-only break-and-self-heal box for the Overview tab. Breaks N of the online mock devices
// in a staggered ripple — either all with one scenario, or a "mixed cascade" where each device
// gets a different fault — and drives the FULL self-healing pipeline per device
// (POST /api/demo/selfheal): crash-loop scenarios seed a real buggy sketch + trigger the agent
// to diagnose, fix the code, and OTA-recover the device; reboot scenarios inject a transient
// crash that self-heals on the next boot. Renders nothing outside the demo project.

const MIXED_ID = '__mixed__';
const STAGGER_MS = 700;

const card: React.CSSProperties = {
  border: '1px solid #f59e0b',
  background: '#fffbeb',
  boxShadow: '2px 2px 0 #fde68a',
  marginBottom: 12,
};

const header: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid #f59e0b',
  fontSize: 12,
  fontWeight: 'bold',
  color: '#92400e',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface DemoChaosPanelProps {
  // Fired synchronously the instant a break is clicked (before the slow self-heal call), so the
  // App can arm the guided demo story + jump to the Dashboard immediately.
  onDemoStart?: () => void;
  // Called once with the "Self-heal demo" chat session id the agent narrates in, so the App
  // can let the incident popup's "Agent →" button open that conversation.
  onDemoSession?: (sessionId: string) => void;
}

export function DemoChaosPanel({ onDemoStart, onDemoSession }: DemoChaosPanelProps = {}) {
  const { currentProject } = useCurrentProject();
  const markBreaking = useMarkBreaking();
  const markDemoBroken = useMarkDemoBroken();

  const [scenario, setScenario] = useState(MIXED_ID);
  const [count, setCount] = useState(POOL_L2_COUNT);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);
  // When a compile self-heal transparently borrows a Level-2 device and none is free (both held —
  // e.g. by another concurrent demo user, or by this cascade's earlier victims), the request comes
  // back queued (202) with its per-break `request_key`. We remember key→scenario and, when THAT
  // lease is granted (l2_leases → active, matched by request_key via realtime), re-fire it. Keyed
  // (not a single ref) so a solo user's cascade can hold BOTH pool devices at once (migration 0076).
  const [queued, setQueued] = useState(false);
  const pending = useRef<Map<string, string>>(new Map());

  // Self-gate so this can be dropped anywhere without leaking to real projects.
  if (!currentProject.is_demo) return null;

  const effectiveCount = Math.max(1, Math.min(count, POOL_L2_COUNT));

  // POST one self-heal, tagged with a stable per-break `requestKey` (so the borrow is idempotent
  // per break and one user can hold up to their fair-share of pool devices). Returns 'queued' when
  // no pool device is free yet, 'ok' on success (running now), or 'fail'. Surfaces the chat session.
  async function runHeal(deviceId: string, sc: string, requestKey: string): Promise<'ok' | 'queued' | 'fail'> {
    try {
      const resp = await fetch('/api/demo/selfheal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // device_id '' → the server borrows a shared pool L2 (its real id comes back on the response).
        body: JSON.stringify({ device_id: deviceId, project_id: currentProject.id, scenario: sc, request_key: requestKey }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 202 || data?.lease_state === 'queued') return 'queued';
      if (!resp.ok) {
        console.warn('self-heal failed:', data?.error ?? resp.status);
        return 'fail';
      }
      if (typeof data?.device_id === 'string') {
        markBreaking([data.device_id]); // flip the borrowed device amber immediately
        // Seed (crash-loop) scenarios: hold the dot RED until the device heartbeats a firmware
        // above the seeded buggy version (the agent's real fix OTA). Reboot scenarios self-heal on
        // the next boot without a version bump, so they rely on the crash/error red instead.
        if (data.mode === 'seed' && typeof data.version === 'string') {
          markDemoBroken(data.device_id, data.version);
        }
      }
      if (typeof data?.session_id === 'string') onDemoSession?.(data.session_id);
      return 'ok';
    } catch (e) {
      console.warn('self-heal errored:', (e as Error)?.message ?? e);
      return 'fail';
    }
  }

  async function triggerCascade() {
    const n = effectiveCount;   // how many pool L2s to borrow + break in parallel (fair-share caps actual)

    // Arm the guided demo + jump to the Dashboard immediately, before the (slow, sometimes queued)
    // borrow+seed round-trips — so the tab moves on click and the story is armed for the crash edge.
    onDemoStart?.();

    setRunning(true);
    setErrored(false);
    setQueued(false);
    pending.current = new Map();
    setStatus(`arming ${n} device${n === 1 ? '' : 's'}…`);

    // Each break BORROWS a shared pool L2 (device_id ''); runHeal flips the borrowed device's dot
    // amber (via the returned id) the moment its lease is granted, then the overlay turns it red on
    // the first crash and green once it heartbeats healthy again.
    let failures = 0;
    let queuedCount = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) await sleep(STAGGER_MS);
      const sc = scenario === MIXED_ID
        ? CRASH_SCENARIOS[i % CRASH_SCENARIOS.length].id
        : scenario;
      const key = crypto.randomUUID();
      setStatus(`borrowing + breaking a device [${sc}] → agent recovering (${i + 1}/${n})`);
      const outcome = await runHeal('', sc, key);
      if (outcome === 'queued') {
        // No free pool device for THIS break yet — remember its key and let the realtime grant
        // re-fire it. We do NOT abort: a solo user gets both pool L2s in parallel, and any surplus
        // waits its turn (fair-share, migration 0076).
        pending.current.set(key, sc);
        queuedCount++;
      } else if (outcome === 'fail') {
        failures++;
      }
    }

    if (queuedCount > 0) setQueued(true);
    setErrored(failures > 0);
    const active = n - failures - queuedCount;
    setStatus(
      failures > 0
        ? `${active}/${n} self-healing; ${failures} failed${queuedCount ? `, ${queuedCount} waiting for a free device…` : ''}.`
        : queuedCount > 0
          ? `${active} breaking now; ${queuedCount} waiting for a free device — they’ll start automatically.`
          : `done — ${active} device${active === 1 ? '' : 's'} breaking; the agent is fixing the code + OTA-recovering them. Watch the fleet flip to error, then back online.`,
    );
    setRunning(false);
  }

  // While anything is queued, watch our own leases (RLS restricts l2_leases to us). When one is
  // granted (state → active), match it to the pending break by request_key and re-fire THAT break
  // against the now-free device. Keyed so multiple grants route to their own devices/scenarios.
  useEffect(() => {
    if (!queued) return;
    const chan = supabase
      .channel(`chaos-lease-wait:${currentProject.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'l2_leases' }, async payload => {
        const row = (payload.new ?? {}) as Record<string, unknown>;
        if (row.state !== 'active' || !row.device_id) return;
        const key = typeof row.request_key === 'string' ? row.request_key : '';
        const sc = key ? pending.current.get(key) : undefined;
        if (!sc) return;
        pending.current.delete(key);
        if (pending.current.size === 0) setQueued(false);
        setStatus('a device is free — breaking it now → agent recovering…');
        markBreaking([String(row.device_id)]);
        await runHeal(String(row.device_id), sc, key);
      })
      .subscribe();
    return () => { void supabase.removeChannel(chan); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, currentProject.id]);

  return (
    <div style={card}>
      <div style={header}>
        <span>⚡ Demo — break &amp; self-heal</span>
        <span style={{ fontSize: 9, border: '1px solid #f59e0b', color: '#f59e0b', padding: '0 3px', letterSpacing: 0.5 }}>
          DEMO
        </span>
      </div>
      <div style={{ padding: '8px 10px', fontSize: 12 }}>
        <div style={{ color: '#92400e', marginBottom: 8 }}>
          Break a slice of the mock fleet, then watch it self-heal. Each device reports a real panic
          (backtrace + RTC log); crash-loop scenarios then trigger the agent to fix the code and
          OTA-recover the device, while reboot scenarios self-heal on the next boot.
        </div>

        <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: '#92400e' }}>scenario</span>
                <select
                  value={scenario}
                  onChange={e => setScenario(e.target.value)}
                  disabled={running}
                  style={{ fontSize: 12, padding: '3px 4px', border: '1px solid #f59e0b', background: '#fff' }}
                >
                  <option value={MIXED_ID}>Mixed cascade (different fault per device)</option>
                  {CRASH_SCENARIOS.map(s => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: '#92400e' }}>crash</span>
                <input
                  type="number"
                  min={1}
                  max={POOL_L2_COUNT}
                  value={count}
                  onChange={e => setCount(Number(e.target.value))}
                  disabled={running}
                  style={{ width: 52, fontSize: 12, padding: '3px 4px', border: '1px solid #f59e0b', background: '#fff' }}
                />
                <span style={{ color: '#92400e' }}>of {POOL_L2_COUNT} shared</span>
              </label>

              <button
                onClick={triggerCascade}
                disabled={running}
                style={{
                  fontSize: 11,
                  border: '1px solid #92400e',
                  background: running ? '#d97706' : '#92400e',
                  color: '#fff',
                  padding: '4px 10px',
                  cursor: running ? 'default' : 'pointer',
                }}
              >
                {running ? 'Healing…' : `Break + self-heal (${effectiveCount}) →`}
              </button>
            </div>

            {status && (
              <div style={{ marginTop: 8, fontSize: 11, color: errored ? '#b00' : '#92400e' }}>
                {status}
              </div>
            )}
          </>
      </div>
    </div>
  );
}
