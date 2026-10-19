// permissionsStore — ONE module-level mirror of admin_permissions (0136), the
// global automation toggles flipped in Settings → Permissions. Shared by the
// browser-side gates (clickLog, calendar poll) and the Settings section, same
// singleton + ref-count shape as serviceStatusStore. MISSING ROW = ENABLED,
// and a failed select keeps the last known state — "off" is an explicit admin
// choice, never a fetch hiccup. Server-side consumers read the table with
// service-role via api/_lib/permissions.ts instead.

import { supabase } from './supabase';

let enabled: Record<string, boolean> = {};
let version = 0;
let generation = 0; // invalidates a select that resolves after stop()
const listeners = new Set<() => void>();
let channel: ReturnType<typeof supabase.channel> | null = null;

function notify(): void {
  version += 1;
  for (const l of listeners) l();
}

function refresh(gen: number): void {
  void supabase
    .from('admin_permissions')
    .select('key, enabled')
    .then(({ data }) => {
      if (gen !== generation || !data) return;
      const next: Record<string, boolean> = {};
      for (const row of data as { key: string; enabled: boolean }[]) next[row.key] = row.enabled;
      enabled = next;
      notify();
    });
}

function start(): void {
  const gen = ++generation;
  refresh(gen);
  channel = supabase
    .channel('admin-permissions')
    // Re-SELECT instead of merging the payload — Realtime is never the guarantee.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'admin_permissions' }, () => refresh(gen))
    .subscribe();
}

function stop(): void {
  generation += 1;
  if (channel) void supabase.removeChannel(channel);
  channel = null;
  // `enabled` is kept as warm data for the next subscriber.
}

export function subscribePermissions(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function permissionsVersion(): number {
  return version;
}

/** Sync check for non-React consumers (clickLog). Unknown key = enabled. */
export function permissionEnabled(key: string): boolean {
  return enabled[key] ?? true;
}

/** Optimistic flip; a failed write re-syncs from the DB. */
export async function setPermission(key: string, value: boolean): Promise<string | null> {
  enabled = { ...enabled, [key]: value };
  notify();
  const { error } = await supabase
    .from('admin_permissions')
    .upsert({ key, enabled: value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) {
    refresh(generation);
    return error.message;
  }
  return null;
}
