import { useEffect, useId, useState } from 'react';
import { supabase } from '../lib/supabase';

// The terminal outcome of the agent's `submit_firmware_fix`, which only ENQUEUES a build:
// nff-ota's fix_worker compiles the L2 firmware for real afterwards and writes the result here
// (migration 0069). A failed compile lands in `error` and NOTHING else in the stack reads it —
// without this hook the demo narrates "fix shipped" and the dot just sits red with no reason.
export interface FirmwareFixJob {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  version: string;
  error: string | null;
  faultRemaining: boolean;
}

function mapRow(row: Record<string, unknown>): FirmwareFixJob {
  return {
    id: row.id as string,
    status: row.status as FirmwareFixJob['status'],
    version: (row.version as string | null) ?? '',
    error: (row.error as string | null) ?? null,
    faultRemaining: Boolean(row.fault_remaining),
  };
}

// Latest fix job for `deviceId` (null = don't subscribe). Scoped by device_id, not project_id:
// the demo may be healing a device the caller doesn't own the project row for.
//
// Caveat: firmware_fix_jobs' RLS is `is_project_member(project_id)` (0069), and a BORROWED pool L2's
// job is written with the POOL project's id — so in pool mode the borrower cannot read it and this
// returns null. Surfacing those needs an `l2_visible_fix_jobs` RPC, the same shape as
// l2_visible_crashes. Local dev (usePool=false) heals the caller's OWN device, so it reads fine.
export function useFirmwareFixJob(deviceId: string | null) {
  const [job, setJob] = useState<FirmwareFixJob | null>(null);
  // Supabase hands back the SAME channel for a repeated topic, and .on() after a prior .subscribe()
  // throws — so the topic must be unique per hook instance. Mirrors useCrashReports.
  const instanceId = useId();

  useEffect(() => {
    if (!deviceId) return;   // idle: nothing to subscribe to. `job` is masked out at the return.
    let cancelled = false;

    async function load() {
      const { data, error } = await supabase
        .from('firmware_fix_jobs')
        .select('id, status, version, error, fault_remaining')
        .eq('device_id', deviceId)
        .order('created_at', { ascending: false })
        .limit(1);
      if (cancelled || error) return;
      setJob(data?.length ? mapRow(data[0] as Record<string, unknown>) : null);
    }

    load();

    const channel = supabase
      .channel(`firmware_fix_jobs:${deviceId}:${instanceId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'firmware_fix_jobs', filter: `device_id=eq.${deviceId}` },
        () => { void load(); },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [deviceId, instanceId]);

  // Masked at read time rather than reset via setState in the effect body (which would trigger a
  // cascading render), so a stale job from a previous demo can't leak once deviceId goes null.
  return deviceId ? job : null;
}
