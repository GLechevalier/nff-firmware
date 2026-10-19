import { useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import { useSharedResource } from '../../../lib/sharedResource';
import type { OtaJob, OtaStatus } from '../data/mockOtaJobs';

function mapRow(row: Record<string, unknown>): OtaJob {
  const deviceRel = row.devices as Record<string, unknown> | null;
  return {
    id: row.id as string,
    deviceId: row.device_id as string,
    deviceName: (deviceRel?.name as string) ?? (row.device_id as string),
    fromVersion: row.from_version as string,
    targetVersion: row.target_version as string,
    status: row.status as OtaStatus,
    progress: row.progress as number,
    startedAt: new Date(row.started_at as string),
    completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
    deploymentId: (row.deployment_id as string | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
  };
}

const keyFor = (projectId: string) => `ota_jobs:${projectId}`;

async function fetchOtaJobs(projectId: string): Promise<OtaJob[]> {
  const { data, error } = await supabase
    .from('ota_jobs')
    .select('*, devices(name)')
    .eq('project_id', projectId)
    .order('started_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []).map(row => mapRow(row as Record<string, unknown>));
}

export function useOtaJobs() {
  const { currentProjectId } = useCurrentProject();
  const key = currentProjectId ? keyFor(currentProjectId) : null;

  const { data, loading, error } = useSharedResource<OtaJob[]>(key, {
    fetcher: () => fetchOtaJobs(currentProjectId),
    subscribe: ({ mutate }) => {
      // Live job progress: the backend (poller delivery + ota_result feedback loop +
      // reaper) drives ota_jobs status/progress; the dashboard just reflects it.
      // Realtime change rows have no joined devices(name) — OtaTab resolves names from
      // its devices list, so the device_id fallback here is fine.
      const channelId = Math.random().toString(36).slice(2);
      const channel = supabase
        .channel(`ota_jobs-${channelId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ota_jobs', filter: `project_id=eq.${currentProjectId}` }, payload => {
          if (payload.eventType === 'INSERT') {
            const job = mapRow(payload.new as Record<string, unknown>);
            mutate(prev => ((prev ?? []).some(j => j.id === job.id) ? prev : [job, ...(prev ?? [])]));
          } else if (payload.eventType === 'UPDATE') {
            const job = mapRow(payload.new as Record<string, unknown>);
            mutate(prev => (prev ?? []).map(j => (j.id === job.id ? { ...job, deviceName: j.deviceName } : j)));
          } else if (payload.eventType === 'DELETE') {
            const deletedId = (payload.old as Record<string, unknown>).id as string;
            mutate(prev => (prev ?? []).filter(j => j.id !== deletedId));
          }
        })
        .subscribe();

      return () => { supabase.removeChannel(channel); };
    },
  });

  const jobs = useMemo(() => data ?? [], [data]);

  return { jobs, loading, error };
}
