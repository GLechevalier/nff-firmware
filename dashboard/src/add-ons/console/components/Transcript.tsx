import { useEffect, useRef } from 'react';
import { SessionTurn } from './SessionTurn';
import type { Turn } from '../types';
import '../styles/tokens.css';
import '../styles/console.css';

// The console's one public export: a scrolling list of turns, wrapped in the
// `.oc-console` scope that carries opencode's dark palette. Both the device agent
// (ConsoleTab) and the admin data chat (ChatTab) render through this — the only
// difference between them is which adapter built the turns.

interface Props {
  turns: Turn[];
  /** Rendered above the scroller (session picker, actions). */
  header?: React.ReactNode;
  /** Rendered below it — the Composer, or nothing for a read-only view. */
  footer?: React.ReactNode;
  emptyState?: React.ReactNode;
  onChoose?: (label: string) => void;
  onLoadOlder?: () => void;
  hasMore?: boolean;
  loadingOlder?: boolean;
}

export function Transcript({ turns, header, footer, emptyState, onChoose, onLoadOlder, hasMore, loadingOlder }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<string | null>(null);

  useEffect(() => {
    // Auto-scroll only when the tail actually changes — never on a "load older"
    // prepend, which would yank the view away from what the user is reading.
    // The marker folds in the last turn's part count and busy flag so streaming
    // text and a settling tool row keep the view pinned to the bottom.
    const last = turns[turns.length - 1];
    const marker = last ? `${last.id}:${last.parts.length}:${last.busy}:${turns.length}` : null;
    if (marker === markerRef.current) return;
    markerRef.current = marker;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // Defer a frame so a just-appended pre-wrap row is laid out before we read
    // scrollHeight, and scroll THIS element rather than scrollIntoView — the
    // latter also scrolls every scrollable ancestor.
    const raf = requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [turns]);

  return (
    <div className="oc-console">
      {header}
      <div ref={scrollerRef} data-slot="session-turn-content">
        <div data-slot="session-turn-list">
          {hasMore && (
            <button
              type="button"
              data-slot="question-option"
              disabled={loadingOlder}
              onClick={onLoadOlder}
              style={{ alignItems: 'center' }}
            >
              <span data-slot="option-label">{loadingOlder ? 'Loading…' : '↑ Load older'}</span>
            </button>
          )}
          {turns.length === 0 && emptyState}
          {turns.map((turn, i) => (
            <SessionTurn key={turn.id} turn={turn} latest={i === turns.length - 1} onChoose={onChoose} />
          ))}
        </div>
      </div>
      {footer}
    </div>
  );
}
