import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { BRAND_ACCENT } from '../../lib/brand';
import { formatRelativeTime } from '../../utils/time';
import { Markdown } from '../squeletton/Markdown';
// The rotating-verb + elapsed-seconds wait line ("✢ Percolating… (12s)"). Imported from
// core/chat rather than re-implemented here: it is one component, and a second copy would
// drift. Its `since` is the run start, so the counter reflects the whole wait and survives
// a reload (the timestamp comes off the persisted user row).
import { ThinkingIndicator } from './ThinkingIndicator';
import { ToolTicker } from './ToolTicker';
import { ChoiceSelector } from './ChoiceSelector';
import { parseChoices } from '../../utils/choices';
import {
  isNarration,
  isWorking,
  runToolNames,
  NARRATION_PREFIX,
  SCHEDULE_PREFIX,
  STOP_PREFIX,
  AGENT_REPLY_TIMEOUT_MS,
} from './runState';

// Inline Feather-style glyphs (viewBox 0 0 24 24, stroke=currentColor) for the
// per-message hover actions, matching the hand-rolled icon convention in
// CopyButton.tsx — the repo ships no icon library.
function ResendIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }} aria-hidden="true">
      <path d="M23 4v6h-6" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

function ThumbUpIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }} aria-hidden="true">
      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

function ThumbDownIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }} aria-hidden="true">
      <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
    </svg>
  );
}

function ClipboardIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }} aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }} aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

// A bare icon button for the message action row, styled to sit next to the
// (icon-variant) CopyButton. Muted by default; `active` paints it green like
// CopyButton's copied state. Hover swaps to a stronger foreground.
function ActionIconButton({
  title, onClick, active = false, children,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  const fg = active ? '#15803d' : '#555';
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick(); }}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', background: 'none', color: fg,
        cursor: 'pointer', padding: 3, lineHeight: 0,
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.color = '#000'; }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.color = fg; }}
    >
      {children}
    </button>
  );
}

// Borderless copy button for the message action row — mirrors CopyButton's
// clipboard→check "copied" feedback but wears the bare ActionIconButton styling
// so the whole row is uniform (no outlined box).
function CopyActionButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable (insecure context) — leave state unchanged
    }
  }
  return (
    <ActionIconButton title={copied ? 'Copied' : 'Copy'} active={copied} onClick={copy}>
      {copied ? <CheckIcon /> : <ClipboardIcon />}
    </ActionIconButton>
  );
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
  // Thumbs vote on an agent reply: 0 (or undefined) = none, 1 = like, -1 = unlike.
  rating?: number;
}

// The worker's status-row sentinels and the silence timeout now live beside the run-state
// predicates that use them (./runState). Re-exported here so existing importers —
// observability/TabPanel, console/ConsoleTab, QueryPopup — keep working unchanged.
export { NARRATION_PREFIX, SCHEDULE_PREFIX, STOP_PREFIX, AGENT_REPLY_TIMEOUT_MS };

interface Props {
  messages: ChatMessage[];
  onSend?: (text: string) => void;
  // Stop the in-flight run (the Pause button). When provided, the Send button turns into
  // a Pause button while the agent is thinking (`busy`). Optional — surfaces without a
  // cancel path (Floor/Demo) simply keep a plain Send.
  onCancel?: () => void;
  // Persist a thumbs vote on an agent reply (0 clears it). When omitted, the
  // like/unlike buttons are hidden — panels without a persistence backend
  // (Builder/Floor/Demo) simply don't show them.
  onRate?: (id: string, rating: number) => void;
  // Re-poll the thread for replies Realtime may have missed. Called once, right before
  // the "no response" notice would appear — a dropped client subscription is a far more
  // common cause of silence than an actually-dead worker, and the reply is usually
  // already in the DB. Omitted by read-only embeds (Floor/Demo), which never go `busy`.
  onRefetch?: () => void | Promise<void>;
  headerExtra?: React.ReactNode;
  // Pins the wait line's verb — "Retrieving memory…" while the fast path (src/lib/chatTriage.ts)
  // recalls the brain and decides; unset ⇒ the rotating "Percolating…" words. Omitted by
  // embeds without a fast path (Floor/Demo).
  thinkingLabel?: string;
  // The in-progress reply, streamed token-by-token off the worker's chat-stream broadcast
  // (add-ons/console/hooks/useChatStream). Rendered as a draft bubble until the real row
  // supersedes it. Omitted by embeds that don't subscribe.
  liveText?: string | null;
  // Shown in place of the default "Agent starting up…" when there are no messages.
  emptyState?: React.ReactNode;
  // "Load older messages" pagination: render an arrow at the top when more remain.
  onLoadOlder?: () => void;
  hasMore?: boolean;
  loadingOlder?: boolean;
  // A "drop this text into the message box" signal (e.g. an Overview use-case button).
  // The nonce makes repeat requests for the same text re-fire.
  prefill?: { text: string; nonce: number } | null;
  // Cross-panel hover linking (Agent tab desktop split): message ids to paint as "linked" — set
  // by AgentTab when a correlated console command is hovered. Fired back when a bubble is hovered so
  // the console can light up that turn's commands. Omitted by embeds without a paired console.
  highlightedIds?: ReadonlySet<string>;
  onHoverMessage?: (id: string | null) => void;
}

