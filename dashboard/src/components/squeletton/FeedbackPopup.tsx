import { useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { BRAND_ACCENT } from '../../lib/brand';
import { useCurrentProject } from '../../context/CurrentProjectContext';

interface FeedbackPopupProps {
  onClose: () => void;
}

type Category = 'bug' | 'feature' | 'other';

export function FeedbackPopup({ onClose }: FeedbackPopupProps) {
  const { currentProjectId } = useCurrentProject();
  const [text, setText]         = useState('');
  const [category, setCategory] = useState<Category>('other');
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function submit() {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    const { error } = await supabase
      .from('feedback')
      .insert({ id: crypto.randomUUID(), category, message: text.trim(), project_id: currentProjectId });
    setSending(false);
    if (error) {
      setError(error.message);
      return;
    }
    setSubmitted(true);
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 320,
        background: '#fff',
        border: '1.5px solid #000',
        boxShadow: '4px 4px 0 #000',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        fontSize: 12,
      }}
      onClick={e => e.stopPropagation()}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderBottom: '1px solid #000', background: BRAND_ACCENT, color: '#fff' }}>
        <span style={{ fontWeight: 'bold', letterSpacing: 0.3 }}>🖌 Feedback</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>×</button>
      </div>

      {submitted ? (
        <div style={{ padding: '28px 16px', textAlign: 'center', color: '#22c55e', fontSize: 13 }}>
          ✓ Thanks for your feedback!
        </div>
      ) : (
        <div style={{ padding: '10px' }}>
          {/* Category pills */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {(['bug', 'feature', 'other'] as Category[]).map(c => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                style={{
                  flex: 1,
                  border: '1px solid #000',
                  background: category === c ? '#000' : '#fff',
                  color: category === c ? '#fff' : '#000',
                  cursor: 'pointer',
                  padding: '3px 0',
                  fontSize: 11,
                  textTransform: 'capitalize',
                }}
              >
                {c}
              </button>
            ))}
          </div>

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            autoFocus
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
            placeholder="Tell us what you think…"
            rows={5}
            style={{
              width: '100%',
              resize: 'vertical',
              border: '1px solid #ccc',
              padding: '6px',
              fontSize: 12,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />

          {/* Error */}
          {error && (
            <div style={{ marginTop: 6, color: '#ef4444', fontSize: 11 }}>
              ✕ Couldn’t send: {error}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
            <button
              onClick={onClose}
              style={{ border: '1px solid #ccc', background: 'none', cursor: 'pointer', padding: '3px 10px', fontSize: 12 }}
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!text.trim() || sending}
              style={{
                border: '1px solid #000',
                background: text.trim() && !sending ? '#000' : '#eee',
                color: text.trim() && !sending ? '#fff' : '#aaa',
                cursor: text.trim() && !sending ? 'pointer' : 'default',
                padding: '3px 10px',
                fontSize: 12,
              }}
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
