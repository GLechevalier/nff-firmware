// "Connect your brain" — the self-serve half of migration 0141.
//
// Every user gets their own brain: a private graph in their personal project,
// which their nff-brain CLI / Chrome / VS Code client pushes into over
// /api/brain/ingest. Nodes they mark `shared` surface into the company brain of
// every workspace they are a member of (company_brain_shared_nodes) — nothing
// else ever leaves their brain.
//
// There is NO server code behind this component. mint_brain_sync_token and
// revoke_brain_sync_token are SECURITY DEFINER RPCs granted to `authenticated`
// that act on auth.uid(), so the browser calls them directly. The token itself
// is generated and hashed here — the database only ever stores the SHA-256, and
// only ever receives the hash (0141 deliberately takes an already-hashed token
// rather than pulling in pgcrypto).

import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

const card: React.CSSProperties = { border: '1px solid #ddd', marginBottom: 12, background: '#fff' };
const panelHeader: React.CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid #ddd',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: '#444',
};

interface TokenRow {
  home_project_id: string;
  created_at: string;
  last_synced_at: string | null;
  node_count: number;
  revoked_at: string | null;
}

/** 32 random bytes as base64url, plus its SHA-256 — the pair 0141 expects. */
async function mintToken(): Promise<{ plaintext: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const plaintext = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { plaintext, hash };
}

export function BrainConnect() {
  const [row, setRow] = useState<TokenRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown ONCE, right after minting. Never stored, never re-readable — the
  // database has only the hash.
  const [freshToken, setFreshToken] = useState<string | null>(null);

  async function load() {
    // brain_sync_tokens' "own token select" policy (0141) returns the caller's
    // row and nobody else's.
    const { data, error: e } = await supabase
      .from('brain_sync_tokens')
      .select('home_project_id,created_at,last_synced_at,node_count,revoked_at')
      .maybeSingle();
    if (e) setError(e.message);
    setRow((data as TokenRow | null) ?? null);
    setLoading(false);
  }

  useEffect(() => {
    // load() sets state only after awaiting the query; the rule can't see
    // through the shared loader (connect/revoke call it too).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const { plaintext, hash } = await mintToken();
      const { error: e } = await supabase.rpc('mint_brain_sync_token', { p_token_hash: hash });
      if (e) throw new Error(e.message);
      setFreshToken(plaintext);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!window.confirm('Revoke this token?\n\nYour extension and CLI stop syncing until you connect again. The brain they already pushed stays.')) return;
    setBusy(true);
    setError(null);
    try {
      const { error: e } = await supabase.rpc('revoke_brain_sync_token');
      if (e) throw new Error(e.message);
      setFreshToken(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const live = row && !row.revoked_at;

  return (
    <div style={card}>
      <div style={panelHeader}>Your brain</div>
      <div style={{ padding: 10, fontSize: 12, lineHeight: 1.5 }}>
        <div style={{ color: '#666', marginBottom: 10 }}>
          Your nff-brain extension and CLI can sync your personal brain here. It stays private —
          only the nodes you mark as <b>shared</b> appear in this company's brain, and only for
          workspaces you are a member of.
        </div>

        {loading ? (
          <div style={{ color: '#888' }}>Loading…</div>
        ) : (
          <>
            {live ? (
              <div style={{ marginBottom: 10 }}>
                Connected {new Date(row.created_at).toLocaleString()} ·{' '}
                {row.last_synced_at
                  ? `last sync ${new Date(row.last_synced_at).toLocaleString()} (${row.node_count} node${row.node_count === 1 ? '' : 's'})`
                  : 'never synced'}
              </div>
            ) : (
              <div style={{ marginBottom: 10, color: '#666' }}>
                {row ? 'Revoked — connect again to resume syncing.' : 'Not connected yet.'}
              </div>
            )}

            {freshToken && (
              <div style={{ border: '1px solid #cc0', background: '#ffffe8', padding: 8, marginBottom: 10 }}>
                <div style={{ marginBottom: 6 }}>
                  <b>Copy this token now — it is shown once.</b>
                </div>
                <code style={{ display: 'block', wordBreak: 'break-all', fontSize: 11 }}>{freshToken}</code>
                <div style={{ marginTop: 6, color: '#666' }}>
                  Set it as <code>NFF_BRAIN_COMPANY_SYNC_TOKEN</code>, or paste it into the
                  extension's company-sync settings. Point the sync URL at this app's{' '}
                  <code>/api/brain/ingest</code>.
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={connect} disabled={busy}>
                {busy ? 'Working…' : live ? 'Regenerate token' : 'Connect my brain'}
              </button>
              {live && (
                <button type="button" onClick={revoke} disabled={busy}>
                  Revoke
                </button>
              )}
            </div>

            {error && <div style={{ marginTop: 8, color: '#c00' }}>{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