export function ChatPanel({ messages, onSend, onCancel, onRate, onRefetch, headerExtra, thinkingLabel, liveText, emptyState, onLoadOlder, hasMore, loadingOlder, prefill, highlightedIds, onHoverMessage }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  // Which message's action row is revealed (shown on hover). Null = none.
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Honor an external "prefill the message box" request: fill the draft and focus it so the
  // user can review and press Send. Keyed on nonce so the same text can be re-requested.
  useEffect(() => {
    if (!prefill?.text) return;
    setDraft(prefill.text);
    const el = inputRef.current;
    if (el) { el.focus(); el.setSelectionRange(prefill.text.length, prefill.text.length); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  // The agent owes a reply (and is "thinking") while the tail is the user's message OR a
  // "⚙ …" narration row — narration means the run is mid-flight, not finished. Under the
  // old `last.role === 'user'` rule the first narration row cleared the thinking indicator
  // and the Pause button seconds into a run that had barely started. See ./runState.
  const last = messages[messages.length - 1];
  const busy = !!onSend && isWorking(messages);
  // This run's tool calls, for the live ticker: the tool-name narration rows since the
  // last user message (the keepalive heartbeat lines are filtered out). Never rendered
  // inline in the transcript.
  const tickerLines = busy ? runToolNames(messages) : [];
  // When the wait started — the question that opened this run, not the newest narration
  // row, so the counter keeps climbing across the whole answer.
  const busySince = messages.findLast(m => m.role === 'user')?.timestamp.getTime();

  // Once the agent has been silent for AGENT_REPLY_TIMEOUT_MS, stop the endlessly
  // pulsing gear (the agent is clearly not thinking anymore) and show a "no response"
  // notice instead. Keyed on the last message's id: a new agent row changes the id,
  // which resets `expired` and cancels the pending timer, so a late reply self-clears.
  const [expired, setExpired] = useState(false);
  // True between clicking Pause and the run actually stopping (the worker's `⏹` status row
  // lands as a new agent message, changing last?.id). Shows "Stopping…" and blocks repeat
  // clicks. Reset in the same effect as `expired` — keyed on last?.id / busy — so the arrival
  // of ANY newer message (the stop line, or a late reply that raced the cancel) clears it.
  const [cancelling, setCancelling] = useState(false);
  // Held in a ref so a caller passing an inline closure can't re-arm the timer on
  // every render (which would postpone the notice forever).
  const onRefetchRef = useRef(onRefetch);
  useEffect(() => { onRefetchRef.current = onRefetch; }, [onRefetch]);
  useEffect(() => {
    setExpired(false);
    setCancelling(false);
    if (!busy || !last) return;
    let cancelled = false;
    // Silence is ambiguous: the worker may be down, OR our Realtime subscription may
    // have dropped while the reply landed in the DB unseen. Re-poll once before
    // blaming the worker — if rows come back, `last?.id` changes, this effect re-runs
    // and `setExpired(false)` above clears the notice before it is ever painted.
    async function declareNoResponse() {
      try { await onRefetchRef.current?.(); } catch { /* offline too — fall through */ }
      if (!cancelled) setExpired(true);
    }
    // A reloaded thread whose last row is an old user message is already past due;
    // fire immediately (still via the refetch path — that stale tab is exactly the
    // case most likely to be holding messages it never received).
    const remaining = last.timestamp.getTime() + AGENT_REPLY_TIMEOUT_MS - Date.now();
    const timer = setTimeout(declareNoResponse, Math.max(0, remaining));
    return () => { cancelled = true; clearTimeout(timer); };
  // Re-arm whenever the newest message changes (id) or busy flips.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last?.id, busy]);

  useEffect(() => {
    // Auto-scroll to the bottom only when a NEW message lands at the end (a reply or
    // a just-sent message), when the thinking indicator appears/disappears, or on first
    // load — not when older messages are prepended via "load older", which would otherwise
    // yank the view away from where the user is.
    const lastId = messages[messages.length - 1]?.id ?? null;
    const marker = `${lastId}:${busy}`;
    if (marker === lastIdRef.current) return;
    lastIdRef.current = marker;
    // Scroll the panel's own container, not via scrollIntoView — the latter also
    // scrolls every scrollable ancestor (and across an iframe boundary into the
    // host page), which jerks the page when this panel is embedded.
    const scroller = bottomRef.current?.parentElement;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [messages, busy]);

  function submit() {
    const text = draft.trim();
    if (!text || !onSend) return;
    onSend(text);
    setDraft('');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ borderBottom: '1px solid #000', padding: '4px 8px', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Agent</span>
        {headerExtra}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px', fontSize: 13, lineHeight: 1.5, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {hasMore && onLoadOlder && (
          <div style={{ textAlign: 'center' }}>
            <button
              onClick={onLoadOlder}
              disabled={loadingOlder}
              style={{
                background: 'none', border: '1px solid #000', color: '#000',
                fontSize: 11, padding: '2px 10px',
                cursor: loadingOlder ? 'default' : 'pointer', letterSpacing: 0.3,
              }}
            >
              {loadingOlder ? 'Loading…' : '↑ Load older messages'}
            </button>
          </div>
        )}
        {messages.length === 0 && (
          emptyState ?? <span style={{ color: '#888' }}>Agent starting up…</span>
        )}
        {messages.map(msg => {
          const isUser = msg.role === 'user';
          // Never render a blank agent bubble. The worker guards against writing empty replies,
          // but this also hides any empty rows already persisted before that fix landed.
          if (!isUser && !msg.content.trim()) return null;
          // Live narration ("⚙ Reading crash abc123…") — transient "what I'm doing now"
          // status, not conversation history. Never rendered inline: the current run's rows
          // are collected into the ToolTicker below, and once the real reply lands they are
          // history nobody needs to re-read.
          if (!isUser && isNarration(msg)) return null;
          // "Scheduled this task — resuming in ~5m." — the agent parked a follow-up. Persistent
          // (not collapsed like narration) so the record stays; rendered as the same muted,
          // centered status line as the "no response" notice below, so it reads as system
          // status rather than a reply bubble.
          if (!isUser && msg.content.startsWith(SCHEDULE_PREFIX)) {
            return (
              <div
                key={msg.id}
                style={{
                  alignSelf: 'center', color: '#999', fontStyle: 'italic',
                  fontSize: 12, padding: '1px 0', textAlign: 'center', maxWidth: '90%',
                }}
              >
                ⏰ {msg.content.slice(SCHEDULE_PREFIX.length)}
              </div>
            );
          }
          // "⏹ Stopped by user." — the run was paused. Persistent (like the schedule line),
          // rendered as the same muted, centered system-status line so it reads as status,
          // not a reply bubble. Its presence as an agent row is what clears `busy` above.
          if (!isUser && msg.content.startsWith(STOP_PREFIX)) {
            return (
              <div
                key={msg.id}
                style={{
                  alignSelf: 'center', color: '#999', fontStyle: 'italic',
                  fontSize: 12, padding: '1px 0', textAlign: 'center', maxWidth: '90%',
                }}
              >
                ⏹ {msg.content.slice(STOP_PREFIX.length)}
              </div>
            );
          }
          // Agent messages may embed an ```nff-choices``` block; only the latest one is
          // interactive so a picked option in history can't re-fire.
          const parsed = isUser ? null : parseChoices(msg.content);
          const isLatest = msg.id === last?.id;
          const showActions = hoveredId === msg.id;
          // Reverse-linked from a hovered console command (only agent replies are targets).
          const isLinked = highlightedIds?.has(msg.id) ?? false;
          const rating = msg.rating ?? 0;
          return (
            <div
              key={msg.id}
              onMouseEnter={() => { setHoveredId(msg.id); onHoverMessage?.(msg.id); }}
              onMouseLeave={() => { setHoveredId(prev => (prev === msg.id ? null : prev)); onHoverMessage?.(null); }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start' }}
            >
              <div
                style={{
                  maxWidth: '78%',
                  padding: '6px 10px',
                  borderRadius: isUser ? '10px 10px 2px 10px' : '10px 10px 10px 2px',
                  background: isUser ? '#000' : '#f0f0f0',
                  color: isUser ? '#fff' : '#111',
                  // Teal ring ties this reply to its (currently hovered) console commands. SERVER_COLOR
                  // #4ec9b0 is the console's own accent, so both sides of the link read as one colour.
                  boxShadow: isLinked ? '0 0 0 2px #4ec9b0' : undefined,
                  // User messages are plain text (preserve their line breaks); agent
                  // messages are markdown, whose own block elements handle spacing.
                  whiteSpace: isUser ? 'pre-wrap' : 'normal',
                  wordBreak: 'break-word',
                }}
              >
                {isUser ? (
                  msg.content
                ) : parsed?.choices ? (
                  <>
                    {parsed.before && <Markdown>{parsed.before}</Markdown>}
                    <ChoiceSelector
                      choices={parsed.choices}
                      onPick={text => onSend?.(text)}
                      onOther={onSend ? () => inputRef.current?.focus() : undefined}
                      disabled={!isLatest || !onSend}
                    />
                    {parsed.after && <Markdown>{parsed.after}</Markdown>}
                  </>
                ) : (
                  <Markdown>{msg.content}</Markdown>
                )}
              </div>
              <span style={{ color: '#999', fontSize: 11, marginTop: 2, padding: '0 2px' }}>
                {formatRelativeTime(msg.timestamp)}
              </span>
              {/* Hover action row. Kept mounted (visibility toggled) so revealing it
                  never nudges the layout. User bubbles get Copy + Resend; agent
                  bubbles get Copy + Like + Unlike (thumbs only when onRate is wired). */}
              <div
                style={{
                  display: 'flex', gap: 4, marginTop: 2, padding: '0 2px',
                  visibility: showActions ? 'visible' : 'hidden',
                }}
              >
                <CopyActionButton value={msg.content} />
                {isUser ? (
                  onSend && (
                    <ActionIconButton title="Resend" onClick={() => onSend(msg.content)}>
                      <ResendIcon />
                    </ActionIconButton>
                  )
                ) : (
                  onRate && (
                    <>
                      <ActionIconButton
                        title="Good response"
                        active={rating === 1}
                        onClick={() => onRate(msg.id, rating === 1 ? 0 : 1)}
                      >
                        <ThumbUpIcon />
                      </ActionIconButton>
                      <ActionIconButton
                        title="Bad response"
                        active={rating === -1}
                        onClick={() => onRate(msg.id, rating === -1 ? 0 : -1)}
                      >
                        <ThumbDownIcon />
                      </ActionIconButton>
                    </>
                  )
                )}
              </div>
            </div>
          );
        })}
        {/* The live run, in the order the user experiences it: the tool calls as they
            happen, the streaming answer, and the "still thinking" line. */}
        {busy && !expired && (
          <>
            <ToolTicker lines={tickerLines} />
            {liveText && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <div
                  style={{
                    maxWidth: '78%',
                    padding: '6px 10px',
                    borderRadius: '10px 10px 10px 2px',
                    background: '#f0f0f0',
                    color: '#111',
                    wordBreak: 'break-word',
                  }}
                >
                  <Markdown>{liveText}</Markdown>
                </div>
              </div>
            )}
            <ThinkingIndicator since={busySince} label={thinkingLabel} />
          </>
        )}
        {busy && expired && (
          <div
            style={{
              alignSelf: 'center', color: '#999', fontStyle: 'italic',
              fontSize: 12, padding: '1px 0', textAlign: 'center', maxWidth: '90%',
            }}
          >
            ⚠ No response — the agent may be offline, or this tab may have lost its
            connection. Resend, or reload the page.
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {onSend && (
        <div style={{ borderTop: '1px solid #000', display: 'flex', padding: '4px', flexShrink: 0 }}>
          <textarea
            ref={inputRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Message agent…"
            rows={2}
            style={{
              flex: 1, resize: 'none', fontSize: 13,
              background: '#000', color: '#fff', border: 'none', outline: 'none', padding: '4px',
            }}
          />
          {busy && onCancel ? (
            // While the agent is thinking, Send becomes Pause — click to stop the run.
            // Red-outlined so it reads as a distinct, interrupting action; goes to a
            // disabled "Stopping…" state until the worker's stop line lands (clears `busy`).
            <button
              onClick={() => { if (!cancelling) { setCancelling(true); onCancel(); } }}
              disabled={cancelling}
              title={cancelling ? 'Stopping…' : 'Stop the agent'}
              style={{
                marginLeft: 4, padding: '0 10px', fontSize: 20, lineHeight: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: '#000', color: cancelling ? '#888' : '#f87171',
                border: `1px solid ${cancelling ? '#888' : '#f87171'}`,
                cursor: cancelling ? 'default' : 'pointer',
              }}
            >
              ⏸
            </button>
          ) : (
            <button
              onClick={submit}
              style={{
                marginLeft: 4, padding: '0 8px', fontSize: 12,
                background: BRAND_ACCENT, color: '#fff', border: '1px solid #fff', cursor: 'pointer',
              }}
            >
              Send
            </button>
          )}
        </div>
      )}
    </div>
  );
}
