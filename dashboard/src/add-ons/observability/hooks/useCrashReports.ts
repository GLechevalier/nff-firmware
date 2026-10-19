import { useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import { useSharedResource } from '../../../lib/sharedResource';
import type { DeviceStatus } from '../../../types/device';
import type { CrashReport, BacktraceFrame, RtcLogLine } from '../types/crash';

function mapRow(row: Record<string, unknown>): CrashReport {
  const deviceRel = row.devices as Record<string, unknown> | null;
  const frames = (row.backtrace_frames as Record<string, unknown>[] | null) ?? [];
  const logs   = (row.rtc_log_lines   as Record<string, unknown>[] | null) ?? [];

  const backtrace: BacktraceFrame[] = [...frames]
    .sort((a, b) => (a.position as number) - (b.position as number))
    .map(f => ({ address: f.address as string, resolved: (f.resolved as string | null) ?? undefined }));

  const rtcLog: RtcLogLine[] = [...logs]
    .sort((a, b) => (a.position as number) - (b.position as number))
    .map(l => ({
      level: l.level as 'I' | 'W' | 'E',
      tag: l.tag as string,
      message: l.message as string,
      msBeforeCrash: l.ms_before_crash as number,
    }));

  return {
    id: row.id as string,
    deviceId: row.device_id as string,
    deviceName: deviceRel?.name as string ?? row.device_id as string,
    deviceStatus: (deviceRel?.status as DeviceStatus | null) ?? 'offline',
    timestamp: new Date(row.ts as string),
    reason: row.reason as string,
    exceptionCause: (row.exception_cause as number | null) ?? 0,
    pc: (row.pc as string | null) ?? '',
    uptimeMs: (row.uptime_ms as number | null) ?? 0,
    crashCount: row.crash_count as number,
    fwVersion: (row.fw_version as string | null) ?? '',
    buildId: (row.build_id as string | null) ?? '',
    backtrace,
    rtcLog,
    retained: row.retained as boolean,
  };
}

const keyFor = (projectId: string) => `crashes:${projectId}`;

// Source of truth = l2_visible_crashes RPC: the caller's own crashes PLUS the real crashes of any
// pool L2 they currently hold a lease on, with the leased crash's project_id rewritten to the
// caller's and its device name aliased (migration 0075). Falls back to the raw project-scoped
// select where the RPC isn't deployed yet.
async function fetchCrashes(projectId: string): Promise<CrashReport[]> {
  const { data, error } = await supabase.rpc('l2_visible_crashes', { p_project_id: projectId });
  if (error) {
    const raw = await supabase
      .from('crash_reports')
      .select('*, devices(name, status), backtrace_frames(*), rtc_log_lines(*)')
      .eq('project_id', projectId)
      .order('ts', { ascending: false })
      .limit(50);
    if (raw.error) throw new Error(raw.error.message);
    return (raw.data ?? []).map(row => mapRow(row as Record<string, unknown>));
  }
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  return rows.slice(0, 50).map(mapRow);
}

/**
 * The project's crash reports. Shared across every call site (CrashTab, DeviceHealthContext,
 * FleetIncidentModal, OnboardingTab) — one query and one set of channels for all of them.
 *
 * The old per-instance `useId()` channel topic is gone with the duplication it existed to work
 * around: Supabase hands back the SAME channel object for the same topic name, and calling .on()
 * on an already-subscribed channel throws, so four instances needed four distinct topics. There is
 * only one subscriber now.
 */
export function useCrashReports() {
  const { currentProjectId } = useCurrentProject();
  const key = currentProjectId ? keyFor(currentProjectId) : null;

  const { data, loading, error } = useSharedResource<CrashReport[]>(key, {
    fetcher: () => fetchCrashes(currentProjectId),
    // A crash report and its backtrace_frames / rtc_log_lines are inserted in separate statements,
    // so re-fetch on any crash_reports change to pick up the parent + its children together
    // (granular payload-patching can't, since the children aren't in the crash_reports payload).
    // Each refetch is heavy — 50 crashes joined with all frames + log lines — and the self-heal
    // demo/floor deliberately crash-loops, so debounce generously (1.5s) to collapse a burst of
    // crashes into ONE refetch. The extra latency before a new crash appears is imperceptible.
    debounceMs: 1500,
    subscribe: ({ refetch }) => {
      const channelId = Math.random().toString(36).slice(2);
      let leasedChannel: ReturnType<typeof supabase.channel> | null = null;
      let leasedDeviceId: string | null = null;

      // crash_reports is published in migration 0033.
      const channel = supabase
        .channel(`crash_reports:${currentProjectId}:${channelId}`)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'crash_reports', filter: `project_id=eq.${currentProjectId}` },
          refetch)
        .subscribe();

      // A leased pool L2's crashes land in the pool project, so the project-scoped channel above
      // won't see them. Watch the caller's own leases (RLS-restricted); on an active lease, open a
      // device-filtered crash channel so the real backtrace streams in live, and refetch so it
      // appears/vanishes with the lease.
      const leaseChannel = supabase
        .channel(`l2-leases-crash:${currentProjectId}:${channelId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'l2_leases' }, payload => {
          const row = (payload.new ?? payload.old) as Record<string, unknown> | null;
          const state = row?.state as string | undefined;
          const devId = row?.device_id as string | null | undefined;
          if (state === 'active' && devId && devId !== leasedDeviceId) {
            if (leasedChannel) void supabase.removeChannel(leasedChannel);
            leasedDeviceId = devId;
            leasedChannel = supabase
              .channel(`crash-leased:${channelId}:${devId}`)
              .on('postgres_changes', { event: '*', schema: 'public', table: 'crash_reports', filter: `device_id=eq.${devId}` }, refetch)
              .subscribe();
          } else if (state !== 'active' && leasedChannel) {
            void supabase.removeChannel(leasedChannel);
            leasedChannel = null;
            leasedDeviceId = null;
          }
          refetch();
        })
        .subscribe();

      return () => {
        void supabase.removeChannel(channel);
        void supabase.removeChannel(leaseChannel);
        if (leasedChannel) void supabase.removeChannel(leasedChannel);
      };
    },
  });

  const crashes = useMemo(() => data ?? [], [data]);

  return { crashes, loading, error };
}
