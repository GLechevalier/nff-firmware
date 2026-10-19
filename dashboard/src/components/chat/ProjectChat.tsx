import { useEffect, useMemo, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useChatSessions, type ChatSession } from '../../hooks/useChatSessions';
import { useAgentMessages } from '../../hooks/useAgentMessages';
import { ChatPanel } from './ChatPanel';
import { WelcomeGreeting } from '../squeletton/WelcomeGreeting';
import { ConfirmModal } from '../squeletton/ConfirmModal';
import { PromptModal } from '../squeletton/PromptModal';
import { formatRelativeTime } from '../../utils/time';
import { ASK_CHAT_EVENT, CHAT_REPLIED_EVENT } from '../../core/lib/adminChat';
import { useChatStream } from '../../add-ons/console/hooks/useChatStream';
import { triageChat } from '../../lib/chatTriage';
import { useCurrentProject } from '../../context/CurrentProjectContext';

// The workspace's chat with ITS agent — the project agent-worker, over
// chat_sessions + agent_messages (member RLS, Realtime replies, cancel, thumbs,
// server-side auto-titling). Not the admin data-chat: that worker is nff-admin's.
//
// Lives in the Overview's chat column (BrainCard's `chat` slot) beside the brain
// graph, and the console pane renders the SAME thread as a tool transcript — so
// the selected session is lifted to App and handed to both.

