// Feature plans produced by nff-builder (port 3007) and persisted to Supabase tables
// `builder_features` (+ child `builder_feature_steps`). The agent plans a firmware feature
// from a chat with the user; the dashboard reads these rows live over Realtime (see
// src/hooks/useBuilderFeatures.ts). These types mirror nff-builder/nff_builder/models/
// feature.py — keep them in sync with that contract.

// Lifecycle of a feature; lower-to-higher progression. `abandoned` is terminal.
export type FeatureStatus =
  | 'draft'           // being discussed; plan not finalised
  | 'planned'         // plan_feature produced a concrete plan
  | 'branch_created'  // a feature branch exists on the repo
  | 'validating'      // deployed to canary device(s) for validation
  | 'validated'       // canary confirmed the feature works
  | 'pr_opened'       // a PR from the feature branch is open (auto-merges if enabled)
  | 'merged'          // branch merged into production
  | 'abandoned';      // dropped

export const FEATURE_STATUSES: FeatureStatus[] = [
  'draft', 'planned', 'branch_created', 'validating', 'validated', 'pr_opened', 'merged', 'abandoned',
];

// Where the feature is validated. Only `user_real` is wired this iteration; `simulated`
// (nff-mock) and `nff_real` (nff-side canaries) are surfaced but under construction.
export type CanaryTier = 'simulated' | 'user_real' | 'nff_real';

// One ordered implementation step. Mirrors agent_task_steps so the dashboard reuses the
// same step renderer.
export type StepStatus = 'pending' | 'running' | 'done';

// One decomposed piece of the feature.
export interface SubFeature {
  title: string;
  description: string;
}

// A user-facing story describing the real goal ("As a …, I want …, so that …").
export interface UserStory {
  asA: string;
  iWant: string;
  soThat: string;
}

export interface FeatureStep {
  label: string;
  status: StepStatus;
}

// A full feature with its plan and current state. camelCase of the builder_features
// columns, plus the ordered steps from builder_feature_steps.
export interface BuilderFeature {
  id: string;
  projectId: string;
  sessionId: string | null;
  title: string;
  description: string;
  architecture: string;          // markdown/text: the design
  subFeatures: SubFeature[];
  userStories: UserStory[];
  steps: FeatureStep[];
  status: FeatureStatus;
  priority: number;              // lower = higher priority
  repoFullName: string | null;
  branchName: string | null;
  canaryTier: CanaryTier | null;
  canaryDeviceIds: string[];
  // The PR opened from the feature branch (open_feature_pr), once at the pr_opened stage.
  prNumber: number | null;
  prUrl: string | null;
  // True while the agent has paused a build to ask the user something (request_user_input).
  // `pendingQuestion` carries the question text (also shown in the Builder chat).
  awaitingInput: boolean;
  pendingQuestion: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}
