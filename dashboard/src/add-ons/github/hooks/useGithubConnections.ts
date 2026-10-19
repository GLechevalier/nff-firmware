import { useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import { useSharedResource } from '../../../lib/sharedResource';
import { babynffConnection } from '../../../data/babynffRepo';
import type { DeployPolicy, GithubConnection } from '../types/github';

function mapRow(row: Record<string, unknown>): GithubConnection {
  return {
    id: row.id as string,
    repoFullName: row.repo_full_name as string,
    installationId: (row.installation_id as number | null) ?? null,
    productionBranch: (row.production_branch as string) ?? 'main',
    deviceGroupId: (row.device_group_id as string | null) ?? null,
    deviceTypes: (row.device_types as string[]) ?? [],
    deployPolicy: (row.deploy_policy as DeployPolicy) ?? 'auto',
    createdAt: new Date(row.created_at as string),
  };
}

const keyFor = (projectId: string) => `github-connections:${projectId}`;

async function fetchConnections(projectId: string): Promise<GithubConnection[]> {
  const { data, error } = await supabase
    .from('github_connections')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(row => mapRow(row as Record<string, unknown>));
}

// Connected repos. Changes rarely (only on connect_repo); fetched on load and kept
// live via Realtime (github_connections is published in 0003_github.sql).
export function useGithubConnections() {
  const { currentProjectId, currentProject } = useCurrentProject();
  const key = currentProjectId ? keyFor(currentProjectId) : null;

  const { data, loading, error } = useSharedResource<GithubConnection[]>(key, {
    fetcher: () => fetchConnections(currentProjectId),
    subscribe: ({ mutate }) => {
      const channel = supabase
        .channel(`gh-connections-${Math.random().toString(36).slice(2)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'github_connections', filter: `project_id=eq.${currentProjectId}` }, payload => {
          if (payload.eventType === 'DELETE') {
            const id = (payload.old as Record<string, unknown>).id as string;
            mutate(prev => (prev ?? []).filter(c => c.id !== id));
            return;
          }
          const conn = mapRow(payload.new as Record<string, unknown>);
          mutate(prev => [conn, ...(prev ?? []).filter(c => c.id !== conn.id)]);
        })
        .subscribe();
      return () => { supabase.removeChannel(channel); };
    },
  });

  const connections = useMemo(() => data ?? [], [data]);

  // On the first-login demo project with no real repo yet, surface the bundled babynff-repo so the
  // Code/GitHub tabs aren't a dead end (served locally by useRepoTree/fetchRepoFile). It drops out
  // the moment a real connection exists.
  const displayed = useMemo(() => {
    if (connections.length === 0 && currentProject?.is_demo && currentProjectId) {
      return [babynffConnection(currentProjectId)];
    }
    return connections;
  }, [connections, currentProject?.is_demo, currentProjectId]);

  return { connections: displayed, loading, error };
}
