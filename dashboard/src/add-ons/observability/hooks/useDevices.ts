import { useCallback, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import { mutate, useSharedResource } from '../../../lib/sharedResource';
import type { Device, DeviceHardware, DeviceStatus, OtaEnrollmentStatus } from '../../../types/device';

function mapRow(row: Record<string, unknown>): Device {
  return {
    id: row.id as string,
    projectId: (row.project_id as string | null) ?? '',
    name: row.name as string,
    status: row.status as DeviceStatus,
    firmwareVersion: row.firmware_version as string,
    agentConnected: row.agent_connected as boolean,
    lastSeen: new Date(row.last_seen as string),
    ipAddress: (row.ip_address as string | null) ?? '',
    rssi: (row.rssi as number | null) ?? null,
    uptimeSeconds: row.uptime_seconds as number,
    otaStatus: (row.ota_status as OtaEnrollmentStatus | null) ?? 'accepted',
    currentFirmwareVersion: (row.current_firmware_version as string | null) ?? null,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    deviceType: (row.device_type as string | null) ?? null,
    hardware: (row.hardware && typeof row.hardware === 'object'
      ? (row.hardware as DeviceHardware)
      : {}),
    heartbeatIntervalS: (row.heartbeat_interval_s as number | null) ?? null,
    // Migration 0080. Read defensively: a project whose DB predates it simply has no such column,
    // and the demo must degrade to "never broken" rather than throw.
    demoFaultAbove: (row.demo_fault_above as string | null) ?? null,
    demoFaultSince: row.demo_fault_since ? new Date(row.demo_fault_since as string) : null,
  };
}

const keyFor = (projectId: string) => `devices:${projectId}`;

// Ids per bulk UPDATE request. PostgREST puts an `in.(…)` filter in the query string, so a sweep
// over a large fleet has to be split to stay under the URL length limit.
const BULK_UPDATE_CHUNK = 200;

// reconcile_device_statuses is a WRITE, and it used to run ahead of *every* read — in every one of
// the hook's call sites, on every heartbeat-driven refetch. Its only job is to stop the dashboard
// OPENING on a stale `online` (the fleet reaper does this live, but may not have swept yet), so it
// does not need to run on each of the many refetches a busy fleet triggers. Throttle it per project.
const RECONCILE_EVERY_MS = 30_000;
const lastReconciledAt = new Map<string, number>();

async function reconcileIfStale(projectId: string) {
  const last = lastReconciledAt.get(projectId) ?? 0;
  if (Date.now() - last < RECONCILE_EVERY_MS) return;
  lastReconciledAt.set(projectId, Date.now());
  const { error } = await supabase.rpc('reconcile_device_statuses', { p_project_id: projectId });
  if (error) console.warn('reconcile_device_statuses failed:', error.message);
}

// Source of truth = l2_visible_devices RPC: the caller's own fleet PLUS any pool L2 they currently
// hold a lease on, with the leased row's project_id rewritten to the caller's and its name replaced
// by the lease alias (migration 0075) — so a borrowed device is indistinguishable from the user's
// own. Falls back to the raw project-scoped select where the RPC isn't present yet (env without
// 0075 applied), so the fleet always loads.
async function fetchDevices(projectId: string): Promise<Device[]> {
  await reconcileIfStale(projectId);

  const { data, error } = await supabase.rpc('l2_visible_devices', { p_project_id: projectId });
  if (error) {
    // Fallback: the masking RPC isn't deployed here — show the user's own fleet only.
    const raw = await supabase.from('devices').select('*').eq('project_id', projectId).order('name');
    if (raw.error) throw new Error(raw.error.message);
    return (raw.data ?? []).map(row => mapRow(row as Record<string, unknown>));
  }
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  return rows.map(mapRow).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The project's fleet. Every call site shares ONE query and ONE set of Realtime channels via
 * sharedResource — this hook is mounted ~9 times (App, DeviceHealthContext, Overview, OTA, Groups,
 * Enrollment, Builder, …) because tabs stay mounted behind `display:none`, and it used to pay the
 * full cost each time.
 */
export function useDevices() {
  const { currentProjectId } = useCurrentProject();
  const key = currentProjectId ? keyFor(currentProjectId) : null;

  const { data, loading, error } = useSharedResource<Device[]>(key, {
    fetcher: () => fetchDevices(currentProjectId),
    // Lease grants still coarse-refetch (they need the masking RPC); a short debounce coalesces
    // those bursts. Heartbeat UPDATEs — the frequent ones — no longer refetch at all (see below).
    debounceMs: 200,
    subscribe: ({ refetch, mutate }) => {
      const channelId = Math.random().toString(36).slice(2);

      // Realtime channel for the currently-leased pool device (id-filtered, at most one at a time),
      // so its live status/telemetry flows to the borrower even though it lives in the pool project.
      let leasedChannel: ReturnType<typeof supabase.channel> | null = null;
      let leasedDeviceId: string | null = null;

      // The user's own fleet (project-scoped). Patch the single changed row straight from the
      // payload instead of re-downloading the whole fleet on every heartbeat — that coarse refetch
      // (each pulling every device incl. the `hardware` JSONB) was the dominant Supabase egress
      // sink, since ~10 mocks heartbeat continuously. Own devices are never mask-rewritten by the
      // RPC (only leased pool devices are), so their raw row == what fetchDevices would return —
      // the same mapRow the raw-select fallback uses. Mirrors useOtaJobs' granular pattern.
      const ownChannel = supabase
        .channel(`devices-${channelId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'devices', filter: `project_id=eq.${currentProjectId}` }, payload => {
          if (payload.eventType === 'DELETE') {
            const deletedId = (payload.old as Record<string, unknown>).id as string;
            mutate(prev => (prev ?? []).filter(d => d.id !== deletedId));
            return;
          }
          const dev = mapRow(payload.new as Record<string, unknown>);
          mutate(prev => {
            const list = prev ?? [];
            const i = list.findIndex(d => d.id === dev.id);
            if (i === -1) {
              // New device (enrollment) — insert and keep the by-name order fetchDevices sorts by.
              return [...list, dev].sort((a, b) => a.name.localeCompare(b.name));
            }
            const next = [...list];
            next[i] = dev; // heartbeats don't change name, so in-place keeps sort order
            return next;
          });
        })
        .subscribe();

      // Lease changes (RLS restricts l2_leases to the caller's own rows): a grant makes the pool
      // device appear, an expiry/release makes it vanish. On an active lease, open an id-filtered
      // channel on the leased device so its live status reaches the borrower (the pool device isn't
      // covered by the project-scoped channel above); the overlay RLS authorises the subscription.
      const leaseChannel = supabase
        .channel(`l2-leases-${channelId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'l2_leases' }, payload => {
          const row = (payload.new ?? payload.old) as Record<string, unknown> | null;
          const state = row?.state as string | undefined;
          const devId = row?.device_id as string | null | undefined;
          if (state === 'active' && devId && devId !== leasedDeviceId) {
            if (leasedChannel) supabase.removeChannel(leasedChannel);
            leasedDeviceId = devId;
            leasedChannel = supabase
              .channel(`devices-leased-${channelId}-${devId}`)
              .on('postgres_changes', { event: '*', schema: 'public', table: 'devices', filter: `id=eq.${devId}` }, refetch)
              .subscribe();
          } else if (state !== 'active' && leasedChannel) {
            supabase.removeChannel(leasedChannel);
            leasedChannel = null;
            leasedDeviceId = null;
          }
          refetch();
        })
        .subscribe();

      return () => {
        supabase.removeChannel(ownChannel);
        supabase.removeChannel(leaseChannel);
        if (leasedChannel) supabase.removeChannel(leasedChannel);
      };
    },
  });

  const devices = useMemo(() => data ?? [], [data]);

  // Enrollment: accept / reject / preauthorize / decommission a device. Writes devices.ota_status
  // directly (the backend treats this as a plain state change). We apply the change optimistically
  // so the card moves lanes instantly instead of waiting on the realtime round-trip; the realtime
  // UPDATE triggers a refetch that idempotently reconciles the same value. On error we roll back.
  const setEnrollment = useCallback(async (deviceId: string, otaStatus: OtaEnrollmentStatus) => {
    if (!key) return;
    const rollback = mutate<Device[]>(key, prev =>
      (prev ?? []).map(d => (d.id === deviceId ? { ...d, otaStatus } : d)));
    const { error: err } = await supabase
      .from('devices')
      .update({ ota_status: otaStatus })
      .eq('id', deviceId);
    if (err) {
      rollback();
      throw new Error(err.message);
    }
  }, [key]);

  // Same write as setEnrollment, for a whole set of devices at once (the Enrollment board's
  // "Reject inactive" sweep). Three things this does that a loop over setEnrollment would not:
  //
  //  - CHUNKS the id list. `.in('id', ids)` lands in the query string, so one request per ~200 ids
  //    keeps a fleet-scale sweep under the URL limit.
  //  - `.select('id')` to learn which rows ACTUALLY changed. A leased pool device looks like an own
  //    device on the board (l2_visible_devices rewrites its project_id, migration 0075) but RLS
  //    silently updates zero rows for it — PostgREST reports no error. Since an unchanged row emits
  //    no realtime UPDATE, an unreconciled optimistic flip would strand it in the wrong lane forever.
  //  - RECONCILES to exactly what was written, then reports the shortfall, rather than claiming a
  //    move that didn't happen.
  const setEnrollmentBulk = useCallback(async (deviceIds: string[], otaStatus: OtaEnrollmentStatus) => {
    if (!key || deviceIds.length === 0) return;
    const wanted = new Set(deviceIds);
    // Capture the prior lane of each target BEFORE the optimistic flip, so a partial success can
    // put back exactly the rows that didn't move (their post-flip otaStatus is already the new one).
    const priorStatus = new Map(devices.filter(d => wanted.has(d.id)).map(d => [d.id, d.otaStatus]));
    // Optimistic: the cards jump lanes at once, same as the single-device path.
    const rollback = mutate<Device[]>(key, prev =>
      (prev ?? []).map(d => (wanted.has(d.id) ? { ...d, otaStatus } : d)));

    const written = new Set<string>();
    try {
      for (let i = 0; i < deviceIds.length; i += BULK_UPDATE_CHUNK) {
        const chunk = deviceIds.slice(i, i + BULK_UPDATE_CHUNK);
        const { data, error: err } = await supabase
          .from('devices')
          .update({ ota_status: otaStatus })
          .in('id', chunk)
          .select('id');
        if (err) throw new Error(err.message);
        for (const row of data ?? []) written.add((row as { id: string }).id);
      }
    } catch (e) {
      rollback();
      throw e instanceof Error ? e : new Error(String(e));
    }

    if (written.size < deviceIds.length) {
      // Partial success: put back only the rows that didn't move. The confirmed ones keep the new
      // status, and their realtime UPDATE will reconcile them idempotently.
      mutate<Device[]>(key, prev =>
        (prev ?? []).map(d => (wanted.has(d.id) && !written.has(d.id)
          ? { ...d, otaStatus: priorStatus.get(d.id) ?? d.otaStatus }
          : d)));
      throw new Error(`${deviceIds.length - written.size} device(s) couldn't be moved (not permitted)`);
    }
  }, [key, devices]);

  // Bulk-delete the project's rejected devices so the Enrollment board's rejected lane can be
  // cleared. Optimistic: drop rejected rows locally, roll back on error.
  //
  // Mock devices need their *container* torn down too — a rejected mock keeps running and
  // heartbeating, so deleting only its row lets the next heartbeat re-INSERT it. We retire each
  // rejected mock through the controller FIRST (kills container + cert + deletes the row), then the
  // SECURITY DEFINER delete_rejected_devices RPC (membership-gated, FK cascade) clears the remaining
  // real-device rows. The realtime DELETE (migration 0047) reconciles the optimistic removal.
  const deleteRejectedDevices = useCallback(async (): Promise<number> => {
    if (!currentProjectId || !key) return 0;
    const rejected = devices.filter(d => d.otaStatus === 'rejected');
    const mockRejected = rejected.filter(d => d.id.startsWith('mock-'));
    const rollback = mutate<Device[]>(key, prev => (prev ?? []).filter(d => d.otaStatus !== 'rejected'));
    try {
      // Tear down mock containers first so a still-running mock can't re-create its row.
      for (const d of mockRejected) {
        const r = await fetch('/api/demo/retire', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: d.id }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || !body?.ok) throw new Error(body?.error ?? `retire ${d.id} failed (${r.status})`);
      }
      // Delete remaining (real, non-mock) rejected rows; a no-op for the already-removed mocks.
      const { data: deleted, error: err } = await supabase.rpc('delete_rejected_devices', { p_project_id: currentProjectId });
      if (err) throw new Error(err.message);
      return mockRejected.length + ((deleted as number | null) ?? 0);
    } catch (e) {
      rollback(); // undo the optimistic removal
      throw e instanceof Error ? e : new Error(String(e));
    }
  }, [currentProjectId, key, devices]);

  // Tags double as the device's group signal (which group a device belongs to).
  // Writes devices.tags directly; the realtime subscription reflects the change back.
  const setDeviceTags = useCallback(async (deviceId: string, tags: string[]) => {
    const { error: err } = await supabase.from('devices').update({ tags }).eq('id', deviceId);
    if (err) throw new Error(err.message);
  }, []);

  // Friendly display name (≠ device_id). Writes devices.name directly (allowed by the 0019 "members
  // update devices" RLS policy); the realtime subscription reflects it back. Heartbeats never
  // overwrite name (it is seeded on insert only), so a rename sticks. Empty string falls the display
  // back to the id at the render layer.
  const setDeviceName = useCallback(async (deviceId: string, name: string) => {
    const { error: err } = await supabase.from('devices').update({ name }).eq('id', deviceId);
    if (err) throw new Error(err.message);
  }, []);

  // Rejected devices are hidden from the general dashboard views (overview, OTA, groups, device
  // table, …). The Enrollment board still needs them for its "rejected" lane, so it reads the
  // unfiltered `allDevices` instead.
  const visibleDevices = useMemo(() => devices.filter(d => d.otaStatus !== 'rejected'), [devices]);

  return { devices: visibleDevices, allDevices: devices, loading, error, setEnrollment, setEnrollmentBulk, setDeviceTags, setDeviceName, deleteRejectedDevices };
}
