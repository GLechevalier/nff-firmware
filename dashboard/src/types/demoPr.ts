// Demo pull request — the break-and-heal demo's fix, presented as a PR.
//
// NOT a database row and NOT a GitHub PR: the bundled demo repo (data/babynffRepo.ts) is a
// client-side fiction with no GitHub App installation, so nff-github's open_fix_pr can't run
// against it. This is DERIVED from the agent's real code-stream row (agent_code_streams, which
// already carries the fixed sketch the agent shipped via submit_firmware_fix) diffed against the
// sketch that was seeded. Every line of `head` is code the agent genuinely wrote.
//
// It therefore has no html_url — the UI renders the diff in-dashboard rather than a dead link.

export type DemoPrStatus = 'open' | 'merged';

export interface DemoPullRequest {
  /** Stable per project: oldest demo code-run is #1. Not a GitHub PR number. */
  number: number;
  /** The agent_code_streams row / live runId this was derived from — the React key. */
  runId: string;
  title: string;
  repoFullName: string;
  headBranch: string;
  baseBranch: string;
  /** Path in the bundled demo repo the fix touches (always the sketch). */
  path: string;
  /** The seeded buggy sketch. */
  base: string;
  /** The sketch the agent shipped. */
  head: string;
  openedAt: Date;
  /** 'merged' once the fix's OTA landed and the demo-broken device recovered. */
  status: DemoPrStatus;
}
