import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { BRAND_ACCENT } from '../../lib/brand';
import { useCurrentProject } from '../../context/CurrentProjectContext';
import type { QueryContext } from '../../types/query';
import { USER_QUESTION_MARKER } from '../../utils/chat';
import { AGENT_REPLY_TIMEOUT_MS } from './ChatPanel';

interface QueryMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
}

interface QueryPopupProps {
  anchor: { x: number; y: number };
  context: QueryContext;
  onClose: () => void;
}

/**
 * Build the message sent to the agent. The worker spawns a fresh, stateless
 * `claude -p` per turn, so the entity context is prepended to every question.
 * The focus is either one device or a fleet-wide subject (firmware version,
 * deployment, GitHub run, crash, feature…).
 */
function buildAgentMessage(text: string, ctx: QueryContext): string {
  const { field, value, device, subject, details } = ctx;
  const extra = details
    ? '\n' + Object.entries(details).map(([k, v]) => `${k}: ${v}`).join('\n')
    : '';
  const preamble = device
    ? `You are a firmware engineer assistant inspecting one IoT device in the fleet.\n` +
      `Device: ${device.name} (id: ${device.id}, status: ${device.status}, firmware: ${device.firmwareVersion}).\n` +
      `Field in focus: ${field} = ${value}.${extra}\n` +
      `Answer concisely; use the nff tools if you need live device data.`
    : `You are a firmware engineer assistant inspecting the nff fleet.\n` +
      `Subject: ${subject ?? 'fleet'}.\n` +
      `Field in focus: ${field} = ${value}.${extra}\n` +
      `Answer concisely; use the nff tools if you need live data.`;
  return `${preamble}${USER_QUESTION_MARKER}${text}`;
}

