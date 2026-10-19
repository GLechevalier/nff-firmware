// useRepoTree — fetch a connected repo's full file structure for the "Code" tab, so the
// agent's edited files can be shown in the context of the whole repo. The browser has no
// GitHub credentials, so this hits the server-side proxy (/api/github/repo-tree →
// nff-github /internal/repo-tree). Plus a lazy fetchRepoFile() for viewing a non-edited
// file's content on demand. Both are cached per session to avoid refetching on re-select.

import { useEffect, useRef, useState } from 'react';
import { BABYNFF_REPO, babynffRepoTree, babynffRepoFile } from '../data/babynffRepo';
import { useDemoBrokenNow } from '../context/DeviceHealthContext';

export interface RepoTreeEntry { path: string; type: 'blob' | 'tree' }

export interface RepoTreeState {
  entries: RepoTreeEntry[];
  sha: string | null;        // tree sha — used as the ref when lazily reading a file
  truncated: boolean;        // GitHub capped a huge tree → caller should fall back
  loading: boolean;
  error: string | null;
}

const EMPTY: RepoTreeState = { entries: [], sha: null, truncated: false, loading: false, error: null };

// Session cache of resolved trees, keyed by repo_full_name@ref. Lives for the page session.
const treeCache = new Map<string, RepoTreeState>();
const treeKey = (repo: string, ref?: string | null) => `${repo}@${ref ?? ''}`;

// Drop the cached tree (and any cached files) for a repo@ref so the next render refetches.
// Called when a push lands new code on the branch (see CodeTab's repo_updated handler) —
// the server-side disk cache is already fresh, but this session cache would otherwise pin
// the stale tree until reload.
export function invalidateRepoTree(repo: string, ref?: string | null) {
  treeCache.delete(treeKey(repo, ref));
  const filePrefix = `${repo}@${ref ?? ''}:`;
  for (const k of fileCache.keys()) if (k.startsWith(filePrefix)) fileCache.delete(k);
}

// Fetch a connected repo's full file tree at a ref (default branch when ref omitted).
// `nonce` lets a caller force a refetch (bump it) without changing repo/ref — paired with
// invalidateRepoTree() above to pick up code pushed since the last fetch.
export function useRepoTree(repoFullName: string | null, ref?: string | null, nonce?: number): RepoTreeState {
  const [state, setState] = useState<RepoTreeState>(() =>
    repoFullName ? treeCache.get(treeKey(repoFullName, ref)) ?? EMPTY : EMPTY,
  );
  // The bundled demo repo serves the buggy sketch only while the break demo's device is still
  // broken. Inert for every real repo — the flag only reaches babynffRepoTree below.
  const demoBroken = useDemoBrokenNow();
  // Guards against a late response from a previous repo overwriting the current one.
  const reqRef = useRef(0);

  useEffect(() => {
    if (!repoFullName) { setState(EMPTY); return; }

    // The bundled demo repo is served locally (no nff-github clone exists for it). The sha it hands
    // back encodes `demoBroken`, and CodeTab passes that sha to fetchRepoFile as the ref — so when
    // the break lands, the sha flips, the file cache key changes, and the buggy sketch is read.
    if (repoFullName === BABYNFF_REPO) {
      const { entries, sha } = babynffRepoTree(demoBroken);
      setState({ entries, sha, truncated: false, loading: false, error: null });
      return;
    }

    const key = treeKey(repoFullName, ref);
    const cached = treeCache.get(key);
    if (cached) { setState(cached); return; }

    const myReq = ++reqRef.current;
    setState({ ...EMPTY, loading: true });

    (async () => {
      try {
        const qs = new URLSearchParams({ repo_full_name: repoFullName });
        if (ref) qs.set('ref', ref);
        const resp = await fetch(`/api/github/repo-tree?${qs.toString()}`);
        const data = await resp.json().catch(() => null);
        if (myReq !== reqRef.current) return;  // a newer repo selection superseded this one
        if (!resp.ok || !data?.ok) {
          setState({ ...EMPTY, error: (data?.error as string) || `repo-tree returned ${resp.status}` });
          return;
        }
        const next: RepoTreeState = {
          entries: Array.isArray(data.entries) ? data.entries : [],
          sha: data.sha ?? null,
          truncated: !!data.truncated,
          loading: false,
          error: null,
        };
        treeCache.set(key, next);
        setState(next);
      } catch (e) {
        if (myReq !== reqRef.current) return;
        setState({ ...EMPTY, error: (e as Error)?.message ?? 'failed to load repo tree' });
      }
    })();
  }, [repoFullName, ref, nonce, demoBroken]);

  return state;
}

// Lazy single-file read for a NON-edited file the user clicks (edited files already carry
// their drafted content in the run). Cached per repo:ref:path for the session.
const fileCache = new Map<string, string | null>();

export async function fetchRepoFile(
  repoFullName: string, path: string, ref?: string | null,
): Promise<{ content: string | null; error: string | null }> {
  // The bundled demo repo is served locally (no nff-github clone exists for it). `ref` is the tree
  // sha useRepoTree handed back, which is what selects the healthy vs. broken main/main.c.
  if (repoFullName === BABYNFF_REPO) return { content: babynffRepoFile(path, ref), error: null };

  const key = `${repoFullName}@${ref ?? ''}:${path}`;
  if (fileCache.has(key)) return { content: fileCache.get(key) ?? null, error: null };

  const qs = new URLSearchParams({ repo_full_name: repoFullName, path });
  if (ref) qs.set('ref', ref);
  try {
    const resp = await fetch(`/api/github/repo-file?${qs.toString()}`);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.ok) {
      return { content: null, error: (data?.error as string) || `repo-file returned ${resp.status}` };
    }
    const content = (data.content ?? null) as string | null;
    fileCache.set(key, content);
    return { content, error: null };
  } catch (e) {
    return { content: null, error: (e as Error)?.message ?? 'failed to load file' };
  }
}
