// Pure "is the agent still working, and what is it doing right now" helpers for the
// chat panel. Split out of ChatPanel.tsx so the windowing logic is unit-testable
// without rendering — it is the only non-trivial logic in the live-run UI.
//
// The sentinels live here (rather than in ChatPanel) because these predicates need
// them; ChatPanel re-exports them, so every existing importer is unaffected.

// Sentinel the agent-worker prefixes onto live status rows
// (src/core/agent/service/src/roles/agent/narrator.ts NARRATION_PREFIX). One such row is
// written per tool call carrying the bare tool name ("⚙ fleet_list_devices"), plus the
// keepalive's "⚙ Still thinking…" lines. Keep in sync with the worker constant.
export const NARRATION_PREFIX = '⚙ ';

// Sentinel for a "parked this follow-up, back later" line (worker SCHEDULE_PREFIX).
// Unlike narration, this is a PERSISTENT status line — kept in history so the user can see
// the work was deferred, not stalled. Keep in sync with the worker constant.
export const SCHEDULE_PREFIX = '⏰ ';

// Sentinel for the "⏹ Stopped by user." line the worker writes when a run is paused
// (worker STOP_PREFIX). Persistent status line, like the schedule line above.
export const STOP_PREFIX = '⏹ ';

// How long the agent may be silent before we conclude it isn't coming back and swap the
// indicator for a muted "no response" notice. Must exceed the worker keepalive cadence
// (service/src/roles/agent/keepalive.ts: silence 20s + tick 5s) so a healthy run — which
// streams "⚙ …" narration rows — is never falsely timed out. Narration rows re-arm the
// timer (see isWorking), so this now only fires when NOTHING comes back at all: worker
// offline, run crashed before emitting, or a stale reloaded thread.
export const AGENT_REPLY_TIMEOUT_MS = 120_000;

/** The subset of a chat message these predicates need. */
export interface RunMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
}

/** A transient "⚙ …" status row: the agent narrating the step it is on right now. */
export function isNarration(m: RunMessage): boolean {
  return m.role === 'agent' && m.content.startsWith(NARRATION_PREFIX);
}

/**
 * Is the agent still working on the last question?
 *
 * True while the tail is the user's message (nothing back yet) OR a narration row —
 * narration means the run is mid-flight, not finished. This is the fix for the old
 * `last.role === 'user'` rule, under which the first "⚙ …" row cleared the thinking
 * indicator and the Pause button even though the agent had barely started.
 *
 * The persistent ⏰/⏹ sentinels are NOT narration, so they still end the run.
 */
export function isWorking(messages: readonly RunMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last) return false;
  return last.role === 'user' || isNarration(last);
}

/**
 * The narration lines belonging to the CURRENT run: everything after the last user
 * message. Oldest first — the ticker renders the tail of this and clips the rest.
 */
export function runNarration(messages: readonly RunMessage[]): { id: string; text: string }[] {
  const start = messages.findLastIndex((m) => m.role === 'user');
  // No user message yet (a reloaded thread of pure agent rows) ⇒ no run in flight.
  if (start === -1) return [];
  return messages
    .slice(start + 1)
    .filter(isNarration)
    .map((m) => ({ id: m.id, text: m.content.slice(NARRATION_PREFIX.length) }));
}

/**
 * The tool names called so far in the CURRENT run, for the ticker — the narration lines
 * minus the keepalive heartbeat. A tool name never contains whitespace; the heartbeat
 * phrases ("Still thinking… (~1m20s)") always do.
 * ponytail: whitespace = keepalive line, not a tool; give the keepalive its own sentinel
 * if a tool ever narrates with a space in it.
 */
export function runToolNames(messages: readonly RunMessage[]): { id: string; text: string }[] {
  return runNarration(messages).filter((l) => !/\s/.test(l.text));
}
