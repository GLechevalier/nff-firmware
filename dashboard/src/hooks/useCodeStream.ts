import { useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { useCurrentProject } from '../context/CurrentProjectContext';
import { peek, useSharedResource } from '../lib/sharedResource';
import type { CodeFile, CodeStreamRow, CodeStreamStatus, LiveCodeSession } from '../types/code';

// nff-agent-worker drives this tab two ways (see nff-agent-worker/src/codeStream.ts):
//   • a Realtime BROADCAST channel "code-stream:<projectId>" carries the live frames
//     (reasoning deltas + drafted files) — ephemeral, assembled per runId below;
//   • the agent_code_streams table (migration 0050) holds a row per code-run for history.
// Reasoning is only ever broadcast (never stored), so a run replayed from history shows
// its files + PR but not its reasoning — only sessions watched live carry reasoning.

function mapRow(row: Record<string, unknown>): CodeStreamRow {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    sessionId: (row.session_id as string | null) ?? null,
    repoFullName: (row.repo_full_name as string | null) ?? null,
    files: ((row.files as CodeFile[] | null) ?? []).filter(
      f => f && typeof f.path === 'string' && typeof f.content === 'string',
    ),
    prNumber: (row.pr_number as number | null) ?? null,
    prUrl: (row.pr_url as string | null) ?? null,
    status: (row.status as CodeStreamStatus) ?? 'streaming',
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

interface Frame {
  runId: string;
  sessionId?: string | null;
  text?: string;
  path?: string;
  content?: string;
  before?: string | null;   // the pre-edit content of `path`, when the agent read it first
  status?: CodeStreamStatus;
  repo?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
}

// Signal that a push refreshed the deployed code for a repo@ref (nff-github broadcasts this
// after warming its on-disk cache). `n` increments per event so each is a new object identity
// even when repo+ref repeat — lets a consumer effect re-run on every push.
export interface RepoUpdate { repo: string; ref: string | null; n: number }

/** History comes from the table; `live` and `repoUpdate` are assembled purely from broadcast frames
 *  and have no server-side source to re-read. They therefore live in the same shared entry and are
 *  carried across a revalidate rather than re-fetched. */
interface CodeStreamState {
  history: CodeStreamRow[];
  live: Record<string, LiveCodeSession>;
  repoUpdate: RepoUpdate | null;
}

const keyFor = (projectId: string) => `code-stream:${projectId}`;

async function fetchHistory(projectId: string): Promise<CodeStreamRow[]> {
  const { data, error } = await supabase
    .from('agent_code_streams')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []).map(r => mapRow(r as Record<string, unknown>));
}

const EMPTY_LIVE: Record<string, LiveCodeSession> = {};

/**
 * The project's code runs — history from the table, live runs assembled from broadcast frames.
 *
 * Shared across all five call sites (CodeTab, DemoCodeWatcher, BuildChecklistModal, useGitGraph,
 * useDemoPullRequests). That also fixes a latent bug: the broadcast topic `code-stream:<projectId>`
 * is NOT instance-unique, and Supabase hands back the SAME channel object for a given topic — so
 * five mounted instances were each calling .on() and .subscribe() on one shared channel. There is
 * exactly one subscriber now.
 */
export function useCodeStream() {
  const { currentProjectId } = useCurrentProject();
  const key = currentProjectId ? keyFor(currentProjectId) : null;

  const { data, loading, error } = useSharedResource<CodeStreamState>(key, {
    // A revalidate must not blow away the live sessions, which exist only in memory — fold the
    // freshly-read history into whatever the broadcast handlers have accumulated.
    fetcher: async () => {
      const prev = key ? peek<CodeStreamState>(key) : undefined;
      const history = await fetchHistory(currentProjectId);
      return { history, live: prev?.live ?? {}, repoUpdate: prev?.repoUpdate ?? null };
    },
    subscribe: ({ mutate }) => {
      const id = Math.random().toString(36).slice(2);

      // ── History: live row INSERT/UPDATE/DELETE ──
      const historyChannel = supabase
        .channel(`code-streams-${id}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'agent_code_streams', filter: `project_id=eq.${currentProjectId}` },
          payload => {
            if (payload.eventType === 'DELETE') {
              const gone = (payload.old as Record<string, unknown>).id as string;
              mutate(prev => (prev ? { ...prev, history: prev.history.filter(r => r.id !== gone) } : prev));
              return;
            }
            const row = mapRow(payload.new as Record<string, unknown>);
            mutate(prev => prev && ({
              ...prev,
              history: [row, ...prev.history.filter(r => r.id !== row.id)]
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
            }));
          },
        )
        .subscribe();

      // ── Live: broadcast frames on the project's code-stream channel ──
      const apply = (frame: Frame) =>
        mutate(prevState => {
          if (!prevState) return prevState;
          const s: LiveCodeSession = prevState.live[frame.runId] ?? {
            runId: frame.runId,
            sessionId: frame.sessionId ?? null,
            repoFullName: null,
            reasoning: '',
            files: [],
            status: 'streaming',
            prNumber: null,
            prUrl: null,
            live: true,
            startedAt: new Date(),
          };
          const next: LiveCodeSession = { ...s };
          if (frame.text) next.reasoning = s.reasoning + frame.text;
          if (typeof frame.path === 'string' && typeof frame.content === 'string') {
            // Dedup by path: a re-emitted file replaces the prior draft. `before` rides along so the
            // tab can diff; the worker keys it off what the agent READ, so a redraft still carries
            // the original — dropping it here would silently disable the diff on live runs only.
            next.files = [
              ...s.files.filter(f => f.path !== frame.path),
              { path: frame.path, content: frame.content, before: frame.before ?? null },
            ];
          }
          if (frame.status) {
            next.status = frame.status;
            next.live = frame.status !== 'done' && frame.status !== 'error';
          }
          if (frame.repo !== undefined && frame.repo !== null) next.repoFullName = frame.repo;
          if (frame.prUrl !== undefined && frame.prUrl !== null) next.prUrl = frame.prUrl;
          if (frame.prNumber !== undefined && frame.prNumber !== null) next.prNumber = frame.prNumber;
          return { ...prevState, live: { ...prevState.live, [frame.runId]: next } };
        });

      const liveChannel = supabase.channel(`code-stream:${currentProjectId}`);
      for (const ev of ['reasoning', 'file', 'status'] as const) {
        liveChannel.on('broadcast', { event: ev }, msg => apply((msg.payload ?? {}) as Frame));
      }
      // A push refreshed the deployed branch on the server — surface it so the Code tab can
      // bust its session cache and refetch the latest tree/files (see CodeTab).
      liveChannel.on('broadcast', { event: 'repo_updated' }, msg => {
        const p = (msg.payload ?? {}) as { repo?: string; ref?: string | null };
        if (!p.repo) return;
        mutate(prev => prev && ({
          ...prev,
          repoUpdate: { repo: p.repo!, ref: p.ref ?? null, n: (prev.repoUpdate?.n ?? 0) + 1 },
        }));
      });
      liveChannel.subscribe();

      return () => {
        supabase.removeChannel(historyChannel);
        supabase.removeChannel(liveChannel);
      };
    },
  });

  const history = useMemo(() => data?.history ?? [], [data]);
  const live = useMemo(() => Object.values(data?.live ?? EMPTY_LIVE), [data]);

  return { live, history, repoUpdate: data?.repoUpdate ?? null, loading, error };
}
