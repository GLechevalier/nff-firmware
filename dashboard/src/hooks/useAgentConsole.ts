import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useCurrentProject } from '../context/CurrentProjectContext';
import type { ConsoleEntry } from '../components/squeletton/ConsolePanel';

function mapRow(row: Record<string, unknown>): ConsoleEntry {
  return {
    id: row.id as string,
    type: row.type as ConsoleEntry['type'],
    content: row.content as string,
    timestamp: new Date(row.ts as string),
  };
}

// How many entries to show initially / per "load older" page.
const PAGE_SIZE = 50;

// Live agent console: initial fetch + Realtime INSERTs on agent_console_entries.
// The nff-agent-worker writes these rows (tool calls / output / info / error).
export function useAgentConsole() {
  const { currentProjectId } = useCurrentProject();
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // hasMore: an older page may still exist (last fetch returned a full PAGE_SIZE).
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    if (!currentProjectId) return;
    setLoading(true);
    setEntries([]);
    setHasMore(false);
    setLoadingOlder(false);

    // Fetch the NEWEST PAGE_SIZE (descending), then reverse to ascending for display.
    supabase
      .from('agent_console_entries')
      .select('*')
      .eq('project_id', currentProjectId)
      .order('ts', { ascending: false })
      .limit(PAGE_SIZE)
      .then(({ data }) => {
        setEntries((data ?? []).map(row => mapRow(row as Record<string, unknown>)).reverse());
        setHasMore((data?.length ?? 0) === PAGE_SIZE);
        setLoading(false);
      });

    const channelId = Math.random().toString(36).slice(2);
    const channel = supabase
      .channel(`agent-console-${channelId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'agent_console_entries', filter: `project_id=eq.${currentProjectId}` }, payload => {
        setEntries(prev => [...prev, mapRow(payload.new as Record<string, unknown>)]);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [currentProjectId]);

  // Prepend the previous PAGE_SIZE of entries older than the oldest one loaded.
  async function loadOlder() {
    if (loadingOlder || !hasMore || entries.length === 0) return;
    setLoadingOlder(true);
    const oldestTs = entries[0].timestamp.toISOString();
    const { data } = await supabase
      .from('agent_console_entries')
      .select('*')
      .eq('project_id', currentProjectId)
      .lte('ts', oldestTs)
      .order('ts', { ascending: false })
      .limit(PAGE_SIZE);
    const older = (data ?? []).map(row => mapRow(row as Record<string, unknown>)).reverse();
    setEntries(prev => {
      const seen = new Set(prev.map(e => e.id));
      return [...older.filter(e => !seen.has(e.id)), ...prev];
    });
    setHasMore((data?.length ?? 0) === PAGE_SIZE);
    setLoadingOlder(false);
  }

  // View-only clear (does not delete DB rows; they return on reload).
  function clear() {
    setEntries([]);
    setHasMore(false);
  }

  return { entries, loading, clear, loadOlder, hasMore, loadingOlder };
}
