// useBrainCommits — fetch + poll the brain's commit history for one branch
// (GET /api/tables/brain/commits?branch=..., served by api/_lib/brain.ts's
// listCommits, migration 0140). Mirrors useRepoGraph.ts's shape exactly —
// same poll hook, same "one branch's log" scope — but for the KNOWLEDGE
// GRAPH's commit DAG rather than a real git repo.

import { useApiPoll } from '../../hooks/useApiPoll';

export interface BrainCommitDiffNode {
  id: string;
  title: string;
  category: string;
  content: string;
}

export interface BrainCommitDiff {
  nodesAdded: BrainCommitDiffNode[];
  nodesModified: BrainCommitDiffNode[];
  nodesRemoved: string[];
  edgesAddedCount: number;
  edgesRemovedCount: number;
}

export interface BrainCommit {
  id: string;
  branch: string;
  parents: string[];
  author: string;
  ts: string;
  message: string;
  diff: BrainCommitDiff;
}

const POLL_MS = 30_000;

export function useBrainCommits(branch = 'main') {
  const { data, error, refresh } = useApiPoll<{ commits: BrainCommit[] }>(
    `/api/tables/brain/commits?branch=${encodeURIComponent(branch)}`,
    POLL_MS,
  );
  return { commits: data?.commits ?? [], error, refresh };
}
