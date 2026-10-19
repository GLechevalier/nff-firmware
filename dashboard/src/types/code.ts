// Code tab — mirrors the agent_code_streams table (nff-db migration 0050) plus the
// shape the live Realtime-broadcast session is assembled into in the browser.

export type CodeStreamStatus = 'streaming' | 'pr_opened' | 'done' | 'error';

export interface CodeFile {
  path: string;
  content: string;
  /**
   * The content the agent READ at this path before writing it (nff-agent-worker/src/codeStream.ts),
   * so the tab can show a diff. The code-writing tools carry whole files and never a patch, so this
   * is the only "before" that exists. `null`/absent = the agent wrote a file it never read, and
   * there is nothing honest to diff against — render the plain file instead.
   */
  before?: string | null;
}

// A persisted code-run row (history). nff-agent-worker writes these via the service role.
export interface CodeStreamRow {
  id: string;                       // = the worker's runId
  projectId: string;
  sessionId: string | null;
  repoFullName: string | null;
  files: CodeFile[];
  prNumber: number | null;
  prUrl: string | null;
  status: CodeStreamStatus;
  createdAt: Date;
  updatedAt: Date;
}

// A run assembled live from broadcast frames (reasoning deltas + drafted files). `live`
// is true while frames are still arriving this session; once the run ends it is folded
// into history. `runId` groups all frames; reasoning is the concatenation of deltas.
export interface LiveCodeSession {
  runId: string;
  sessionId: string | null;
  repoFullName: string | null;
  reasoning: string;
  files: CodeFile[];
  status: CodeStreamStatus;
  prNumber: number | null;
  prUrl: string | null;
  live: boolean;
  startedAt: Date;
}
