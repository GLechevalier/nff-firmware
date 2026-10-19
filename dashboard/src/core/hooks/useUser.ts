import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { setResourceCacheUser } from '../lib/resourceCache';

/** Current Supabase auth state (same pattern as nff-dashboard). */
export function useUser(): { user: User | null; loading: boolean; signOut: () => Promise<void> } {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      // Point the cache at this user (hydrating their sessionStorage mirror) BEFORE loading flips
      // and App mounts, so the very first render of every tab paints from last-known data.
      setResourceCacheUser(data.session?.user?.id ?? null);
      setUser(data.session?.user ?? null);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      // The resource cache is module state — it outlives the React tree, so AdminGate swapping App
      // for LoginPage on sign-out does NOT clear it. setResourceCacheUser clears entries AND the
      // storage mirror on any user change (same-user calls, e.g. token refreshes, are no-ops), so
      // signing in as a different admin in the same tab can never paint the previous admin's data.
      setResourceCacheUser(session?.user?.id ?? null);
      setUser(session?.user ?? null);
      setLoading(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
  }

  return { user, loading, signOut };
}
