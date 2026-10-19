import { useEffect, useRef, useState } from 'react';
import { BRAND_ACCENT } from '../../lib/brand';

interface PromptModalProps {
  title: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;     // default "Save"
  cancelLabel?: string;      // default "Cancel"
  onSubmit: (value: string) => void | Promise<void>;
  onCancel: () => void;
}

// Drop-in replacement for window.prompt() that matches the dashboard modal idiom
// (see DeviceModal.tsx). The confirm button is disabled while the input is empty or
// unchanged, mirroring the trim/unchanged guard the native handlers used to do.
export function PromptModal({
  title,
  initialValue = '',
  placeholder,
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  onSubmit,
  onCancel,
}: PromptModalProps) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  const trimmed = value.trim();
  const canSubmit = !!trimmed && trimmed !== initialValue.trim() && !busy;

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

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
          <input
            ref={inputRef}
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void handleSubmit(); }}
            placeholder={placeholder}
            disabled={busy}
            style={{ width: '100%', fontSize: 12, padding: '4px 6px', border: '1px solid #000', boxSizing: 'border-box' }}
          />
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
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              style={{ fontSize: 12, fontWeight: 'bold', border: '1px solid #000', background: canSubmit ? '#000' : '#ccc', color: '#fff', cursor: canSubmit ? 'pointer' : 'default', padding: '3px 12px' }}
            >
              {busy ? '…' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
