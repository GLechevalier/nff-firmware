import { useState } from 'react';

// A clipboard glyph (two overlapping sheets), sized to sit inline. Stroke uses
// currentColor so the button's `color` drives it — light on dark consoles, dark
// elsewhere.
function ClipboardIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }} aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
      style={{ display: 'block' }} aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

interface Props {
  // String, or a thunk for large/derived content computed lazily on click
  // (e.g. console scrollback, a joined RTC log).
  value: string | (() => string);
  title?: string;
  // 'text' keeps the original "copy" pill (used for project ids). 'icon' renders just
  // the clipboard glyph — used for the top-right copy affordance on log/output blocks.
  variant?: 'text' | 'icon';
  // Light glyph for placement over a dark (#000) background.
  dark?: boolean;
}

/**
 * Small inline copy-to-clipboard button. Shows a brief "copied ✓" state after a
 * successful write. Used for project ids (text variant) and for the top-right copy
 * affordance on every log/output block (icon variant, via CopyOverlay).
 */
export function CopyButton({ value, title = 'Copy', variant = 'text', dark = false }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy(e: React.MouseEvent) {
    e.stopPropagation();
    const text = typeof value === 'function' ? value() : value;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable (insecure context) — leave state unchanged
    }
  }

  if (variant === 'icon') {
    const fg = dark ? '#aaa' : '#555';
    return (
      <button
        onClick={copy}
        title={copied ? 'Copied' : title}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: dark ? '1px solid #444' : '1px solid #ccc',
          borderRadius: 4,
          background: dark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.85)',
          color: copied ? (dark ? '#22c55e' : '#15803d') : fg,
          cursor: 'pointer',
          padding: 3,
          lineHeight: 0,
        }}
      >
        {copied ? <CheckIcon /> : <ClipboardIcon />}
      </button>
    );
  }

  return (
    <button
      onClick={copy}
      title={title}
      style={{
        border: '1px solid #000',
        background: copied ? '#000' : '#fff',
        color: copied ? '#fff' : '#000',
        cursor: 'pointer',
        fontSize: 10,
        padding: '1px 6px',
        flexShrink: 0,
      }}
    >
      {copied ? 'copied ✓' : 'copy'}
    </button>
  );
}
