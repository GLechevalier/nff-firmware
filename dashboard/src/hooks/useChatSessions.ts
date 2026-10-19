import { useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { useCurrentProject } from '../context/CurrentProjectContext';
import { mutate, useSharedResource } from '../lib/sharedResource';

export interface ChatSession {
  id: string;
  title: string | null;
  // 'chat'    = a normal Agent-tab conversation; 'query' = a QueryPopup device thread;
  // 'builder' = a "Develop a Feature" interview thread (the agent-worker recognises this
  // kind and switches to the feature-interview persona — see migration 0041).
  // The Agent tab only ever uses 'chat' sessions so a device query never hijacks it.
  kind: 'chat' | 'query' | 'builder';
  createdAt: Date;
  updatedAt: Date;
}

function mapRow(row: Record<string, unknown>): ChatSession {
  return {
    id: row.id as string,
    title: row.title as string | null,
    kind: (row.kind as 'chat' | 'query' | 'builder' | null) ?? 'chat',
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

const keyFor = (projectId: string) => `chat_sessions:${projectId}`;

async function fetchSessions(projectId: string): Promise<ChatSession[]> {
  const { data, error } = await supabase
    .from('chat_sessions')
    .select('*')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(row => mapRow(row as Record<string, unknown>));
}

export function useChatSessions() {
  const { currentProjectId } = useCurrentProject();
  const key = currentProjectId ? keyFor(currentProjectId) : null;

  const { data, loading, error } = useSharedResource<ChatSession[]>(key, {
    fetcher: () => fetchSessions(currentProjectId),
    subscribe: ctx => {
      const channelId = Math.random().toString(36).slice(2);
      const channel = supabase
        .channel(`chat-sessions-${channelId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_sessions',
          filter: `project_id=eq.${currentProjectId}`,
        }, payload => {
          const row = mapRow(payload.new as Record<string, unknown>);
          // createSession already inserted the row optimistically — de-dupe on id so the echo
          // of our own INSERT doesn't double it up.
          ctx.mutate(prev =>
            (prev ?? []).some(s => s.id === row.id) ? prev : [row, ...(prev ?? [])]);
        })
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'chat_sessions',
          filter: `project_id=eq.${currentProjectId}`,
        }, payload => {
          const row = mapRow(payload.new as Record<string, unknown>);
          ctx.mutate(prev => (prev ?? []).map(s => s.id === row.id ? row : s));
        })
        .subscribe();

      return () => { supabase.removeChannel(channel); };
    },
  });

  const sessions = useMemo(() => data ?? [], [data]);

  // kind defaults to 'chat' (the Agent tab); pass 'builder' to open a "Develop a Feature"
  // interview thread the agent-worker drives with the feature-interview persona.
  async function createSession(kind: 'chat' | 'builder' = 'chat'): Promise<string> {
    const id = crypto.randomUUID();
    if (key) {
      mutate<ChatSession[]>(key, prev => [{
        id,
        title: null,
        kind,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, ...(prev ?? [])]);
    }
    const { error } = await supabase
      .from('chat_sessions')
      .insert({ id, project_id: currentProjectId, kind });
    if (error) console.error('[useChatSessions] createSession insert failed:', error.message);
    return id;
  }

  async function updateSessionTitle(id: string, title: string): Promise<void> {
    if (key) {
      mutate<ChatSession[]>(key, prev =>
        (prev ?? []).map(s => s.id === id ? { ...s, title, updatedAt: new Date() } : s));
    }
    await supabase
      .from('chat_sessions')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', id);
  }

  // Delete a session and its messages. agent_messages.session_id is a plain TEXT
  // column with no FK to chat_sessions (migration 0010), so dropping the session
  // row does NOT cascade — delete the messages explicitly first. Both deletes need
  // the members_delete RLS policies added in migration 0037.
  async function deleteSession(id: string): Promise<void> {
    if (key) mutate<ChatSession[]>(key, prev => (prev ?? []).filter(s => s.id !== id));
    const { error: msgErr } = await supabase
      .from('agent_messages')
      .delete()
      .eq('session_id', id)
      .eq('project_id', currentProjectId);
    if (msgErr) console.error('[useChatSessions] deleteSession messages failed:', msgErr.message);
    const { error } = await supabase
      .from('chat_sessions')
      .delete()
      .eq('id', id)
      .eq('project_id', currentProjectId);
    if (error) console.error('[useChatSessions] deleteSession failed:', error.message);
  }

  return { sessions, loading, error, createSession, updateSessionTitle, deleteSession };
}
