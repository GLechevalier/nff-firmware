import { useEffect, useState } from 'react';
import { askChat, isQueryModeOn, QUERY_MODE_EVENT, setQueryMode } from '../lib/adminChat';

export function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  const [queryMode, setLocalQueryMode] = useState(isQueryModeOn());

  useEffect(() => {
    function onMode(e: Event) {
      setLocalQueryMode((e as CustomEvent<boolean>).detail);
    }
    window.addEventListener(QUERY_MODE_EVENT, onMode);
    return () => window.removeEventListener(QUERY_MODE_EVENT, onMode);
  }, []);

  function pick(e: { stopPropagation: () => void }) {
    e.stopPropagation();
    askChat(`How can I improve "${label}"? It's currently ${value}${sub ? ` (${sub})` : ''}.`);
    setQueryMode(false); // one pick per arm, like an inspect-element tool
  }

  return (
    <div className="relative border border-ink bg-paper p-4 shadow-card">
      <div className="text-xs text-faint">{label}</div>
      <div className="mt-1 text-2xl text-ink">{value}</div>
      {sub && <div className="mt-1 text-xs text-faint">{sub}</div>}
      {queryMode && (
        // Covers the whole tile, not just a corner — this IS "the box become
        // clickable" the Query mode promises. A <div>, not <button>: some
        // callers wrap StatCard in their own <button>, and nested <button>s
        // are invalid HTML that browsers mis-render.
        <div
          role="button"
          tabIndex={0}
          title={`Ask how to improve "${label}"`}
          onClick={pick}
          onKeyDown={(e) => e.key === 'Enter' && pick(e)}
          className="absolute inset-0 cursor-pointer bg-ink/5 ring-2 ring-inset ring-ink hover:bg-ink/10"
        />
      )}
    </div>
  );
}
