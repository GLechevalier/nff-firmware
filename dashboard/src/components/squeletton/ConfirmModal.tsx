import type React from 'react';
import { useEffect, useState } from 'react';
import { BRAND_ACCENT } from '../../lib/brand';

interface ConfirmModalProps {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;     // default "Delete"
  cancelLabel?: string;      // default "Cancel"
  destructive?: boolean;     // default true → red confirm button
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

// Drop-in replacement for window.confirm() that matches the dashboard modal idiom
// (see DeviceModal.tsx). Holds its own busy/error state so the async action keeps the
// dialog open with feedback; the parent unmounts the modal on success.
export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  destructive = true,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  async function handleConfirm() {
    setBusy(true);
    setErr(null);
    try {
      await onConfirm();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  const confirmBg = destructive ? '#ef4444' : '#000';

  return (
    <div
      onClick={() => { if (!busy) onCancel(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 380, maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto',
          background: '#fff', border: '1.5px solid #000', boxShadow: '4px 4px 0 #000',
          display: 'flex', flexDirection: 'column', fontSize: 12,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderBottom: '1px solid #000', background: BRAND_ACCENT, color: '#fff' }}>
          <strong style={{ letterSpacing: 0.3 }}>{title}</strong>
          <button
            onClick={() => { if (!busy) onCancel(); }}
            style={{ background: 'none', border: 'none', color: '#fff', cursor: busy ? 'default' : 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: '12px 14px' }}>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>{message}</div>
          {err && <div style={{ marginTop: 8, fontSize: 11, color: '#ef4444' }}>{err}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button
              onClick={onCancel}
              disabled={busy}
              style={{ fontSize: 12, border: '1px solid #000', background: '#fff', color: '#000', cursor: busy ? 'default' : 'pointer', padding: '3px 12px', opacity: busy ? 0.5 : 1 }}
            >
              {cancelLabel}
            </button>
            <button
              onClick={() => void handleConfirm()}
              disabled={busy}
              style={{ fontSize: 12, fontWeight: 'bold', border: '1px solid #000', background: confirmBg, color: '#fff', cursor: busy ? 'default' : 'pointer', padding: '3px 12px', opacity: busy ? 0.5 : 1 }}
            >
              {busy ? '…' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
