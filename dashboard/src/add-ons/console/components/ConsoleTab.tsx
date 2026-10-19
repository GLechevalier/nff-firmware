import { useEffect, useMemo, useRef, useState } from 'react';
import { useAgentConsole } from '../../../hooks/useAgentConsole';
import { useAgentMessages } from '../../../hooks/useAgentMessages';
import { useChatSessions } from '../../../hooks/useChatSessions';
import { useCodeStream } from '../../../hooks/useCodeStream';
import { AGENT_REPLY_TIMEOUT_MS } from '../../../components/chat/ChatPanel';
import { useChatStream } from '../hooks/useChatStream';
import { buildTurns, hasRunningJob, jobsOnly, type FileInput } from '../lib/turns';
import { Transcript } from './Transcript';

// The device agent's console: a READ-ONLY log of what the agent is concretely doing
// — its MCP tool calls, file edits and errors — for the conversation the chat half
// is having. It is not a second chat: no prompt bubbles, no prose, no composer.
// Everything it renders comes from buildTurns() → jobsOnly(); this component's
// whole job is to collect the four sources and report "a tool is running" upward.

interface Props {
  /**
   * The thread to show. The Overview lifts its chat's selected session here so
   * both panes render the same conversation — bubbles on the left, the agent's
   * tool log on the right. Null/undefined falls back to the newest plain 'chat'
   * thread; ProjectChat is what creates one when a project has none.
   */
  sessionId?: string | null;
  /**
   * Fires with true while a tool call is in flight and false once it settles.
   * The App blinks its Console pull-tab on it — this pane stays mounted at width 0
   * while closed, so the signal works without opening it.
   */
  onActiveChange?: (active: boolean) => void;
}

export function ConsoleTab({ sessionId: pinned, onActiveChange }: Props) {
  const { sessions } = useChatSessions();

  // Never a 'query' (device popup) or 'builder' (feature interview) thread —
  // those have their own surfaces.
  const thread = useMemo(() => sessions.filter((s) => s.kind === 'chat')[0], [sessions]);
  const sessionId = pinned ?? thread?.id;

  const { messages, refetchNewer, loadOlder, hasMore, loadingOlder, error } = useAgentMessages(sessionId);
  const { entries } = useAgentConsole();
  const { live, history } = useCodeStream();
  const liveText = useChatStream(sessionId);

  // Flatten both halves of the code stream into one file list for this thread.
  // A live run and its persisted row carry the same path, so the id keys on the
  // run so the finished row replaces the draft instead of stacking beside it.
  const files = useMemo<FileInput[]>(() => {
    const out: FileInput[] = [];
    for (const row of history) {
      if (row.sessionId !== sessionId) continue;
      for (const f of row.files) out.push({ id: `${row.id}:${f.path}`, path: f.path, before: f.before ?? null, content: f.content, timestamp: row.updatedAt });
    }
    for (const s of live) {
      if (s.sessionId !== sessionId) continue;
      for (const f of s.files) out.push({ id: `${s.runId}:${f.path}`, path: f.path, before: f.before ?? null, content: f.content, timestamp: s.startedAt });
    }
    const seen = new Set<string>();
    return out.filter((f) => !seen.has(f.id) && seen.add(f.id));
  }, [history, live, sessionId]);

  // `turns` keeps the full picture (liveness, timeout); `jobs` is what gets drawn.
  const turns = useMemo(
    () => buildTurns({ messages, entries, files, liveText }),
    [messages, entries, files, liveText],
  );
  const jobs = useMemo(() => jobsOnly(turns), [turns]);

  const busy = turns[turns.length - 1]?.busy ?? false;

  // Silence is ambiguous: the worker may be down, or our Realtime subscription may
  // have dropped while the reply landed in the DB unseen. Re-poll once before
  // blaming the worker — a reply arriving changes the last message and resets this.
  // Same contract as ChatPanel's, which is why it shares that timeout constant.
  const last = messages[messages.length - 1];
  // Tagged with the message the wait is about, so any newer row clears the notice
  // in the same render instead of via a setState in an effect.
  const waitKey = `${last?.id ?? ''}:${busy}`;
  const [timedOut, setTimedOut] = useState({ key: '', expired: false });
  const expired = timedOut.key === waitKey && timedOut.expired;
  const refetchRef = useRef(refetchNewer);
  useEffect(() => { refetchRef.current = refetchNewer; }, [refetchNewer]);
  useEffect(() => {
    if (!busy || !last) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try { await refetchRef.current?.(); } catch { /* offline too — fall through */ }
      if (!cancelled) setTimedOut({ key: waitKey, expired: true });
    }, Math.max(0, last.timestamp.getTime() + AGENT_REPLY_TIMEOUT_MS - Date.now()));
    return () => { cancelled = true; clearTimeout(timer); };
  }, [waitKey, last, busy]);

  // A tail tool row stays `running` as long as the turn is live, so a dead run
  // would blink forever — the timeout above is what ends it.
  const active = hasRunningJob(jobs) && !expired;
  useEffect(() => { onActiveChange?.(active); }, [active, onActiveChange]);

  const disabled = !sessionId;
  const hint = error
    ? `History unavailable: ${error}`
    : expired ? 'No response — the agent may be offline.'
    : null;

  return (
    <Transcript
      turns={jobs}
      onLoadOlder={loadOlder}
      hasMore={hasMore}
      loadingOlder={loadingOlder}
      emptyState={
        <div data-component="status-part" data-variant="narration">
          <span>{disabled ? 'Connecting to the agent…' : 'Idle — no tool activity in this thread.'}</span>
        </div>
      }
      footer={hint && (
        <div data-component="status-part" data-variant="stopped">
          <span>{hint}</span>
        </div>
      )}
    />
  );
}
