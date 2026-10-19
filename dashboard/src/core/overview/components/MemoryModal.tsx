import { useEffect } from 'react';
import { formatRelativeTime } from '../../lib/time';
import type { AdminBrainNode } from '../hooks/useBrainGraph';

// One memory of the admin worker's brain, read in full.
//
// This is the Memory Document panel that used to be the right half of the Brain
// tab, now a modal over the Overview graph — the graph is the map, this is the
// page. "See also" keeps you inside it: picking a related memory swaps the modal
// AND the graph selection behind it, so closing lands you where you read to.
//
// Same idiom as DecisionModal/TodoDetailModal: z-[60] over an ink/40 backdrop,
// Escape and backdrop-click close.

export function MemoryModal({
  node,
  nodes,
  onSelect,
  onClose,
}: {
  node: AdminBrainNode;
  nodes: AdminBrainNode[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const related = node.relatedIds
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is AdminBrainNode => !!n);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Memory document"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col border border-ink bg-paper font-mono shadow-hard"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-ink px-4 py-2">
          <span className="text-[11px] uppercase tracking-label text-ink">Memory Document</span>
          <button onClick={onClose} aria-label="Close" className="text-xs text-muted hover:text-ink">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          <div className="mb-2.5 text-[10px] tracking-wide text-muted">
            {node.category.toUpperCase()} &nbsp;·&nbsp; Updated {formatRelativeTime(node.lastUpdated)}
          </div>
          <div className="mb-3.5 border-b border-ink pb-3.5 text-lg font-bold leading-tight text-ink">
            {node.title}
          </div>
          <div className="text-xs leading-7 text-ink">
            {node.content.split('\n\n').map((para, i) => (
              <p key={i} className="mb-3.5">
                {para}
              </p>
            ))}
          </div>

          {related.length > 0 && (
            <div className="mt-5 border-t border-hairline pt-3.5">
              <div className="mb-2.5 text-[10px] uppercase tracking-label text-muted">See also</div>
              <div className="flex flex-col gap-1">
                {related.map((rel) => (
                  <button
                    key={rel.id}
                    onClick={() => onSelect(rel.id)}
                    className="w-fit text-left font-mono text-xs text-ink underline hover:no-underline"
                  >
                    {rel.title}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
