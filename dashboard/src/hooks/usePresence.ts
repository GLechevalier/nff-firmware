import { useEffect } from 'react';
import { supabase } from '../lib/supabase';

/**
 * Tracks this signed-in user on the shared 'online-users' Realtime Presence
 * channel while the dashboard is open. nff-admin subscribes to the same channel
 * (without tracking itself) to count concurrent users live — no DB writes.
 *
 * The presence key is the user id, so several tabs from one user collapse into
 * one presence entry with multiple metas. Re-keying on project switch re-tracks
 * with the new project_id.
 *
 * Note: this is a plain (non-private) channel, fine with the anon key + session
 * today. If the Supabase project ever enforces private Realtime channels, both
 * this and nff-admin's subscriber need supabase.realtime.setAuth() first.
 */
export function usePresence(userId: string, projectId: string | null) {
  useEffect(() => {
    const channel = supabase.channel('online-users', {
      config: { presence: { key: userId } },
    });
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        void channel.track({
          user_id: userId,
          project_id: projectId,
          online_at: new Date().toISOString(),
        });
      }
    });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [userId, projectId]);
}
