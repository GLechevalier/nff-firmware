import { useEffect, useRef, useState } from 'react';
import type { Choice } from '../../utils/choices';

// A keyboard-navigable choice list (Claude Code "arrows" style). Up/Down move the highlight,
// Enter/Space picks. Picking sends the chosen label back as the user's reply (via onPick).
// Only the latest agent message's selector is interactive; older ones render disabled/static.
//
// When onOther is provided, a trailing "Other…" chip is appended: picking it does NOT send
// a reply — it hands focus to the chat composer (via onOther) so the user can type a custom
// answer. The selector stays interactive after that, so they can still change their mind and
// pick a real option until their typed message lands.

interface Props {
  choices: Choice[];
  onPick: (label: string) => void;
  onOther?: () => void;
  disabled?: boolean;
}

export function ChoiceSelector({ choices, onPick, onOther, disabled }: Props) {
  const [highlight, setHighlight] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // The "Other…" chip occupies index === choices.length when present.
  const itemCount = choices.length + (onOther ? 1 : 0);

  // Auto-focus so arrow keys work without a click. Only the active (non-disabled) selector grabs focus.
  useEffect(() => {
    if (!disabled && !picked) ref.current?.focus();
  }, [disabled, picked]);

  function pick(i: number) {
    if (disabled || picked) return;
    if (onOther && i === choices.length) {
      onOther();
      return;
    }
    const choice = choices[i];
    if (!choice) return;
    setPicked(choice.label);
    onPick(choice.label);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled || picked) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(h => Math.min(itemCount - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => Math.max(0, h - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(highlight);
    }
  }

  const interactive = !disabled && !picked;

  // Render entries: real choices plus the synthetic Other… chip.
  const items: Choice[] = onOther
    ? [...choices, { label: 'Other…', detail: 'Type your own answer below' }]
    : choices;

  return (
    <div
      ref={ref}
      role="listbox"
      tabIndex={interactive ? 0 : -1}
      onKeyDown={onKeyDown}
      aria-disabled={!interactive}
      style={{
        display: 'flex', flexDirection: 'column', gap: 4, margin: '4px 0 2px',
        outline: 'none',
      }}
    >
      {items.map((c, i) => {
        const isPicked = picked === c.label;
        const active = interactive && i === highlight;
        return (
          <button
            key={i}
            role="option"
            aria-selected={active}
            disabled={!interactive}
            onMouseEnter={() => interactive && setHighlight(i)}
            onClick={() => pick(i)}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 7, width: '100%', textAlign: 'left',
              border: '1px solid #000', cursor: interactive ? 'pointer' : 'default',
              background: active ? '#000' : isPicked ? '#000' : '#fff',
              color: active || isPicked ? '#fff' : '#000',
              opacity: !interactive && !isPicked ? 0.65 : 1,
              fontSize: 12, padding: '5px 8px', lineHeight: 1.4,
            }}
          >
            <span style={{ flexShrink: 0, width: 10 }}>{active || isPicked ? '›' : ' '}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 700 }}>{c.label}</span>
              {isPicked && ' ✓'}
              {c.detail && (
                <span style={{ display: 'block', color: active || isPicked ? '#ccc' : '#555', fontWeight: 400, marginTop: 1 }}>
                  {c.detail}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
