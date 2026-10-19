import { supabase } from './supabase';

/**
 * Customer invite claiming (migration 0104).
 *
 * The LoginPage validates a username + one-time code against
 * `check_customer_invite` (anon RPC) and parks the pair here in localStorage
 * BEFORE the user authenticates — the pending invite must survive both the
 * Google/GitHub OAuth redirect and the email-confirmation detour (sign up,
 * confirm in the inbox, come back and sign in), and localStorage is the only
 * thing that does. Once a session exists, CurrentProjectProvider calls
 * `claimPendingInvite()` before it fetches memberships, so the freshly claimed
 * workspace is already in the first project list the customer sees.
 *
 * The claim is one-time and fully validated server-side
 * (`claim_customer_invite`), so a stale or tampered localStorage entry can't do
 * anything — every terminal outcome clears the key; only a transport failure
 * keeps it for a retry on the next load.
 */

const PENDING_KEY = 'nff.pendingInvite';

export interface PendingInvite {
  username: string;
  code: string;
}

export type ClaimOutcome =
  | { ok: true; projectId: string; username: string }
  | { ok: false; reason: 'claimed' | 'expired' | 'revoked' | 'invalid' };

export function getPendingInvite(): PendingInvite | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingInvite>;
    if (typeof parsed.username !== 'string' || typeof parsed.code !== 'string') return null;
    return { username: parsed.username, code: parsed.code };
  } catch {
    return null;
  }
}

export function setPendingInvite(invite: PendingInvite): void {
  localStorage.setItem(PENDING_KEY, JSON.stringify(invite));
}

export function clearPendingInvite(): void {
  localStorage.removeItem(PENDING_KEY);
}

/**
 * Claim the pending invite for the signed-in user, if one is parked.
 * Returns null when there is nothing to claim (the overwhelmingly common case)
 * or when a transport error makes the outcome unknown (invite kept for retry).
 */
export async function claimPendingInvite(): Promise<ClaimOutcome | null> {
  const pending = getPendingInvite();
  if (!pending) return null;

  const { data, error } = await supabase.rpc('claim_customer_invite', {
    p_username: pending.username,
    p_code: pending.code,
  });
  if (error) return null; // transport/unknown — keep the invite, retry next load

  const result = data as { ok: boolean; project_id?: string; username?: string; hostname?: string | null; reason?: string };
  clearPendingInvite();

  if (!result?.ok) {
    const reason = result?.reason;
    return {
      ok: false,
      reason: reason === 'claimed' || reason === 'expired' || reason === 'revoked' ? reason : 'invalid',
    };
  }

  // The RPC already stamped `username` (and `tenant_hostname` when the
  // workspace has a branded domain, 0107) into auth.users metadata atomically
  // with the claim; refresh so the in-memory session sees it, and updateUser
  // as belt-and-braces for stacks where the definer fn can't write auth.users.
  await supabase.auth
    .updateUser({
      data: {
        username: result.username,
        ...(result.hostname ? { tenant_hostname: result.hostname } : {}),
      },
    })
    .catch(() => {});
  await supabase.auth.refreshSession().catch(() => {});

  return { ok: true, projectId: result.project_id!, username: result.username! };
}

/** Anon pre-auth check used by the LoginPage invite step. */
export async function checkInvite(
  username: string,
  code: string,
): Promise<{ valid: boolean; projectName?: string }> {
  const { data, error } = await supabase.rpc('check_customer_invite', {
    p_username: username,
    p_code: code,
  });
  if (error) throw new Error(error.message);
  const result = data as { valid: boolean; project_name?: string };
  return { valid: !!result?.valid, projectName: result?.project_name };
}
