import { useMemo } from 'react';
import { usePipelineRuns } from '../add-ons/github/hooks/usePipelineRuns';
import { useBuilderFeatures } from './useBuilderFeatures';
import { useCodeStream } from './useCodeStream';
import { useGithubConnections } from '../add-ons/github/hooks/useGithubConnections';
import { useRepoBranches } from './useRepoBranches';
import { useCurrentProject } from '../context/CurrentProjectContext';
import { useDemoBrokeAt, useDemoBrokenNow } from '../context/DeviceHealthContext';
import { BABYNFF_REPO } from '../data/babynffRepo';
import { babynffDemoCommits, babynffFeatureCommits } from '../data/babynffDemoGit';
import { demoFixSource } from '../data/babynffCodeStream';
import type { PipelineStatus } from '../add-ons/github/types/github';
import type { FeatureStatus } from '../types/builderFeature';
import type { CodeStreamStatus } from '../types/code';

// Assembles the "git graph" for one repo purely from data the dashboard already streams
// live (no new table): pipeline_runs = the production branch's commits + deploy status;
// builder_features = the agent's nff-feature/* branches + their lifecycle (+ PR once opened);
// agent_code_streams = live "writing now" + repair (nff-fix/*) PRs. The Code-tab CommitGraph
// renders this and updates in real time as the agent branches → writes → opens a PR → merges.

// One commit on the production branch (a pipeline run).
export interface GraphCommit {
  id: string;
  sha: string;
  message: string;
  status: PipelineStatus;
  prNumber: number | null;
  when: Date;
}

// A branch shown in the graph: the agent's own feature/fix branch (kind feature/agent), or a
// real GitHub branch of the repo (kind 'github') when the project opts into showing all branches.
export interface GraphBranch {
  key: string;
  label: string;                 // branch name, or "agent run" / "PR #n"
  kind: 'feature' | 'agent' | 'github';
  stage: FeatureStatus | CodeStreamStatus;
  prNumber: number | null;
  prUrl: string | null;
  live: boolean;                 // an agent is actively writing code on it right now
  isDefault?: boolean;           // the repo's default branch (github kind only)
  when: Date;
}

export interface GitGraph {
  main: GraphCommit[];           // newest first
  branches: GraphBranch[];       // active/recent branches, newest first
}

// Feature lifecycle stages that still represent an OPEN branch (not yet folded into main).
const OPEN_FEATURE: FeatureStatus[] = [
  'branch_created', 'validating', 'validated', 'pr_opened',
];

