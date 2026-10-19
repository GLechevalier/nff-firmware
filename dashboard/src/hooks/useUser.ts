import { useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { forceSignOut, isDeadSessionAuthError } from '../lib/staleSession';
import { resetSharedResources } from '../lib/sharedResource';

/**
 * Lightweight read of the current Supabase auth state. The dashboard has no
 * login of its own — sessions are minted by the separate landing app and (once
 * the ?cb= handshake lands) handed over here. Until then this resolves to a
 * null user and the UI degrades to a signed-out state.
 *
 * `getSession` only parses the JWT out of localStorage, so it happily returns a
 * user whose account no longer exists. We confirm the account against the auth
 * server once per mount and drop the session if it's gone; see `lib/staleSession`.
 */
export function useUser(): { user: User | null; loading: boolean; signOut: () => Promise<void> } {
  const [user, setUser]       = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // Whose data the shared-resource cache currently holds.
  const cachedFor = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function resolveUser() {
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!session) {
        setUser(null);
        setLoading(false);
        return;
      }

      const { data, error } = await supabase.auth.getUser();
      if (cancelled) return;

      if (isDeadSessionAuthError(error)) {
        await forceSignOut();
        if (cancelled) return;
        setUser(null);
        setLoading(false);
        return;
      }

      // Any other error (offline, 5xx) leaves the cached session in place.
      setUser(data?.user ?? session.user);
      setLoading(false);
    }

    void resolveUser();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextId = session?.user?.id ?? null;
      // The shared-resource cache is module state — it outlives the React tree, so AuthGate
      // unmounting App on sign-out does NOT clear it. Without this, signing out and signing in as
      // someone else in the same tab would render the previous user's fleet, crashes and repos
      // until each resource revalidated. RLS can't help: this is a client-side cache, not a query.
      //
      // BUT only reset when SWAPPING between two real users. The very first auth event after mount
      // (INITIAL_SESSION) fires with cachedFor.current still null, ~15ms in — while the first data
      // fetches are already in flight. Resetting there is pointless (nothing cached to leak yet) and
      // actively harmful: entries.clear() drops those entries mid-flight, the resolved fetch writes
      // to a now-orphaned entry, and the recreated entry never re-subscribes → the hook is pinned on
      // loading:true forever ("Loading…" that never resolves — see the Agent console hang). Guarding
      // on a non-null previous id makes that first event a no-op; a genuine user switch still resets
      // (its refetches run after the fresh mount, so they can't be orphaned).
      if (cachedFor.current !== null && nextId !== cachedFor.current) {
        resetSharedResources();
      }
      cachedFor.current = nextId;
      setUser(session?.user ?? null);
      setLoading(false);
    });
    return () => { cancelled = true; subscription.unsubscribe(); };
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
  }

  return { user, loading, signOut };
}
