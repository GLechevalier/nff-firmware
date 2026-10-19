// The live tool-call ticker — a small fixed-height box inside the chat transcript that
// shows what the agent is doing RIGHT NOW. Each narration row ("Reading crash abc123…")
// is one line; as new calls land the stack slides up and the oldest lines are clipped by
// the box, so the ticker never grows and old steps simply disappear.
//
// The push-up is free: a fixed-height `overflow: hidden` box whose column is
// `justify-content: flex-end` already pins the newest line to the bottom and pushes the
// rest off the top. The only animation is the one-row rise, keyed on the newest line's id
// so it replays on each arrival. Keyframes are injected once into the document head —
// the repo ships no animation library (same pattern as LiveNarration.tsx).

const STYLE_ID = 'nff-tool-ticker-style';

// Visible rows. One extra is rendered above them so the outgoing line is mid-slide
// rather than popping out of existence.
const ROWS = 3;
const ROW_H = 20;

function ensureStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
@keyframes nffTickerRise {
  from { transform: translateY(${ROW_H}px); }
  to   { transform: translateY(0); }
}
.nff-ticker-rise { animation: nffTickerRise 260ms ease-out; }
@media (prefers-reduced-motion: reduce) {
  .nff-ticker-rise { animation: none; }
}`;
  document.head.appendChild(el);
}

interface Props {
  // Oldest first; the ticker shows the tail. Ids come from the narration rows so a
  // re-render with the same tail does not replay the slide.
  lines: { id: string; text: string }[];
}

export function ToolTicker({ lines }: Props) {
  ensureStyle();
  if (lines.length === 0) return null;

  // ROWS visible + 1 sliding out of view.
  const shown = lines.slice(-(ROWS + 1));
  const newestId = shown[shown.length - 1].id;

  return (
    <div
      style={{
        maxWidth: '78%',
        height: ROWS * ROW_H,
        overflow: 'hidden',
        padding: '4px 10px',
        boxSizing: 'content-box',
        borderRadius: '10px 10px 10px 2px',
        background: '#f0f0f0',
        color: '#666',
        fontSize: 12,
      }}
      aria-live="polite"
      aria-label="Agent activity"
    >
      {/* Remounted on each new line (key) so the rise animation replays. */}
      <div
        key={newestId}
        className="nff-ticker-rise"
        style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', minHeight: '100%' }}
      >
        {shown.map((l, i) => (
          <div
            key={l.id}
            style={{
              height: ROW_H,
              lineHeight: `${ROW_H}px`,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              // Fade the older lines so the stack reads as receding, not as a list.
              opacity: i === shown.length - 1 ? 1 : Math.max(0.3, 0.75 - 0.2 * (shown.length - 2 - i)),
            }}
          >
            {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
