import type { AuthError, PostgrestError } from '@supabase/supabase-js';
import { supabase } from './supabase';

/**
 * A session can outlive the account it belongs to: the JWT sits in localStorage,
 * still unexpired and still signed by the right key, while `auth.users` no longer
 * holds the row its `sub` claim points at (account deleted, database restored from
 * an older snapshot, dev pointed at a different Supabase project). Every read is
 * then RLS-empty and the first write dies on a foreign key:
 *
 *   insert or update on table "projects" violates foreign key constraint
 *   "projects_owner_id_fkey" — Key (owner_id)=(…) is not present in table "users".
 *
 * There is no recovery from inside the app: the only correct response is to drop
 * the session and send the user back to the login page.
 */

/** Auth-server codes that mean "this token's user/session is gone", not "you're offline". */
const DEAD_SESSION_CODES = new Set([
  'user_not_found',
  'session_not_found',
  'refresh_token_not_found',
  'bad_jwt',
]);

/**
 * True when an auth-server error says the token's user no longer exists.
 *
 * Deliberately narrow: a network failure surfaces as `AuthRetryableFetchError`
 * (status 0) and must NOT log anyone out — an offline user keeps their session.
 */
export function isDeadSessionAuthError(error: AuthError | null): boolean {
  if (!error) return false;
  if (error.code && DEAD_SESSION_CODES.has(error.code)) return true;
  // Older gotrue builds send no `code`, just a 403 and this message.
  return error.status === 403 && /user from sub claim/i.test(error.message);
}

/**
 * True when a PostgREST error is the orphaned-owner foreign key violation above.
 *
 * Matches only FK violations (23503) that point at `auth.users`, so an unrelated
 * FK bug elsewhere in the schema still surfaces as a normal error instead of
 * silently logging the user out.
 */
export function isOrphanedUserError(error: PostgrestError | null): boolean {
  if (!error || error.code !== '23503') return false;
  const details = error.details ?? '';
  return /is not present in table "users"/i.test(details) || /_owner_id_fkey|_user_id_fkey/.test(error.message);
}

/**
 * Tear the session down locally and land back on the login page.
 *
 * `scope: 'local'` because the server-side logout would itself 403 on a token whose
 * user is gone, leaving the dead session in localStorage and the app stuck in a
 * loop. Local scope always clears storage and always emits SIGNED_OUT, which is
 * what `useUser` listens for.
 */
export async function forceSignOut(): Promise<void> {
  localStorage.removeItem('nff.currentProjectId');
  await supabase.auth.signOut({ scope: 'local' });
}