export function QueryPopup({ anchor, context, onClose }: QueryPopupProps) {
  const { currentProjectId } = useCurrentProject();
  // Label the focused entity: a device name when device-scoped, else the subject.
  const subjectLabel = context.device?.name ?? context.subject ?? 'fleet';
  const [messages, setMessages] = useState<QueryMessage[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Pending "the agent went quiet" timer. Cleared when a reply lands, on unmount, or
  // when it fires — so a dead worker can't leave this popup stuck on "thinking…".
  const replyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One isolated conversation thread per popup mount. The worker echoes this
  // session_id onto the agent reply, and we subscribe to only this thread.
  const sessionId = useMemo(() => crypto.randomUUID(), []);
  // Whether this thread has been registered as a chat_sessions row yet (done once,
  // on the first send, so the conversation shows up in the Chat History tab).
  const sessionCreatedRef = useRef(false);

  // Stream replies for this popup's thread. The agent's tool calls go to the
  // global Agent-tab console, not here — this popup shows only chat bubbles.
  useEffect(() => {
    const channel = supabase
      .channel(`query-popup-${sessionId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'agent_messages', filter: `session_id=eq.${sessionId}` },
        payload => {
          const row = payload.new as { id: string; role: 'user' | 'agent'; content: string };
          if (row.role !== 'agent') return; // our own user row is shown optimistically
          setMessages(prev => (prev.some(m => m.id === row.id) ? prev : [...prev, { id: row.id, role: 'agent', content: row.content }]));
          setThinking(false);
          // A reply (or narration) landed — cancel the pending "no response" timeout.
          if (replyTimeoutRef.current) { clearTimeout(replyTimeoutRef.current); replyTimeoutRef.current = null; }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      if (replyTimeoutRef.current) { clearTimeout(replyTimeoutRef.current); replyTimeoutRef.current = null; }
    };
  }, [sessionId]);

  const POPUP_WIDTH = 340;
  const POPUP_HEIGHT = 360;
  const GAP = 8;

  const left = Math.min(anchor.x, window.innerWidth - POPUP_WIDTH - 12);
  const top  = anchor.y + GAP + POPUP_HEIGHT > window.innerHeight
    ? anchor.y - POPUP_HEIGHT - GAP
    : anchor.y + GAP;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages, thinking]);

  async function send() {
    const text = input.trim();
    if (!text || thinking) return;
    // Show the typed question (not the context-laden payload) optimistically.
    const userMsg: QueryMessage = { id: crypto.randomUUID(), role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setThinking(true);
    // Register this popup thread as a chat_sessions row on the first send, so the
    // whole Q&A persists in the Chat History tab. Without it the thread is orphaned:
    // its agent_messages carry a session_id with no matching session row, so it shows
    // up nowhere. We set an explicit title (device + field) so the worker's auto-titler
    // skips it rather than naming the session from the context-laden payload below.
    if (!sessionCreatedRef.current) {
      sessionCreatedRef.current = true;
      const title = `Query · ${subjectLabel} · ${context.field}`.slice(0, 60);
      const { error: sessionErr } = await supabase
        .from('chat_sessions')
        .insert({ id: sessionId, project_id: currentProjectId, title, kind: 'query' });
      if (sessionErr) console.error('[QueryPopup] create chat_sessions failed:', sessionErr.message);
    }
    // Insert into the same pipeline the main Agent tab uses: the worker watches
    // agent_messages (role=user), runs Claude + nff tools, and writes the reply
    // back with this session_id — which our subscription above is listening for.
    const { error } = await supabase.from('agent_messages').insert({
      id: userMsg.id,
      role: 'user',
      content: buildAgentMessage(text, context),
      ts: new Date().toISOString(),
      session_id: sessionId,
      project_id: currentProjectId,
    });
    if (error) {
      // Surface failures inline instead of leaving the popup stuck on "thinking…".
      console.error('[QueryPopup] insert into agent_messages failed:', error);
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'agent',
        content: `⚠ Couldn't reach the agent (insert failed): ${error.message}`,
      }]);
      setThinking(false);
      return;
    }
    // The message is queued. If nothing comes back within the timeout window, the agent
    // is clearly not thinking anymore — stop the "thinking…" line and say so. Cleared by
    // the reply subscription above (or on unmount) if a reply does land first.
    if (replyTimeoutRef.current) clearTimeout(replyTimeoutRef.current);
    replyTimeoutRef.current = setTimeout(() => {
      replyTimeoutRef.current = null;
      setThinking(false);
      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'agent',
        content: '⚠ No response — the agent may be offline. Try again.',
      }]);
    }, AGENT_REPLY_TIMEOUT_MS);
  }

  return (
    <div
      style={{
        position: 'fixed',
        top,
        left,
        width: POPUP_WIDTH,
        background: '#fff',
        border: '1.5px solid #000',
        boxShadow: '4px 4px 0 #000',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        fontSize: 12,
      }}
      onClick={e => e.stopPropagation()}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderBottom: '1px solid #000', background: BRAND_ACCENT, color: '#fff' }}>
        <span style={{ fontWeight: 'bold', letterSpacing: 0.3 }}>
          {context.field}: <span style={{ color: '#fbbf24' }}>{context.value}</span>
          <span style={{ fontWeight: 'normal', color: '#aaa', marginLeft: 6 }}>— {subjectLabel}</span>
        </span>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}
        >
          ×
        </button>
      </div>

      {/* Agent label */}
      <div style={{ padding: '4px 10px', borderBottom: '1px solid #eee', background: '#f9f9f9', color: '#555', fontSize: 11 }}>
        Firmware Engineer Agent
      </div>

      {/* Chat area */}
      <div
        ref={chatRef}
        style={{ flex: 1, overflowY: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 180, maxHeight: 220 }}
      >
        {messages.length === 0 && !thinking && (
          <div style={{ color: '#888', fontStyle: 'italic', fontSize: 11, margin: 'auto', textAlign: 'center', lineHeight: 1.6 }}>
            Ask anything about {context.field.toLowerCase()} <strong>{context.value}</strong> on {subjectLabel}.<br />
            e.g. "Why is this {context.value}?" · "Push an update" · "Show changelog"
          </div>
        )}
        {messages.map(m => (
          <div
            key={m.id}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '88%',
              background: m.role === 'user' ? '#000' : '#f0f0f0',
              color: m.role === 'user' ? '#fff' : '#111',
              padding: '5px 9px',
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {m.content}
          </div>
        ))}
        {thinking && (
          <div style={{ alignSelf: 'flex-start', color: '#888', fontStyle: 'italic' }}>
            thinking…
          </div>
        )}
      </div>

      {/* Input row */}
      <div style={{ display: 'flex', borderTop: '1px solid #000' }}>
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') send(); }}
          placeholder="Ask the firmware agent…"
          style={{ flex: 1, border: 'none', outline: 'none', padding: '7px 10px', fontSize: 12, background: '#fff' }}
        />
        <button
          onClick={send}
          onMouseEnter={() => setHovered('send')}
          onMouseLeave={() => setHovered(null)}
          disabled={!input.trim() || thinking}
          style={{
            border: 'none',
            borderLeft: '1px solid #000',
            background: hovered === 'send' && input.trim() && !thinking ? '#000' : '#fff',
            color: hovered === 'send' && input.trim() && !thinking ? '#fff' : '#000',
            cursor: input.trim() && !thinking ? 'pointer' : 'default',
            padding: '7px 12px',
            fontSize: 12,
            fontWeight: 'bold',
            transition: 'background 0.1s, color 0.1s',
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
