import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { BRAND_ACCENT } from '../../../lib/brand';

interface ToastProps {
  message: string;
  // 'error' (red) or 'info' (black). Defaults to error — the only caller so far is a
  // failure notice.
  variant?: 'error' | 'info';
  onDismiss: () => void;
  // Auto-dismiss after this many ms; 0 disables (stays until dismissed).
  autoDismissMs?: number;
}

// A fixed-position notification that portals to <body>, so it stays visible even when the
// component that raised it is on a now-hidden tab (the console keeps tabs mounted via
// display:none — a toast rendered in-tree would vanish with it). Bottom-right, stacked above
// modals (zIndex > ConfirmModal's 9999).
export function Toast({ message, variant = 'error', onDismiss, autoDismissMs = 8000 }: ToastProps) {
  useEffect(() => {
    if (!autoDismissMs) return;
    const t = setTimeout(onDismiss, autoDismissMs);
    return () => clearTimeout(t);
  }, [autoDismissMs, onDismiss]);

  const accent = variant === 'error' ? '#ef4444' : BRAND_ACCENT;

  return createPortal(
    <div
      role="alert"
      style={{
        position: 'fixed', right: 16, bottom: 16, zIndex: 10000,
        maxWidth: 360, background: '#fff', color: '#000',
        border: '1.5px solid #000', borderLeft: `4px solid ${accent}`,
        boxShadow: '4px 4px 0 #000', fontSize: 12,
        display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px',
      }}
    >
      <span style={{ flex: 1, lineHeight: 1.4 }}>{message}</span>
      <button
        onClick={onDismiss}
        title="Dismiss"
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 0, color: '#000', textDecoration: 'underline' }}
      >
        dismiss
      </button>
    </div>,
    document.body,
  );
}