interface Props {
  // The thread to show. Undefined/null = fall back to the most recent one (and
  // report it back, so the console follows).
  sessionId?: string | null;
  onSessionChange?: (id: string | null) => void;
  // The chat list collapses to a 48px strip, like the nav rail but on a toggle
  // (this column sits mid-page — a hover-expand would fire while reaching for
  // the chat). The host owns the state: it keeps this list and the console pane
  // mutually exclusive, since both take width from the same row.
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function ProjectChat({ sessionId, onSessionChange, collapsed = false, onCollapsedChange }: Props) {
  const { sessions, loading, error, createSession, updateSessionTitle, deleteSession } = useChatSessions();
  // Plain 'chat' threads only: 'query' (device popup) and 'builder' (feature
  // interview) have their own surfaces and must never hijack this one.
  const threads = useMemo(() => sessions.filter(s => s.kind === 'chat'), [sessions]);
  const effectiveId = sessionId ?? threads[0]?.id;

  const [renameTarget, setRenameTarget] = useState<ChatSession | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChatSession | null>(null);

  // Report the resolved thread up so the console pane shows the same conversation.
  useEffect(() => {
    if (effectiveId && effectiveId !== sessionId) onSessionChange?.(effectiveId);
  }, [effectiveId, sessionId, onSessionChange]);

  // First visit to a project with no thread yet: make one. The ref guards against
  // a second insert while the first is in flight; createSession adds the row
  // optimistically, so `threads` covers every later render.
  // NEVER on a failed load: a fetch that errors also reports an empty list, and
  // creating from that litters the project with an "Untitled chat" on every flaky
  // reload (observed once against a dev server mid-restart).
  const creating = useRef(false);
  useEffect(() => {
    if (loading || error || threads.length > 0 || creating.current) return;
    creating.current = true;
    void createSession('chat')
      .then(id => onSessionChange?.(id))
      .finally(() => { creating.current = false; });
  }, [loading, error, threads.length, createSession, onSessionChange]);

  const { currentProjectId } = useCurrentProject();
  const {
    messages, loading: messagesLoading, sendMessage, appendLocal, cancelRun,
    setRating, loadOlder, refetchNewer, hasMore, loadingOlder,
  } = useAgentMessages(effectiveId);

  // The in-progress reply, streamed off the worker's chat-stream broadcast. Already
  // produced for every run (agent/chatStream.ts) but until now consumed only by the
  // console pane, so the chat bubble waited for the whole block.
  const liveText = useChatStream(effectiveId);

  // The fast path (src/lib/chatTriage.ts): the question shows at once (optimistic row ⇒
  // `busy`), the wait line reads "Retrieving memory…" while ONE Haiku call recalls the brain
  // and decides. No tool needed ⇒ its reply is the answer, appended here and persisted
  // server-side — the worker never runs. Tools needed ⇒ the label clears ("Percolating…")
  // and the worker, already fed by the server-written user row, takes over. Unreachable ⇒
  // the browser inserts the row itself, exactly the pre-fast-path send.
  // A slow triage on an earlier question never clears the label of a later one: the
  // send seq is checked before the flag is dropped.
  const [recalling, setRecalling] = useState(false);
  const sendSeq = useRef(0);

  async function handleSend(text: string) {
    if (!effectiveId || !currentProjectId) return;
    const seq = ++sendSeq.current;
    const id = crypto.randomUUID();
    appendLocal({ id, role: 'user', content: text, timestamp: new Date() });
    setRecalling(true);
    try {
      const r = await triageChat({ id, question: text, sessionId: effectiveId, projectId: currentProjectId });
      if (!r) await sendMessage(text, id);
      else if (r.mode === 'answer') {
        appendLocal({ id: r.reply.id, role: 'agent', content: r.reply.content, timestamp: new Date(r.reply.ts), rating: 0 });
      }
    } finally {
      if (sendSeq.current === seq) setRecalling(false);
    }
  }

  // askChat() from anywhere on the page — a StatCard's query mode, the brain's
  // Quickstart button — lands in the current thread, ack included. Through a ref so
  // the stable listener always calls the latest sender (same trick as ChatDock's).
  const sendRef = useRef(handleSend);
  useEffect(() => { sendRef.current = handleSend; });
  useEffect(() => {
    function onAsk(e: Event) {
      const question = (e as CustomEvent<string>).detail;
      if (question) void sendRef.current(question);
    }
    window.addEventListener(ASK_CHAT_EVENT, onAsk);
    return () => window.removeEventListener(ASK_CHAT_EVENT, onAsk);
  }, []);

  // The onboarding tour's "chat-replied" gate (App listens): fire once per agent
  // reply. The admin path dispatches this from sendChat; on the agent path the
  // reply arrives as a row over Realtime, so the arrival is the signal.
  const last = messages[messages.length - 1];
  const repliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!last || last.role !== 'agent' || repliedRef.current === last.id) return;
    repliedRef.current = last.id;
    window.dispatchEvent(new Event(CHAT_REPLIED_EVENT));
  }, [last]);

  async function handleNewChat() {
    const id = await createSession();
    onSessionChange?.(id);
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, fontSize: 13 }}>
      {/* Conversations — collapses to a 48px strip (the nav rail's width) */}
      <div style={{
        width: collapsed ? 48 : 200,
        flexShrink: 0,
        borderRight: '1px solid #000',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width 150ms',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'space-between',
          gap: collapsed ? 0 : 6,
          // Matches ChatPanel's own header (padding 4px 8px, fontSize 12) so this
          // box and the "Agent" row share one horizontal line across the divider.
          padding: '4px 8px',
          borderBottom: '1px solid #000',
          fontSize: 12,
          fontWeight: 'bold',
          whiteSpace: 'nowrap',
        }}>
          {/* Kept in the row when collapsed, clipped to zero width: the label's
              line box is what gives this header the same height as ChatPanel's
              "Agent" row beside it. Drop it and the strip's lone 14px icon makes
              the box 4px shorter, so the two rules no longer meet. */}
          <span style={{ display: 'block', width: collapsed ? 0 : 'auto', overflow: 'hidden' }}>Chats</span>
          <button
            onClick={() => onCollapsedChange?.(!collapsed)}
            title={collapsed ? 'Show the chat list' : 'Hide the chat list'}
            aria-label={collapsed ? 'Show the chat list' : 'Hide the chat list'}
            aria-expanded={!collapsed}
            style={{ background: 'none', border: 'none', color: '#000', padding: 5, margin: -5, cursor: 'pointer', lineHeight: 0, display: 'flex' }}
          >
            {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
          </button>
        </div>
        <button
          onClick={handleNewChat}
          title="Start a new conversation"
          style={{
            background: 'none',
            border: 'none',
            borderBottom: '1px solid #eee',
            color: '#000',
            fontSize: 11,
            padding: collapsed ? '8px 0' : '6px 10px',
            cursor: 'pointer',
            letterSpacing: 0.3,
            textAlign: collapsed ? 'center' : 'left',
            whiteSpace: 'nowrap',
          }}
        >
          {collapsed ? '＋' : '＋ New chat'}
        </button>
        <div style={{ flex: 1, overflowY: 'auto', display: collapsed ? 'none' : 'block' }}>
          {loading && (
            <div style={{ padding: '8px 10px', color: '#888', fontSize: 12 }}>Loading…</div>
          )}
          {!loading && threads.length === 0 && (
            <div style={{ padding: '8px 10px', color: '#888', fontSize: 12 }}>No chats yet</div>
          )}
          {threads.map(session => {
            const isActive = effectiveId === session.id;
            const iconColor = isActive ? '#fff' : '#888';
            return (
              <div
                key={session.id}
                onClick={() => onSessionChange?.(session.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '8px 8px 8px 10px',
                  borderBottom: '1px solid #eee',
                  background: isActive ? '#000' : '#fff',
                  color: isActive ? '#fff' : '#000',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontWeight: 'bold',
                  }}>
                    {session.title ?? 'Untitled chat'}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
                    {formatRelativeTime(session.createdAt)}
                  </div>
                </div>
                <button
                  title="Rename"
                  onClick={e => { e.stopPropagation(); setRenameTarget(session); }}
                  style={{ background: 'none', border: 'none', color: iconColor, cursor: 'pointer', fontSize: 12, padding: '2px 3px', lineHeight: 1 }}
                >
                  ✎
                </button>
                <button
                  title="Delete"
                  onClick={e => { e.stopPropagation(); setDeleteTarget(session); }}
                  style={{ background: 'none', border: 'none', color: iconColor, cursor: 'pointer', fontSize: 14, padding: '2px 3px', lineHeight: 1 }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Conversation */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {effectiveId === undefined ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' }}>
            Connecting to the agent…
          </div>
        ) : (
          <ChatPanel
            messages={messages}
            onSend={handleSend}
            thinkingLabel={recalling ? 'Retrieving memory…' : undefined}
            liveText={liveText}
            onCancel={cancelRun}
            onRate={setRating}
            onLoadOlder={loadOlder}
            onRefetch={refetchNewer}
            hasMore={hasMore}
            loadingOlder={loadingOlder}
            emptyState={
              messagesLoading
                ? <span style={{ color: '#888' }}>Loading…</span>
                : <WelcomeGreeting />
            }
          />
        )}
      </div>

      {renameTarget && (
        <PromptModal
          title="Rename chat"
          initialValue={renameTarget.title ?? ''}
          placeholder="chat name"
          confirmLabel="Save"
          onSubmit={async v => {
            await updateSessionTitle(renameTarget.id, v);
            setRenameTarget(null);
          }}
          onCancel={() => setRenameTarget(null)}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete chat"
          message={`Delete "${deleteTarget.title ?? 'Untitled chat'}" and all its messages? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await deleteSession(deleteTarget.id);
            // Fall back to the most recent remaining thread.
            if (effectiveId === deleteTarget.id) onSessionChange?.(null);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
