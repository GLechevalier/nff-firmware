// nff-github connector — mirrors the github_connections / pipeline_runs tables
// (nff-db/migrations/0005_ota_github.sql, 0149_github_installations.sql).

export type DeployPolicy = 'auto' | 'manual';

export type PipelineStatus =
  | 'queued'
  | 'building'
  | 'deploying'
  | 'succeeded'
  | 'failed'
  | 'rolled_back'
  | 'paused';

export type PipelineTrigger = 'push' | 'pr_merge' | 'manual';

export interface GithubConnection {
  id: string;
  repoFullName: string;
  installationId: number | null;
  productionBranch: string;
  deviceGroupId: string | null;   // null = code-only connection (no fleet target, never deploys)
  deviceTypes: string[];
  deployPolicy: DeployPolicy;
  createdAt: Date;
  // Client-injected demo repo (babynff-repo) — not a real DB row, so treat it read-only (no disconnect).
  virtual?: boolean;
}

export interface PipelineRun {
  id: string;
  connectionId: string;
  commitSha: string;
  commitMessage: string | null;
  trigger: PipelineTrigger;
  status: PipelineStatus;
  firmwareVersion: string | null;
  deploymentId: string | null;
  prNumber: number | null;
  error: string | null;
  logs: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GithubInstallation {
  installationId: number;
  projectId: string;
  accountLogin: string;
  accountType: string;   // 'User' | 'Organization'
  createdAt: Date;
}
