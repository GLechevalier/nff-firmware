// buildTurns — fold the device agent's three tables into one transcript.
//
// The whole point of the console rework lives here. `agent_messages` carries the
// conversation, `agent_console_entries` the tool calls, `agent_code_streams` the
// drafted files — and the only key they share is `project_id` + a timestamp.
// Everything downstream renders Turn/Part and never touches a row.

import { parseChoices } from '../../../utils/choices';
import { parseCommand } from './parseCommand';
import type { Part, ToolParam, ToolStatus, Turn } from '../types';

// Sentinels the agent-worker prefixes onto status rows (src/core/agent/service/src/roles/agent/narrator.ts).
// Re-declared from components/chat/ChatPanel.tsx rather than imported so this module
// stays free of React; the ChatPanel constants remain the ones to keep in sync with
// the worker. A drift would show up as a status line rendering as a reply bubble.
const SENTINELS = [
  { prefix: '⚙ ', variant: 'narration' as const },
  { prefix: '⏰ ', variant: 'schedule' as const },
  { prefix: '⏹ ', variant: 'stopped' as const },
];

/** Structural shape of a `useAgentMessages` row — kept minimal so the hook's type satisfies it. */
export interface MessageInput {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
}

/** Structural shape of a `useAgentConsole` row (ConsoleEntry). */
export interface ConsoleInput {
  id: string;
  type: 'command' | 'output' | 'error' | 'info' | 'edit';
  content: string;
  timestamp: Date;
}

/** One drafted file, flattened out of `useCodeStream`'s live sessions and history rows. */
export interface FileInput {
  id: string;
  path: string;
  before: string | null;
  content: string;
  timestamp: Date;
}

export interface BuildInput {
  messages: MessageInput[];
  entries: ConsoleInput[];
  files: FileInput[];
  /** Assistant text still arriving over the chat-stream broadcast, appended to the open turn. */
  liveText?: string;
}

// A part plus the timestamp it sorts on. `seq` keeps the merge stable when a
// console entry and an agent message land on the same millisecond.
interface Timed {
  at: number;
  seq: number;
  part: Part;
}

/** Classify an agent message into its parts (status line, choices, prose). */
function messageParts(m: MessageInput): Part[] {
  const sentinel = SENTINELS.find((s) => m.content.startsWith(s.prefix));
  if (sentinel) {
    return [{ kind: 'status', id: m.id, text: m.content.slice(sentinel.prefix.length).trim(), variant: sentinel.variant }];
  }
  const { before, choices, after } = parseChoices(m.content);
  if (!choices) return before.trim() ? [{ kind: 'text', id: m.id, text: before }] : [];
  const parts: Part[] = [];
  if (before.trim()) parts.push({ kind: 'text', id: `${m.id}:before`, text: before });
  parts.push({ kind: 'choices', id: `${m.id}:choices`, options: choices });
  if (after.trim()) parts.push({ kind: 'text', id: `${m.id}:after`, text: after });
  return parts;
}

/**
 * Group a window's console entries into tool parts.
 *
 * A `command`/`edit` entry opens a row; every `output`/`error` entry after it
 * attaches to that row until the next command. A row left open when the window
 * ends stays `running` only if the turn is still live — otherwise the worker
 * finished without a closing marker and `ok` is the honest reading.
 */
function toolParts(entries: ConsoleInput[], live: boolean, seqStart: number): Timed[] {
  const out: Timed[] = [];
  let open: { part: Extract<Part, { kind: 'tool' }>; failed: boolean } | null = null;
  let seq = seqStart;

  const close = () => {
    if (!open) return;
    open.part.status = open.failed ? 'error' : 'ok';
    open = null;
  };

  for (const e of entries) {
    seq += 1;
    if (e.type === 'command' || e.type === 'edit') {
      close();
      const parsed = parseCommand(e.content);
      const params: ToolParam[] = (parsed?.params ?? []).map((p) => ({ name: p.flag, value: p.value }));
      const part: Extract<Part, { kind: 'tool' }> = {
        kind: 'tool',
        id: e.id,
        server: parsed?.server,
        tool: parsed?.tool ?? e.content.trim(),
        params,
        status: 'running',
        edit: e.type === 'edit' || undefined,
      };
      open = { part, failed: false };
      out.push({ at: e.timestamp.getTime(), seq, part });
      continue;
    }

    if (e.type === 'info') {
      out.push({ at: e.timestamp.getTime(), seq, part: { kind: 'status', id: e.id, text: e.content, variant: 'narration' } });
      continue;
    }

    // output / error
    if (!open) {
      if (e.type === 'error') out.push({ at: e.timestamp.getTime(), seq, part: { kind: 'error', id: e.id, text: e.content } });
      else out.push({ at: e.timestamp.getTime(), seq, part: { kind: 'tool', id: e.id, tool: 'output', params: [], output: e.content, status: 'ok' } });
      continue;
    }
    open.part.output = open.part.output ? `${open.part.output}\n${e.content}` : e.content;
    if (e.type === 'error') open.failed = true;
  }

  // The tail row keeps shimmering only while the agent still owes a reply.
  if (open && !live) close();
  return out;
}

