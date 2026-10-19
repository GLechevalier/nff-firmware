import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useUser } from '../../hooks/useUser';
import { BRAND_ACCENT } from '../../lib/brand';

// User will paste the real values; clearly-marked placeholders until then.
const DOCS_URL    = '__TODO_PASTE_DOCS_URL__';
const LOGIN_URL   = '__TODO_PASTE_LANDING_LOGIN_URL__';

interface ProfileMenuProps {
  /** Reuses the existing FeedbackPopup wiring from App.tsx. */
  onFeedback: () => void;
  /** Opens AccountSettingsModal, which App.tsx owns and renders at the root. */
  onOpenAccount: () => void;
}

const MENU_WIDTH = 220;

const triggerBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  border: '1px solid #000',
  background: '#fff',
  color: '#000',
  cursor: 'pointer',
  fontSize: 11,
  padding: 4,
  width: '100%',
  textAlign: 'left',
  marginTop: 6,
};

const itemBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  fontSize: 12,
  color: '#000',
  padding: '7px 10px',
  textAlign: 'left',
};

export function Avatar({ url, label, size = 22 }: { url?: string; label: string; size?: number }) {
  const initial = label.trim().charAt(0).toUpperCase() || '?';
  const shared: React.CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    borderRadius: '50%',
    border: '1px solid #000',
    objectFit: 'cover',
  };
  if (url) return <img src={url} alt="" style={shared} />;
  return (
    <span
      style={{
        ...shared,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: BRAND_ACCENT,
        color: '#fff',
        fontSize: size * 0.5,
        fontWeight: 'bold',
      }}
    >
      {initial}
    </span>
  );
}

export function ProfileMenu({ onFeedback, onOpenAccount }: ProfileMenuProps) {
  const { user, signOut } = useUser();
  const [open, setOpen]   = useState(false);
  const triggerRef        = useRef<HTMLButtonElement>(null);
  const menuRef           = useRef<HTMLDivElement>(null);

  const email     = user?.email ?? '';
  const meta      = (user?.user_metadata ?? {}) as { full_name?: string; name?: string; avatar_url?: string };
  const name      = meta.full_name || meta.name || email || 'Not signed in';
  const avatarUrl = meta.avatar_url;

  // Close on outside-click and Escape, mirroring App.tsx's dismissal patterns.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Anchor the dropdown above the trigger (it sits at the very bottom of the sidebar).
  const rect = open ? triggerRef.current?.getBoundingClientRect() : undefined;
  const GAP  = 6;
  const menuStyle: React.CSSProperties | undefined = rect
    ? {
        position: 'fixed',
        left: Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8),
        bottom: window.innerHeight - rect.top + GAP,
        width: MENU_WIDTH,
        background: '#fff',
        border: '1.5px solid #000',
        boxShadow: '4px 4px 0 #000',
        zIndex: 9999,
        fontSize: 12,
      }
    : undefined;

  function hover(e: React.MouseEvent, on: boolean) {
    (e.currentTarget as HTMLElement).style.background = on ? '#f0f0f0' : 'none';
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        title="Account"
        style={{ ...triggerBase, background: open ? '#f0f0f0' : '#fff' }}
      >
        <Avatar url={avatarUrl} label={name} />
        {/* Avatar only in the collapsed desktop rail (32px); name + caret on hover / phone. */}
        <span className="md:hidden md:group-hover/rail:block" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <span className="md:hidden md:group-hover/rail:inline" style={{ fontSize: 10, opacity: 0.6 }}>▴</span>
      </button>

      {open && menuStyle && (
        <div ref={menuRef} style={menuStyle} onClick={e => e.stopPropagation()}>
          {user ? (
            <>
              {/* Header: gear on the left, name (top) + email (below) to its right */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px', borderBottom: '1px solid #000' }}>
                <button
                  onClick={() => { onOpenAccount(); setOpen(false); }}
                  title="Account settings"
                  style={{ ...itemBase, width: 'auto', padding: 4, fontSize: 15, flexShrink: 0 }}
                  onMouseEnter={e => hover(e, true)}
                  onMouseLeave={e => hover(e, false)}
                >
                  ⚙
                </button>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                  <div style={{ color: '#666', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</div>
                </div>
              </div>

              <button style={itemBase} onMouseEnter={e => hover(e, true)} onMouseLeave={e => hover(e, false)}
                onClick={() => { setOpen(false); onFeedback(); }}>
                <span style={{ fontSize: 13 }}>🖌</span> Feedback
              </button>
              <button style={itemBase} onMouseEnter={e => hover(e, true)} onMouseLeave={e => hover(e, false)}
                onClick={() => { window.open(DOCS_URL, '_blank', 'noopener'); setOpen(false); }}>
                <span style={{ fontSize: 13 }}>▤</span> Docs
              </button>

              <div style={{ borderTop: '1px solid #000' }}>
                <button style={itemBase} onMouseEnter={e => hover(e, true)} onMouseLeave={e => hover(e, false)}
                  onClick={async () => { setOpen(false); await signOut(); }}>
                  <span style={{ fontSize: 13 }}>⏻</span> Log out
                </button>
              </div>

            </>
          ) : (
            <>
              <div style={{ padding: '10px', borderBottom: '1px solid #000', color: '#666' }}>Not signed in</div>
              <button style={itemBase} onMouseEnter={e => hover(e, true)} onMouseLeave={e => hover(e, false)}
                onClick={() => { window.open(DOCS_URL, '_blank', 'noopener'); setOpen(false); }}>
                <span style={{ fontSize: 13 }}>▤</span> Docs
              </button>
              <button style={{ ...itemBase, borderTop: '1px solid #000' }} onMouseEnter={e => hover(e, true)} onMouseLeave={e => hover(e, false)}
                onClick={() => { window.location.href = LOGIN_URL; }}>
                <span style={{ fontSize: 13 }}>→</span> Sign in
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
