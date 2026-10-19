import { useEffect, useState } from 'react';

const WORDS = [
  'Pondering…',
  'Percolating…',
  'Rummaging…',
  'Cross-referencing…',
  'Connecting the dots…',
  'Digging through the data…',
  'Untangling…',
  'Mulling it over…',
  'Fetching thoughts…',
];

const TICK_MS = 1000;
const WORD_S = 2;

/**
 * Claude-Code-style wait line: a rotating verb (every WORD_S) + a live elapsed-seconds
 * counter (every second). Mount while busy, unmount on reply. `since` (epoch ms) is when
 * the wait really started — pass it so a remount or reload keeps counting from the
 * original send instead of restarting at 0. `label` pins the verb (e.g. "Retrieving memory…"
 * while the fast path recalls the brain) instead of rotating through WORDS.
 */
export function ThinkingIndicator({ className = 'text-xs text-faint', since, label }: { className?: string; since?: number; label?: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = since ?? Date.now();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [since]);

  const word = label ?? WORDS[Math.floor(elapsed / WORD_S) % WORDS.length];
  return (
    <p className={className}>
      <span className="inline-block animate-spin">✢</span> {word} ({elapsed}s)
    </p>
  );
}