/**
 * Fold messages + console entries + drafted files into turns.
 *
 * Turn boundaries come from the user messages: turn `i` owns everything with a
 * timestamp in `[user[i].ts, user[i+1].ts)`. Console entries and code streams are
 * joined on that window alone, because neither table carries a `session_id`.
 * ponytail: timestamp-window join — two sessions running concurrently in one
 * project will interleave their tool rows. Add `session_id` to
 * `agent_console_entries` if that ever bites.
 */
export function buildTurns({ messages, entries, files, liveText }: BuildInput): Turn[] {
  const sorted = [...messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const prompts = sorted.filter((m) => m.role === 'user');

  // Window edges: -Infinity opens the orphan turn holding activity older than the
  // oldest loaded prompt (a "load older" page boundary, or a run started elsewhere).
  const edges = [Number.NEGATIVE_INFINITY, ...prompts.map((p) => p.timestamp.getTime())];
  const busyTail = sorted.length > 0 && sorted[sorted.length - 1].role === 'user';

  const turns: Turn[] = [];
  for (let i = 0; i < edges.length; i += 1) {
    const from = edges[i];
    const to = i + 1 < edges.length ? edges[i + 1] : Number.POSITIVE_INFINITY;
    const inWindow = (t: Date) => t.getTime() >= from && t.getTime() < to;
    const prompt = i === 0 ? null : prompts[i - 1];
    const isLast = i === edges.length - 1;
    // Two independent liveness signals, and both have to count. `busyTail` is the
    // agent owing a reply. `streaming` is the worker mid-broadcast — which matters
    // on its own because the worker writes `⚙` narration rows DURING a run, and
    // each one makes the newest message an agent row: gating the live draft on
    // busyTail alone would blank the streaming text the moment work started.
    const streaming = isLast && !!liveText?.trim();
    const live = (isLast && busyTail) || streaming;

    const timed: Timed[] = [];
    let seq = 0;
    for (const m of sorted) {
      if (m.role !== 'agent' || !inWindow(m.timestamp)) continue;
      for (const part of messageParts(m)) {
        seq += 1;
        timed.push({ at: m.timestamp.getTime(), seq, part });
      }
    }
    timed.push(...toolParts(entries.filter((e) => inWindow(e.timestamp)), live, 10_000));
    for (const f of files.filter((f) => inWindow(f.timestamp))) {
      seq += 1;
      timed.push({ at: f.timestamp.getTime(), seq, part: { kind: 'file', id: f.id, path: f.path, before: f.before, after: f.content } });
    }

    // Drop every narration line but the last in the turn — they are a progress
    // ticker, not history (ChatPanel has always rendered only the tail one).
    const lastNarration = timed.filter((t) => t.part.kind === 'status' && t.part.variant === 'narration').pop();
    const parts = timed
      .filter((t) => !(t.part.kind === 'status' && t.part.variant === 'narration' && t !== lastNarration))
      .sort((a, b) => a.at - b.at || a.seq - b.seq)
      .map((t) => t.part);

    // The orphan turn only exists when it actually holds something.
    if (i === 0 && parts.length === 0) continue;

    if (streaming) parts.push({ kind: 'text', id: 'live', text: liveText!, streaming: true });

    // `from` is -Infinity for the orphan turn, so date it by its earliest part.
    const earliest = timed.reduce((min, t) => Math.min(min, t.at), Number.POSITIVE_INFINITY);

    turns.push({
      id: prompt ? prompt.id : 'orphan',
      at: prompt ? prompt.timestamp : new Date(Number.isFinite(earliest) ? earliest : Date.now()),
      prompt: prompt ? prompt.content : null,
      promptId: prompt?.id,
      parts,
      busy: live,
    });
  }

  return turns;
}

/**
 * A part worth showing on the console: an MCP tool call (`nff-*` server), a file
 * edit, a drafted-file diff, or an error. Harness tools (ToolSearch, Read…), orphan
 * `output` rows, prose, status lines and choices are the chat's business, not the
 * console's — the console is what the agent is DOING, not what it is saying.
 */
const isJob = (p: Part): boolean =>
  (p.kind === 'tool' && (!!p.server || !!p.edit)) || p.kind === 'file' || p.kind === 'error';

/** Strip every turn down to its jobs; turns left with none are dropped. */
export function jobsOnly(turns: Turn[]): Turn[] {
  return turns
    .map((t) => ({ ...t, parts: t.parts.filter(isJob) }))
    .filter((t) => t.parts.length > 0);
}

/** A tool call is in flight right now — only a live turn's tail row is ever `running`. */
export function hasRunningJob(turns: Turn[]): boolean {
  return turns.some((t) => t.busy && t.parts.some((p) => p.kind === 'tool' && p.status === 'running'));
}

export type { Part, ToolStatus, Turn };
