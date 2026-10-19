import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

/**
 * Counts dashboard users live via the shared 'online-users' presence channel.
 * Subscribes WITHOUT calling .track(), so the admin itself is never counted.
 * Presence keys are user ids, so several tabs of one user collapse into one
 * key with multiple metas: `users` = distinct people, `connections` = tabs.
 */
export function useOnlineUsers(): { users: number; connections: number } {
  const [counts, setCounts] = useState({ users: 0, connections: 0 });

  useEffect(() => {
    const channel = supabase.channel('online-users');
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        const keys = Object.keys(state);
        setCounts({
          users: keys.length,
          connections: keys.reduce((sum, k) => sum + state[k].length, 0),
        });
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  return counts;
}
