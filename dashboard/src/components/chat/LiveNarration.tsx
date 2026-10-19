// The LIVE agent-activity line ("Reading firmware source on device mock-…") — the step
// happening right now. Rendered as a left-aligned grey pill (like ThinkingIndicator) with a
// minimalist icon that morphs (a small mark cycling diamond ⇄ circle while slowly rotating)
// and a buffering "…" of three dots that fade in sequence. Past narration rows keep the plain
// static line in ChatPanel; only the tail row uses this. No animation library — the keyframes
// are injected once into the document head and reused. Honours prefers-reduced-motion.

const STYLE_ID = 'nff-narration-style';

function ensureStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
@keyframes nffBlobMorph {
  0%   { border-radius: 12%; transform: rotate(0deg); }
  50%  { border-radius: 50%; transform: rotate(180deg); }
  100% { border-radius: 12%; transform: rotate(360deg); }
}
@keyframes nffBuffer { 0%, 70%, 100% { opacity: 0.25; } 35% { opacity: 1; } }
.nff-blob { display: inline-block; animation: nffBlobMorph 2.2s ease-in-out infinite; }
.nff-buffer-dot { animation: nffBuffer 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .nff-blob { animation: none; border-radius: 50%; opacity: 0.7; }
  .nff-buffer-dot { animation: none; opacity: 0.6; }
}`;
  document.head.appendChild(el);
}

interface Props {
  // The narration body with the "⚙ " sentinel already stripped by the caller.
  text: string;
}

export function LiveNarration({ text }: Props) {
  ensureStyle();
  // The worker's ellipsize appends a "…" glyph; strip any trailing ellipsis so the animated
  // buffering dots replace it rather than doubling it ("mock-3879… • • •").
  const body = text.replace(/\s*(?:\.{3}|…)\s*$/, '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      <div
        style={{
          display: 'inline-flex', alignItems: 'flex-start', gap: 8,
          maxWidth: '78%',
          padding: '6px 10px',
          borderRadius: '10px 10px 10px 2px',
          background: '#f0f0f0', color: '#666',
          fontSize: 13, lineHeight: 1.5,
        }}
      >
        <span
          className="nff-blob"
          aria-hidden
          style={{ width: 9, height: 9, marginTop: 4, background: 'currentColor', flexShrink: 0 }}
        />
        <span>
          {body}
          <span aria-hidden style={{ whiteSpace: 'nowrap' }}>
            {' '}
            <span className="nff-buffer-dot">•</span>
            <span className="nff-buffer-dot" style={{ animationDelay: '0.18s' }}>•</span>
            <span className="nff-buffer-dot" style={{ animationDelay: '0.36s' }}>•</span>
          </span>
        </span>
      </div>
    </div>
  );
}
