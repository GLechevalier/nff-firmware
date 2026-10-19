import type React from 'react';
import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { BRAND_ACCENT } from '../../lib/brand';
import { forceSignOut } from '../../lib/staleSession';
import { useUser } from '../../hooks/useUser';
import { Avatar } from './ProfileMenu';
import { ConfirmModal } from './ConfirmModal';

/**
 * Personal (user-scoped) settings, opened from the gear in ProfileMenu.
 *
 * Distinct from SettingsTab, which is project-scoped — everything here belongs to the ACCOUNT
 * (including Usage and Billing, which span every project you belong to, and so would read as a
 * lie inside the project-scoped sidebar).
 *
 * App.tsx owns the open state and renders this at the root: ProfileMenu closes its dropdown on
 * any mousedown, so a modal mounted inside it would dismiss itself on first click.
 */

export type AccountSection = 'profile' | 'preferences' | 'danger';

interface AccountSettingsModalProps {
  onClose: () => void;
  /** Which section to open on. */
  initialSection?: AccountSection;
}

const SECTIONS: { id: AccountSection; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'danger', label: 'Danger zone' },
];

const label: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: '#666',
  marginBottom: 4,
};

const input: React.CSSProperties = {
  width: '100%',
  fontSize: 12,
  padding: '5px 7px',
  border: '1px solid #000',
  background: '#fff',
  color: '#000',
  boxSizing: 'border-box',
};

const button: React.CSSProperties = {
  fontSize: 12,
  border: '1px solid #000',
  background: '#fff',
  color: '#000',
  cursor: 'pointer',
  padding: '4px 12px',
};

const primaryButton: React.CSSProperties = {
  ...button,
  fontWeight: 'bold',
  background: '#000',
  color: '#fff',
};

const dangerButton: React.CSSProperties = {
  ...button,
  fontWeight: 'bold',
  background: '#ef4444',
  color: '#fff',
  borderColor: '#000',
};

