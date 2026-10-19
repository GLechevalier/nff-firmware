import { useMemo } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase as dashboardSupabase } from '../../../lib/supabase';
import { useSharedResource } from '../../../lib/sharedResource';
import type { GithubInstallation } from '../types/github';

// GitHub App installations bound to a project (github_installations, 0149). Written only by
// nff-github (the Setup-URL callback); kept live via Realtime so "Connect GitHub" flips to
// "connected as @login" the moment the user lands back from github.com.
//
// Host-agnostic: the dashboard uses its own Supabase client; nff-admin passes the add-ons one.

function mapRow(row: Record<string, unknown>): GithubInstallation {
  return {
    installationId: row.installation_id as number,
    projectId: row.project_id as string,
    accountLogin: (row.account_login as string) ?? '',
    accountType: (row.account_type as string) ?? '',
    createdAt: new Date(row.created_at as string),
  };
}

export function useGithubInstallations(projectId: string | null, client: SupabaseClient = dashboardSupabase) {
  const key = projectId ? `github-installations:${projectId}` : null;

  const { data, loading, error } = useSharedResource<GithubInstallation[]>(key, {
    fetcher: async () => {
      const { data, error } = await client
        .from('github_installations')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []).map(row => mapRow(row as Record<string, unknown>));
    },
    subscribe: ({ mutate }) => {
      const channel = client
        .channel(`gh-installations-${Math.random().toString(36).slice(2)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'github_installations', filter: `project_id=eq.${projectId}` }, payload => {
          if (payload.eventType === 'DELETE') {
            const id = (payload.old as Record<string, unknown>).installation_id as number;
            mutate(prev => (prev ?? []).filter(i => i.installationId !== id));
            return;
          }
          const inst = mapRow(payload.new as Record<string, unknown>);
          mutate(prev => [inst, ...(prev ?? []).filter(i => i.installationId !== inst.installationId)]);
        })
        .subscribe();
      return () => { client.removeChannel(channel); };
    },
  });

  const installations = useMemo(() => data ?? [], [data]);
  return { installations, loading, error };
}
