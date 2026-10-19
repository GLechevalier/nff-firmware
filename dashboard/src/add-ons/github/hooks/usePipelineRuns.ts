import { useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { useSharedResource } from '../../../lib/sharedResource';
import type { PipelineRun, PipelineStatus, PipelineTrigger } from '../types/github';

function mapRow(row: Record<string, unknown>): PipelineRun {
  return {
    id: row.id as string,
    connectionId: row.connection_id as string,
    commitSha: row.commit_sha as string,
    commitMessage: (row.commit_message as string | null) ?? null,
    trigger: (row.trigger as PipelineTrigger) ?? 'push',
    status: (row.status as PipelineStatus) ?? 'queued',
    firmwareVersion: (row.firmware_version as string | null) ?? null,
    deploymentId: (row.deployment_id as string | null) ?? null,
    prNumber: (row.pr_number as number | null) ?? null,
    error: (row.error as string | null) ?? null,
    logs: (row.logs as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

// The query carries no project filter (RLS scopes the rows to the caller's projects), so the
// shared-resource key isn't project-scoped either — it must describe exactly what was fetched.
const KEY = 'pipeline_runs:all';

async function fetchPipelineRuns(): Promise<PipelineRun[]> {
  const { data, error } = await supabase
    .from('pipeline_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []).map(row => mapRow(row as Record<string, unknown>));
}

// Live deploy pipeline runs (pipeline_runs is published to supabase_realtime in
// 0003_github.sql), newest first. Mirrors useDeployments.
export function usePipelineRuns() {
  const { data, loading, error } = useSharedResource<PipelineRun[]>(KEY, {
    fetcher: fetchPipelineRuns,
    subscribe: ({ mutate }) => {
      const channel = supabase
        .channel(`pipeline-runs-${Math.random().toString(36).slice(2)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pipeline_runs' }, payload => {
          if (payload.eventType === 'INSERT') {
            const run = mapRow(payload.new as Record<string, unknown>);
            mutate(prev => ((prev ?? []).some(r => r.id === run.id) ? prev : [run, ...(prev ?? [])]));
          } else if (payload.eventType === 'UPDATE') {
            const run = mapRow(payload.new as Record<string, unknown>);
            mutate(prev => (prev ?? []).map(r => (r.id === run.id ? run : r)));
          } else if (payload.eventType === 'DELETE') {
            const id = (payload.old as Record<string, unknown>).id as string;
            mutate(prev => (prev ?? []).filter(r => r.id !== id));
          }
        })
        .subscribe();

      return () => { supabase.removeChannel(channel); };
    },
  });

  const runs = useMemo(() => data ?? [], [data]);

  // Manual redeploy: insert a queued pipeline_runs row for an existing run's commit. This
  // is a plain RLS-scoped row write (migration 0061 lets a member insert only a queued,
  // manual run for a repo connection in their project) — exactly like useDeployments
  // create/abort. nff-github's build worker picks up the queued row and runs the
  // build+rollout, so no internal secret leaves Supabase. The INSERT streams back through
  // the subscription above, so the new run appears in the list immediately.
  async function requestRedeploy(run: PipelineRun): Promise<void> {
    const { error: err } = await supabase.from('pipeline_runs').insert({
      connection_id: run.connectionId,
      commit_sha: run.commitSha,
      commit_message: run.commitMessage,
      trigger: 'manual',
      status: 'queued',
    });
    if (err) throw new Error(err.message);
  }

  return { runs, loading, error, requestRedeploy };
}
