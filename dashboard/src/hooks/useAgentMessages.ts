import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useCurrentProject } from '../context/CurrentProjectContext';
import type { ChatMessage } from '../components/chat/ChatPanel';
import { stripContextPreamble } from '../utils/chat';

function mapRow(row: Record<string, unknown>): ChatMessage {
  const role = row.role as 'user' | 'agent';
  const content = row.content as string;
  return {
    id: row.id as string,
    role,
    // Hide any injected context preamble (e.g. QueryPopup's device prompt) so the
    // history shows only the user's actual question, never the engineered prompt.
    content: role === 'user' ? stripContextPreamble(content) : content,
    timestamp: new Date(row.ts as string),
    // Per-message thumbs vote (agent replies): NULL/0 = none, 1 = like, -1 = unlike.
    rating: (row.rating as number | null) ?? 0,
  };
}

// How many messages to show initially / per "load older" page.
const PAGE_SIZE = 50;

// sessionId: undefined  → skip fetch (session not yet resolved)
//            null       → legacy messages (session_id IS NULL in DB)
//            string     → messages for that specific session UUID
export function useAgentMessages(sessionId: string | null | undefined) {
  const { currentProjectId } = useCurrentProject();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  // error: a transport-level failure of the initial fetch (e.g. Supabase throttled/over quota).
  // Without surfacing this, a rejected promise leaves `loading` stuck true forever and the pane
  // spins with a dead input box — exactly the "Loading… and can't type" prod symptom.
  const [error, setError] = useState<string | null>(null);
  // hasMore: an older page may still exist (last fetch returned a full PAGE_SIZE).
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    if (!currentProjectId || sessionId === undefined) {
      setMessages([]);
      setLoading(true);
      setHasMore(false);
      return;
    }

    setLoading(true);
    setError(null);
    setMessages([]);
    setHasMore(false);
    setLoadingOlder(false);

    // Fetch the NEWEST PAGE_SIZE (descending), then reverse to ascending for display.
    let query = supabase
      .from('agent_messages')
      .select('*')
      .eq('project_id', currentProjectId)
      .order('ts', { ascending: false })
      .limit(PAGE_SIZE);
    query = sessionId === null ? query.is('session_id', null) : query.eq('session_id', sessionId);

    query.then(({ data, error: err }) => {
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const rows = (data ?? []).map(row => mapRow(row as Record<string, unknown>)).reverse();
      setMessages(rows);
      setHasMore((data?.length ?? 0) === PAGE_SIZE);
      setLoading(false);
    }, e => {
      // Transport-level rejection (CORS, Failed to fetch, hung request) — never leave loading true.
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    });

    const channelId = Math.random().toString(36).slice(2);
    const channel = supabase
      .channel(`agent-messages-${channelId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'agent_messages',
        filter: `project_id=eq.${currentProjectId}`,
      }, payload => {
        const incoming = payload.new as { session_id?: string | null };
        // Only include rows belonging to the currently viewed session.
        const matches =
          sessionId === null
            ? incoming.session_id == null
            : incoming.session_id === sessionId;
        if (!matches) return;
        const row = mapRow(payload.new as Record<string, unknown>);
        setMessages(prev => prev.some(m => m.id === row.id) ? prev : [...prev, row]);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [currentProjectId, sessionId]);

  // Prepend the previous PAGE_SIZE of messages older than the oldest one loaded.
  // Keeps the view anchored (ChatPanel doesn't auto-scroll on a prepend).
  async function loadOlder() {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    setLoadingOlder(true);
    const oldestTs = messages[0].timestamp.toISOString();
    let query = supabase
      .from('agent_messages')
      .select('*')
      .eq('project_id', currentProjectId)
      .lte('ts', oldestTs)
      .order('ts', { ascending: false })
      .limit(PAGE_SIZE);
    query = sessionId === null ? query.is('session_id', null) : query.eq('session_id', sessionId);

    const { data } = await query;
    const older = (data ?? []).map(row => mapRow(row as Record<string, unknown>)).reverse();
    setMessages(prev => {
      const seen = new Set(prev.map(m => m.id));
      return [...older.filter(m => !seen.has(m.id)), ...prev];
    });
    setHasMore((data?.length ?? 0) === PAGE_SIZE);
    setLoadingOlder(false);
  }

  // Re-poll for replies the Realtime channel never delivered. A dropped websocket
  // (laptop sleep, network blip, a CHANNEL_ERROR the client didn't recover from) leaves
  // rows sitting in the DB unseen, which the panel reads as "the agent went silent" —
  // observed 2026-08-11, where three replies including a full feature plan were written
  // while the tab showed "the agent may be offline". ChatPanel calls this before it
  // shows that notice. Fetches only rows at-or-newer than the newest one held, so it
  // stays cheap; `gte` (not `gt`) keeps rows sharing the newest timestamp, and the id
  // dedup below drops the overlap. Returns `prev` untouched when nothing is new, so a
  // fruitless poll causes no re-render and no timer re-arm.
  async function refetchNewer() {
    if (!currentProjectId || sessionId === undefined) return;
    let query = supabase
      .from('agent_messages')
      .select('*')
      .eq('project_id', currentProjectId)
      .order('ts', { ascending: true })
      .limit(PAGE_SIZE);
    if (messages.length > 0) query = query.gte('ts', messages[messages.length - 1].timestamp.toISOString());
    query = sessionId === null ? query.is('session_id', null) : query.eq('session_id', sessionId);

    const { data } = await query;
    const rows = (data ?? []).map(row => mapRow(row as Record<string, unknown>));
    setMessages(prev => {
      const seen = new Set(prev.map(m => m.id));
      const fresh = rows.filter(m => !seen.has(m.id));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }

  // Show a row before (or instead of) its Realtime arrival. Deduped by id, like the
  // subscription above, so the real INSERT landing later is a no-op. Used for the user's
  // own message the moment it is sent, and for the fast path's instant reply.
  function appendLocal(msg: ChatMessage) {
    setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
  }

  // Insert the user row directly — the pre-fast-path send, kept as the fallback when
  // /api/chat/triage is unreachable. `id` lets the caller reuse an already-shown
  // optimistic row instead of painting a second bubble.
  async function sendMessage(content: string, id: string = crypto.randomUUID()) {
    if (sessionId === undefined || sessionId === null) return;
    const msg: ChatMessage = { id, role: 'user', content, timestamp: new Date() };
    appendLocal(msg);
    await supabase
      .from('agent_messages')
      .insert({
        id: msg.id,
        role: 'user',
        content,
        ts: msg.timestamp.toISOString(),
        session_id: sessionId,
        project_id: currentProjectId,
      });
  }

  // Ask the worker to STOP the in-flight run for this thread (the Pause button).
  // Fire-and-forget: insert a signal row the agent-worker subscribes to over Realtime;
  // it aborts the matching active run, drops this thread's queued items, and writes a
  // `⏹ Stopped by user.` status line that clears the panel's `busy` flag. Scoped by
  // project + session so pausing one thread never kills another's queued message.
  // No-op until the session is resolved (same guard as sendMessage) — a null/undefined
  // session has no run to cancel.
  async function cancelRun() {
    if (!currentProjectId || sessionId === undefined || sessionId === null) return;
    await supabase
      .from('agent_run_cancels')
      .insert({ project_id: currentProjectId, session_id: sessionId });
  }

  // Persist a thumbs vote on an agent reply. Optimistic (like sendMessage above):
  // the UI reflects the click immediately, then we write it. Rating UPDATEs don't
  // arrive over the Realtime channel (only INSERTs are subscribed), so the local
  // update is what the panel renders. Restricted to the `rating` column by RLS +
  // a column-level grant (migration 0092).
  async function setRating(id: string, next: number) {
    setMessages(prev => prev.map(m => (m.id === id ? { ...m, rating: next } : m)));
    await supabase.from('agent_messages').update({ rating: next }).eq('id', id);
  }

  return { messages, loading, error, sendMessage, appendLocal, cancelRun, setRating, loadOlder, refetchNewer, hasMore, loadingOlder };
}