/** Attach the caller's Supabase JWT — the account API derives identity from it and nothing else. */
async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function AccountSettingsModal({ onClose, initialSection = 'profile' }: AccountSettingsModalProps) {
  const { user } = useUser();
  const [section, setSection] = useState<AccountSection>(initialSection);
  const sections = SECTIONS;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmSignOutAll, setConfirmSignOutAll] = useState(false);

  // A nested ConfirmModal owns Escape while it's up; don't close both at once.
  const modalBusy = confirmDelete || confirmSignOutAll;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !modalBusy) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, modalBusy]);

  const email = user?.email ?? '';
  const meta = (user?.user_metadata ?? {}) as { full_name?: string; name?: string; avatar_url?: string };

  return (
    <>
      <div
        onClick={() => { if (!modalBusy) onClose(); }}
        style={{
          position: 'fixed', inset: 0, zIndex: 9998,
          background: 'rgba(0,0,0,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{
            // Wider than a plain form dialog: Usage carries three tables and a chart.
            width: 760, maxWidth: '94vw', maxHeight: '85vh',
            background: '#fff', border: '1.5px solid #000', boxShadow: '4px 4px 0 #000',
            display: 'flex', flexDirection: 'column', fontSize: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderBottom: '1px solid #000', background: BRAND_ACCENT, color: '#fff' }}>
            <strong style={{ letterSpacing: 0.3 }}>Account settings</strong>
            <button
              onClick={onClose}
              style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}
            >
              ×
            </button>
          </div>

          <div style={{ display: 'flex', minHeight: 320, overflow: 'hidden' }}>
            {/* Left rail */}
            <div style={{ width: 150, flexShrink: 0, borderRight: '1px solid #000', padding: '8px 0' }}>
              {sections.map(s => {
                const active = s.id === section;
                return (
                  <button
                    key={s.id}
                    onClick={() => setSection(s.id)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      border: 'none', cursor: 'pointer',
                      fontSize: 12,
                      padding: '7px 10px',
                      background: active ? '#000' : 'none',
                      color: active ? '#fff' : '#000',
                      fontWeight: active ? 'bold' : 'normal',
                    }}
                    onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = '#f0f0f0'; }}
                    onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'none'; }}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>

            {/* Pane — owns the padding and the scroll for every section. */}
            <div style={{ flex: 1, minWidth: 0, padding: '14px 16px', overflowY: 'auto' }}>
              {section === 'profile' && <ProfileSection email={email} meta={meta} />}
              {section === 'preferences' && (
                <PreferencesSection onSignOutAll={() => setConfirmSignOutAll(true)} />
              )}
              {section === 'danger' && (
                <DangerSection email={email} onDelete={() => setConfirmDelete(true)} />
              )}
            </div>
          </div>
        </div>
      </div>

      {confirmSignOutAll && (
        <ConfirmModal
          title="Sign out everywhere"
          message="Sign out of every device and browser where this account is signed in, including this one?"
          confirmLabel="Sign out everywhere"
          destructive={false}
          onCancel={() => setConfirmSignOutAll(false)}
          onConfirm={async () => {
            const { error } = await supabase.auth.signOut({ scope: 'global' });
            if (error) throw new Error(error.message);
            // onAuthStateChange fires SIGNED_OUT; AuthGate swaps in LoginPage.
          }}
        />
      )}

      {confirmDelete && (
        <DeleteAccountConfirm email={email} onCancel={() => setConfirmDelete(false)} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function ProfileSection({ email, meta }: { email: string; meta: { full_name?: string; name?: string; avatar_url?: string } }) {
  const [fullName, setFullName] = useState(meta.full_name || meta.name || '');
  const [avatarUrl, setAvatarUrl] = useState(meta.avatar_url ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.auth.updateUser({
      data: { full_name: fullName.trim(), avatar_url: avatarUrl.trim() || undefined },
    });
    setBusy(false);
    setMsg(error ? { kind: 'err', text: error.message } : { kind: 'ok', text: 'Saved.' });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Avatar url={avatarUrl || undefined} label={fullName || email} size={40} />
        <div style={{ fontSize: 11, color: '#666' }}>Preview</div>
      </div>

      <div>
        <label style={label}>Display name</label>
        <input style={input} value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Your name" />
      </div>

      <div>
        <label style={label}>Avatar URL</label>
        <input style={input} value={avatarUrl} onChange={e => setAvatarUrl(e.target.value)} placeholder="https://…" />
      </div>

      <div>
        <label style={label}>Email</label>
        <input style={{ ...input, background: '#f5f5f5', color: '#666' }} value={email} readOnly />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button style={{ ...primaryButton, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={() => void save()}>
          {busy ? '…' : 'Save'}
        </button>
        {msg && (
          <span style={{ fontSize: 11, color: msg.kind === 'ok' ? '#16a34a' : '#ef4444' }}>{msg.text}</span>
        )}
      </div>
    </div>
  );
}

function PreferencesSection({ onSignOutAll }: { onSignOutAll: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ fontWeight: 'bold', marginBottom: 4 }}>Sessions</div>
        <div style={{ fontSize: 11, color: '#666', lineHeight: 1.5, marginBottom: 8 }}>
          Signs you out of every device and browser, including this one. Useful if you signed in
          somewhere you no longer control.
        </div>
        <button style={button} onClick={onSignOutAll}>Sign out of all devices</button>
      </div>
    </div>
  );
}

function DangerSection({ email, onDelete }: { email: string; onDelete: () => void }) {
  const [exporting, setExporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function exportData() {
    setExporting(true);
    setErr(null);
    try {
      const res = await fetch('/api/account/export', { headers: await authHeader() });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body as { error?: string })?.error ?? `export failed (${res.status})`);

      const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nff-account-export-${email || 'me'}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div style={{ fontWeight: 'bold', marginBottom: 4 }}>Export my data</div>
        <div style={{ fontSize: 11, color: '#666', lineHeight: 1.5, marginBottom: 8 }}>
          Downloads everything this account can read — projects, devices, crashes, firmware and
          agent history — as a single JSON file.
        </div>
        <button style={{ ...button, opacity: exporting ? 0.5 : 1 }} disabled={exporting} onClick={() => void exportData()}>
          {exporting ? 'Preparing…' : 'Download my data'}
        </button>
        {err && <div style={{ marginTop: 8, fontSize: 11, color: '#ef4444' }}>{err}</div>}
      </div>

      <div style={{ borderTop: '1px solid #000', paddingTop: 14 }}>
        <div style={{ fontWeight: 'bold', marginBottom: 4, color: '#ef4444' }}>Delete my account</div>
        <div style={{ fontSize: 11, color: '#666', lineHeight: 1.5, marginBottom: 8 }}>
          Permanently deletes your account, the projects you own, and all of their devices, firmware
          and history. This cannot be undone. If you own a project with other members, you'll be
          asked to hand it off first.
        </div>
        <button style={dangerButton} onClick={onDelete}>Delete my account…</button>
      </div>
    </div>
  );
}

/**
 * Two-step delete: type the account email to arm the button, then confirm. The typed email is a
 * local "are you sure" gate only — the server never accepts an identity from the client.
 */
function DeleteAccountConfirm({ email, onCancel }: { email: string; onCancel: () => void }) {
  const [typed, setTyped] = useState('');
  const armed = typed.trim().toLowerCase() === email.trim().toLowerCase() && email !== '';

  return (
    <ConfirmModal
      title="Delete my account"
      confirmLabel={armed ? 'Delete forever' : 'Type your email'}
      onCancel={onCancel}
      onConfirm={async () => {
        if (!armed) throw new Error('Type your email address to confirm.');

        const res = await fetch('/api/account/delete', {
          method: 'POST',
          headers: await authHeader(),
        });
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        // A 409 is the team-project / last-admin guard. Throwing keeps ConfirmModal open and
        // renders the server's message in red, which is exactly what we want the user to read.
        if (!res.ok) throw new Error(body?.error ?? `delete failed (${res.status})`);

        // The JWT now points at a user that no longer exists; forceSignOut drops it locally
        // (a server-side logout would 403) and clears the cached project id.
        await forceSignOut();
      }}
      message={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            This permanently deletes <strong>{email}</strong>, the projects you own, and all of their
            devices, firmware and history. It cannot be undone.
          </div>
          <div>
            <label style={label}>Type <strong>{email}</strong> to confirm</label>
            <input
              style={input}
              value={typed}
              autoFocus
              onChange={e => setTyped(e.target.value)}
              placeholder={email}
            />
          </div>
        </div>
      }
    />
  );
}
