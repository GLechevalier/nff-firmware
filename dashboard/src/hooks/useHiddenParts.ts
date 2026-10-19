import { useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

/** Per-user Settings → Store state: hidden part keys in user_metadata (no
 * tables, the AccountSettingsModal pattern). Missing key = installed. */
export function useHiddenParts(user: User) {
  const [hidden, setHidden] = useState<string[]>(
    () => (user.user_metadata?.hidden_parts as string[] | undefined) ?? [],
  );
  function persist(next: string[]) {
    setHidden(next);
    void supabase.auth.updateUser({ data: { hidden_parts: next } });
  }
  function toggle(key: string) {
    persist(hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]);
  }
  // Adds and removes whole sets of keys in ONE persisted write — a condensed
  // Store switch (Devices, Dev) stands for several real nav-group ids, and
  // switching the Dev app on both un-hides its default tool and drops the
  // opt-in keys of the ones that ship off (see lib/store.tsx).
  function setParts(hide: string[], show: string[]) {
    const rest = hidden.filter((k) => !hide.includes(k) && !show.includes(k));
    persist([...rest, ...hide]);
  }
  return { hidden, toggle, setParts };
}
