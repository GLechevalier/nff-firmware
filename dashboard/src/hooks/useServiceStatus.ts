import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export type ServiceName = 'nff-fleet' | 'nff-ota' | 'nff-agent-worker' | 'nff-github' | 'nff-diagnosis' | 'nff-pentester' | 'nff-builder';

// A service is online only while its heartbeat is fresh. Services beat every
// ~10s; we allow ~3 missed beats before calling them offline.
const STALE_MS = 30_000;
// Re-evaluate staleness on a timer so a service that simply *stops* beating
// (and therefore emits no further DB events) still flips to offline on its own.
const TICK_MS = 5_000;

// Live backend-service liveness, read from the `service_status` table that each
// service heartbeats into. Initial fetch + Realtime updates + a staleness tick.
export function useServiceStatus() {
  const [beats, setBeats] = useState<Record<string, number>>({});
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    supabase
      .from('service_status')
      .select('service,last_beat')
      .then(({ data }) => {
        if (cancelled || !data) return;
        const next: Record<string, number> = {};
        for (const row of data as Array<{ service: string; last_beat: string }>) {
          next[row.service] = new Date(row.last_beat).getTime();
        }
        setBeats(next);
      });

    const channelId = Math.random().toString(36).slice(2);
    const channel = supabase
      .channel(`service-status-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'service_status' }, payload => {
        const row = payload.new as { service?: string; last_beat?: string };
        if (!row.service || !row.last_beat) return;
        setBeats(prev => ({ ...prev, [row.service!]: new Date(row.last_beat!).getTime() }));
      })
      .subscribe();

    const timer = setInterval(() => setTick(t => t + 1), TICK_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      supabase.removeChannel(channel);
    };
  }, []);

  function isOnline(service: ServiceName): boolean {
    const beat = beats[service];
    return beat !== undefined && Date.now() - beat < STALE_MS;
  }

  return { isOnline };
}
