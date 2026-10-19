// useRepoBranches — list a connected repo's real GitHub branches for the Code-tab git graph,
// used only when the project opts into showing "all GitHub branches" (not just the agent's own
// feature/fix branches). The browser holds no GitHub credentials, so this hits the server-side
// proxy (/api/github/repo-branches → nff-github /internal/repo-branches). Cached per session.
//
// `enabled` lets the caller skip the fetch entirely (the default 'agent' branch-source) so we
// never hit GitHub unless a user asked for all branches.

import { useEffect, useRef, useState } from 'react';

export interface RepoBranch { name: string; commitSha: string | null; isDefault: boolean }

export interface RepoBranchesState {
  branches: RepoBranch[];
  defaultBranch: string | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: RepoBranchesState = { branches: [], defaultBranch: null, loading: false, error: null };

// Session cache of resolved branch lists, keyed by repo_full_name.
const branchCache = new Map<string, RepoBranchesState>();

export function useRepoBranches(repoFullName: string | null, enabled: boolean): RepoBranchesState {
  const [state, setState] = useState<RepoBranchesState>(() =>
    enabled && repoFullName ? branchCache.get(repoFullName) ?? EMPTY : EMPTY,
  );
  // Guards against a late response from a previous repo overwriting the current one.
  const reqRef = useRef(0);

  useEffect(() => {
    if (!enabled || !repoFullName) { setState(EMPTY); return; }

    const cached = branchCache.get(repoFullName);
    if (cached) { setState(cached); return; }

    const myReq = ++reqRef.current;
    setState({ ...EMPTY, loading: true });

    (async () => {
      try {
        const qs = new URLSearchParams({ repo_full_name: repoFullName });
        const resp = await fetch(`/api/github/repo-branches?${qs.toString()}`);
        const data = await resp.json().catch(() => null);
        if (myReq !== reqRef.current) return;  // a newer repo selection superseded this one
        if (!resp.ok || !data?.ok) {
          setState({ ...EMPTY, error: (data?.error as string) || `repo-branches returned ${resp.status}` });
          return;
        }
        const branches: RepoBranch[] = Array.isArray(data.branches)
          ? data.branches.map((b: { name: string; commit_sha?: string | null; is_default?: boolean }) => ({
              name: b.name, commitSha: b.commit_sha ?? null, isDefault: !!b.is_default,
            }))
          : [];
        const next: RepoBranchesState = {
          branches, defaultBranch: data.default_branch ?? null, loading: false, error: null,
        };
        branchCache.set(repoFullName, next);
        setState(next);
      } catch (e) {
        if (myReq !== reqRef.current) return;
        setState({ ...EMPTY, error: (e as Error)?.message ?? 'failed to load branches' });
      }
    })();
  }, [repoFullName, enabled]);

  return state;
}
