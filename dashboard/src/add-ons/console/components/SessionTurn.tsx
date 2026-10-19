import { useEffect, useState } from 'react';
import { MessagePart } from './MessagePart';
import type { Turn } from '../types';

// One turn — opencode's session-turn.tsx, trimmed to a job log: a time caption,
// then the tool/file/error parts, then the progress timer while a job still runs.

/** Seconds since `since`, ticking once a second. Only mounted on a live turn. */
function useElapsed(since: Date): number {
  const [n, setN] = useState(() => Math.floor((Date.now() - since.getTime()) / 1000));
  useEffect(() => {
    const id = setInterval(() => setN(Math.floor((Date.now() - since.getTime()) / 1000)), 1000);
    return () => clearInterval(id);
  }, [since]);
  return n;
}

/**
 * `12s`, `3m 12s`, or nothing at all past an hour — a turn that has been "working"
 * for longer than that is a thread reloaded around a dead run, and a five-digit
 * second count is noise. ConsoleTab's timeout notice covers that case in words.
 */
function formatElapsed(s: number): string | null {
  if (s < 0 || s >= 3600) return null;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function Progress({ since }: { since: Date }) {
  const elapsed = formatElapsed(useElapsed(since));
  return (
    <div data-slot="session-turn-thinking">
      <span data-component="spinner" />
      <span>Working</span>
      {elapsed && <span data-slot="session-turn-thinking-elapsed">{elapsed}</span>}
    </div>
  );
}

interface Props {
  turn: Turn;
  /** True for the newest turn — only its choices block stays answerable. */
  latest?: boolean;
  onChoose?: (label: string) => void;
}

export function SessionTurn({ turn, latest, onChoose }: Props) {
  return (
    <div data-component="session-turn">
      <div data-slot="session-turn-message-container">
        {/* One muted caption per request — the time and a slice of the prompt so
            jobs stay grouped by what triggered them. Never a chat bubble: the
            conversation itself lives in the chat half, this pane is the tool log. */}
        <div data-component="status-part" data-variant="schedule">
          <span>
            {turn.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {turn.prompt && ` · ${turn.prompt.split('\n')[0].slice(0, 60)}`}
          </span>
        </div>

        <div data-slot="session-turn-assistant-content">
          {turn.parts.map((part) => (
            <MessagePart key={part.id} part={part} interactive={latest} onChoose={onChoose} />
          ))}
          {turn.busy && <Progress since={turn.at} />}
        </div>
      </div>
    </div>
  );
}
