// The console's normalized part model.
//
// The device agent's activity arrives split across three tables that share no
// join key beyond `project_id` and a timestamp: `agent_messages` (the turns),
// `agent_console_entries` (tool calls and their output) and `agent_code_streams`
// (drafted files). `buildTurns()` in lib/turns.ts folds all three into the shape
// below, and the components render only this — never a table row. That seam is
// what lets the same renderer also draw the admin data chat (lib/adminTurns.ts).

import type { Choice } from '../../utils/choices';

export type ToolStatus = 'running' | 'ok' | 'error';

export interface ToolParam {
  name: string;
  value: string;
}

export type Part =
  // Assistant prose. `streaming` marks the tail block still arriving over the
  // chat-stream broadcast — it renders with a caret and no copy affordance.
  | { kind: 'text'; id: string; text: string; streaming?: boolean }
  // The worker's sentinel-prefixed status rows (see SENTINELS in lib/turns.ts).
  | { kind: 'status'; id: string; text: string; variant: 'narration' | 'schedule' | 'stopped' }
  // One tool call: the `command`/`edit` console entry plus every `output`/`error`
  // entry that followed it before the next command.
  | { kind: 'tool'; id: string; server?: string; tool: string; params: ToolParam[]; output?: string; status: ToolStatus; edit?: boolean }
  // A file the agent drafted. `before === null` means it created the file.
  | { kind: 'file'; id: string; path: string; before: string | null; after: string }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'choices'; id: string; options: Choice[] };

export interface Turn {
  // The user message id that opened the turn, or `orphan-<n>` for activity that
  // predates the oldest loaded prompt (a "load older" page boundary).
  id: string;
  at: Date;
  // null for an orphan turn — there is no prompt to show.
  prompt: string | null;
  // The user message id, when there is one — the Composer's Pause/rate target.
  promptId?: string;
  parts: Part[];
  // The agent still owes a reply: this turn renders the progress indicator.
  busy: boolean;
}
