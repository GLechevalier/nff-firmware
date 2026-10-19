// serviceStatusStore — ONE module-level subscription to service_status shared
// by every consumer (ChatDock is always mounted, plus whichever tab is open).
//
// Before this store each useServiceStatus() call ran its own initial select,
// opened its own Realtime channel (named `service-status-${Math.random()}` to
// dodge duplicate-name collisions between concurrent instances) and its own 5s
// staleness ticker — so Overview/Chat/Improve always doubled the whole stack.
// A singleton doesn't collide, so the channel name is fixed; ref-counting
// tears everything down when the last subscriber leaves (sign-out unmounts
// App, and with it ChatDock).

import { supabase } from './supabase';

export interface ServiceInfo {
  beat: number;
  status: string;
  detail: string | null;
}

interface StatusRow {
  service?: string;
  last_beat?: string;
  status?: string | null;
  detail?: string | null;
}

let info: Record<string, ServiceInfo> = {};
let version = 0;
let generation = 0; // invalidates a select that resolves after stop()
const listeners = new Set<() => void>();
let channel: ReturnType<typeof supabase.channel> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

function fold(row: StatusRow): ServiceInfo | null {
  return row.service && row.last_beat
    ? { beat: new Date(row.last_beat).getTime(), status: row.status ?? 'ok', detail: row.detail ?? null }
    : null;
}

// The ticker exists only so staleness (beat age) re-renders consumers; while
// the browser tab is hidden nobody sees the render, so skip it — Realtime keeps
// `info` itself current regardless, and visibilitychange catches the UI up.
function onVisible(): void {
  if (!document.hidden) notify();
}

function start(): void {
  const gen = ++generation;
  void supabase
    .from('service_status')
    .select('service,last_beat,status,detail')
    .then(({ data }) => {
      if (gen !== generation || !data) return;
      const next: Record<string, ServiceInfo> = {};
      for (const row of data as StatusRow[]) {
        const entry = fold(row);
        if (entry) next[row.service!] = entry;
      }
      info = next;
      notify();
    });

  channel = supabase
    .channel('service-status')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'service_status' }, (payload) => {
      const row = payload.new as StatusRow;
      const entry = fold(row);
      if (entry) {
        info = { ...info, [row.service!]: entry };
        notify();
      }
    })
    .subscribe();

  timer = setInterval(() => {
    if (!document.hidden) notify();
  }, 5_000);
  document.addEventListener('visibilitychange', onVisible);
}

function stop(): void {
  generation += 1;
  if (channel) void supabase.removeChannel(channel);
  channel = null;
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener('visibilitychange', onVisible);
  // `info` is kept as warm data for the next subscriber.
}

export function subscribeServiceStatus(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function serviceStatusVersion(): number {
  return version;
}

export function getServiceInfo(service: string): ServiceInfo | undefined {
  return info[service];
}
