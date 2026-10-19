import { useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import { useSharedResource } from '../../../lib/sharedResource';
import type { Deployment, DeploymentStatus } from '../types/ota';

function mapRow(row: Record<string, unknown>): Deployment {
  return {
    id: row.id as string,
    name: row.name as string,
    targetVersion: row.target_version as string,
    deviceGroupId: row.device_group_id as string,
    status: row.status as DeploymentStatus,
    maxDevicesInFlight: row.max_devices_in_flight as number,
    retries: row.retries as number,
    createdAt: new Date(row.created_at as string),
    startTime: row.start_time ? new Date(row.start_time as string) : null,
    haltedReason: (row.halted_reason as string | null) ?? null,
  };
}

interface CreateDeploymentOpts {
  name: string;
  targetVersion: string;
  deviceGroupId: string;
  maxDevicesInFlight?: number;
  retries?: number;
  startTime?: string | null;
}

const keyFor = (projectId: string) => `deployments:${projectId}`;

async function fetchDeployments(projectId: string): Promise<Deployment[]> {
  const { data, error } = await supabase
    .from('deployments')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []).map(row => mapRow(row as Record<string, unknown>));
}

export function useDeployments() {
  const { currentProjectId } = useCurrentProject();
  const key = currentProjectId ? keyFor(currentProjectId) : null;

  const { data, loading, error } = useSharedResource<Deployment[]>(key, {
    fetcher: () => fetchDeployments(currentProjectId),
    subscribe: ({ mutate }) => {
      const channelId = Math.random().toString(36).slice(2);
      const channel = supabase
        .channel(`deployments-${channelId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `project_id=eq.${currentProjectId}` }, payload => {
          if (payload.eventType === 'INSERT') {
            const dep = mapRow(payload.new as Record<string, unknown>);
            mutate(prev => ((prev ?? []).some(d => d.id === dep.id) ? prev : [dep, ...(prev ?? [])]));
          } else if (payload.eventType === 'UPDATE') {
            const dep = mapRow(payload.new as Record<string, unknown>);
            mutate(prev => (prev ?? []).map(d => (d.id === dep.id ? dep : d)));
          } else if (payload.eventType === 'DELETE') {
            const deletedId = (payload.old as Record<string, unknown>).id as string;
            mutate(prev => (prev ?? []).filter(d => d.id !== deletedId));
          }
        })
        .subscribe();

      return () => { supabase.removeChannel(channel); };
    },
  });

  const deployments = useMemo(() => data ?? [], [data]);

  // Insert a 'scheduled' deployment row. The nff-ota deployment poller picks it up,
  // materializes its per-device jobs from the group, and asks fleet to push firmware.
  async function createDeployment(opts: CreateDeploymentOpts): Promise<string> {
    const id = crypto.randomUUID();
    const { error: err } = await supabase.from('deployments').insert({
      id,
      name: opts.name,
      target_version: opts.targetVersion,
      device_group_id: opts.deviceGroupId,
      status: 'scheduled',
      max_devices_in_flight: opts.maxDevicesInFlight ?? 10,
      retries: opts.retries ?? 3,
      start_time: opts.startTime ?? null,
      project_id: currentProjectId,
    });
    if (err) throw new Error(err.message);
    return id;
  }

  async function abortDeployment(id: string): Promise<void> {
    const { error: err } = await supabase.from('deployments').update({ status: 'aborted' }).eq('id', id);
    if (err) throw new Error(err.message);
  }

  // Resolve a rate-limit pause — both are plain row writes (RLS scopes them to the member's
  // project), the same way createDeployment/abortDeployment work; nff-ota's poller acts on
  // them with its service-role connection, so no secret ever leaves Supabase.
  //   • Override: flip back to active + set the one-shot `rate_limit_override` flag; the poller
  //     re-delivers ignoring the window and clears the flag.
  //   • Decline: abort it (tagged) so the UI shows "declined".
  async function overrideRateLimit(id: string): Promise<void> {
    const { error: err } = await supabase
      .from('deployments')
      .update({ status: 'active', halted_reason: null, rate_limit_override: true })
      .eq('id', id);
    if (err) throw new Error(err.message);
  }

  async function declineDeployment(id: string): Promise<void> {
    const { error: err } = await supabase
      .from('deployments')
      .update({ status: 'aborted', halted_reason: 'declined: rate-limited' })
      .eq('id', id);
    if (err) throw new Error(err.message);
  }

  return { deployments, loading, error, createDeployment, abortDeployment, overrideRateLimit, declineDeployment };
}