export function useGitGraph(repoFullName: string | null): GitGraph {
  const { runs } = usePipelineRuns();
  const { features } = useBuilderFeatures();
  const { live, history } = useCodeStream();
  const { connections } = useGithubConnections();
  // Per-project choice: 'agent' (default, no GitHub call) vs. 'all' (also list real branches).
  const { currentProject } = useCurrentProject();
  const showAll = currentProject.git_graph_branch_source === 'all';
  const { branches: repoBranches } = useRepoBranches(repoFullName, showAll);
  // The bundled demo repo's durable break markers. Inert for every real repo.
  const demoBrokeAt = useDemoBrokeAt();
  const demoBrokenNow = useDemoBrokenNow();

  return useMemo(() => {
    if (!repoFullName) return { main: [], branches: [] };

    // pipeline_runs carry a connection_id, not a repo — map it back through connections.
    const connIds = new Set(connections.filter(c => c.repoFullName === repoFullName).map(c => c.id));
    const main: GraphCommit[] = runs
      .filter(r => connIds.has(r.connectionId))
      .map(r => ({
        id: r.id,
        sha: r.commitSha,
        message: (r.commitMessage ?? r.commitSha.slice(0, 7)).split('\n')[0],
        status: r.status,
        prNumber: r.prNumber,
        when: r.createdAt,
      }));

    // The bundled demo repo has no GitHub App installation, so it has no pipeline_runs and its
    // PRODUCTION spine would be empty. Derive it instead — the initial commit, the commit the break
    // demo merged, and one per fix the agent shipped. See data/babynffDemoGit.ts.
    if (repoFullName === BABYNFF_REPO) {
      const fixes = [
        ...history.map(h => ({ runId: h.id, when: h.createdAt, files: h.files })),
        ...live.map(s => ({ runId: s.runId, when: s.startedAt, files: s.files })),
      ]
        // Live wins over history for the same run, mirroring CodeTab / useDemoPullRequests.
        .reduce((byRun, r) => byRun.set(r.runId, r), new Map<string, { runId: string; when: Date; files: typeof history[number]['files'] }>());

      const shipped = [...fixes.values()]
        .filter(r => demoFixSource(r.files) !== null)
        .sort((a, b) => a.when.getTime() - b.when.getTime())
        .map(({ runId, when }) => ({ runId, when }));

      main.push(...babynffDemoCommits({ brokeAt: demoBrokeAt, brokenNow: demoBrokenNow, fixes: shipped }));

      // The build demo's merged feature branch folds into main here (branch card → production
      // commit the moment it reaches `merged`; see babynffFeatureCommits). Combine with the
      // self-heal spine and re-sort newest-first so the merge lands in chronological order.
      main.push(...babynffFeatureCommits(features.filter(f => f.repoFullName === BABYNFF_REPO)));
      main.sort((a, b) => b.when.getTime() - a.when.getTime());
    }

    // Feature branches for this repo that haven't merged/abandoned yet.
    const branches: GraphBranch[] = features
      .filter(f => f.repoFullName === repoFullName && f.branchName && OPEN_FEATURE.includes(f.status))
      .map(f => ({
        key: `feat:${f.id}`,
        label: f.branchName as string,
        kind: 'feature' as const,
        stage: f.status,
        prNumber: f.prNumber,
        prUrl: f.prUrl,
        live: false,
        when: f.updatedAt ?? f.createdAt ?? new Date(0),
      }));

    // Live/recent agent code-runs for this repo: surface the ones that are streaming now, or
    // carry a PR (e.g. an nff-fix/* repair PR) that isn't already shown as a feature branch.
    const shownPrs = new Set(branches.map(b => b.prNumber).filter((n): n is number => n != null));
    const streams = [
      ...live.map(s => ({ id: s.runId, repoFullName: s.repoFullName, status: s.status, prNumber: s.prNumber, prUrl: s.prUrl, live: s.live, when: s.startedAt })),
      ...history.map(h => ({ id: h.id, repoFullName: h.repoFullName, status: h.status, prNumber: h.prNumber, prUrl: h.prUrl, live: false, when: h.createdAt })),
    ];
    const seenRun = new Set<string>();
    for (const s of streams) {
      if (s.repoFullName !== repoFullName || seenRun.has(s.id)) continue;
      seenRun.add(s.id);
      const streaming = s.live && s.status === 'streaming';
      if (!streaming && (s.prNumber == null || shownPrs.has(s.prNumber))) continue;
      if (s.prNumber != null) shownPrs.add(s.prNumber);
      branches.push({
        key: `run:${s.id}`,
        label: s.prNumber != null ? `PR #${s.prNumber}` : 'agent run',
        kind: 'agent',
        stage: s.status as CodeStreamStatus,
        prNumber: s.prNumber,
        prUrl: s.prUrl,
        live: streaming,
        when: s.when,
      });
    }

    // When the project opts in, also list the repo's real GitHub branches. Skip the default
    // branch (it's the PRODUCTION spine below) and any branch already shown as an agent branch
    // (the agent entry carries lifecycle + PR, so it wins).
    if (showAll && repoBranches.length) {
      const agentNames = new Set(branches.map(b => b.label));
      for (const rb of repoBranches) {
        if (rb.isDefault || agentNames.has(rb.name)) continue;
        branches.push({
          key: `gh:${rb.name}`,
          label: rb.name,
          kind: 'github',
          stage: 'branch_created',
          prNumber: null,
          prUrl: null,
          live: false,
          isDefault: rb.isDefault,
          when: new Date(0),
        });
      }
    }

    branches.sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;       // live branches first
      return b.when.getTime() - a.when.getTime();
    });

    return { main, branches };
  }, [repoFullName, runs, features, live, history, connections, showAll, repoBranches,
      demoBrokeAt, demoBrokenNow]);
}
