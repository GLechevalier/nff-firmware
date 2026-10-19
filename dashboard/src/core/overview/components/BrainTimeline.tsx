// BrainTimeline — the company brain's main-branch history, a vertical list of
// commits (newest first). Deliberately NOT a lane graph like RepoTree: the
// admin view only ever looks at 'main', so there is nothing to lay out side by
// side — each entry expands to show which nodes it added/removed/changed.
//
// Every commit here already carries pre-clamped display-only node summaries
// (BrainCommit['diff'], written by api/_lib/brain.ts's handleBrainCommitsPush)
// — no join against the live brain_nodes table, so a since-changed/deleted
// node still renders correctly in old history.

import { useState } from 'react';
import { useBrainCommits, type BrainCommit, type BrainCommitDiffNode } from '../hooks/useBrainCommits';

function NodeChip({ node, tone }: { node: BrainCommitDiffNode; tone: 'added' | 'modified' }) {
  const color = tone === 'added' ? '#16a34a' : '#d97706';
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 truncate border px-1 py-0.5 text-[10px]"
      style={{ borderColor: color, color }}
      title={node.content}
    >
      {tone === 'added' ? '+' : '~'} {node.title}
    </span>
  );
}

function RemovedChip({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center gap-1 border border-red-700 px-1 py-0.5 text-[10px] text-red-700">
      <span style={{ textDecoration: 'line-through' }}>{id}</span>
    </span>
  );
}

function CommitRow({ commit, defaultOpen }: { commit: BrainCommit; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { diff } = commit;
  const isMerge = commit.parents.length > 1;
  const changeCount = diff.nodesAdded.length + diff.nodesModified.length + diff.nodesRemoved.length;

  return (
    <div className="border border-hairline">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-elevated"
      >
        <span className="w-3 shrink-0 text-faint">{open ? '▾' : '▸'}</span>
        {isMerge && <span className="shrink-0 text-[10px] text-muted">⑂ merge</span>}
        <span className="min-w-0 flex-1 truncate text-ink" title={commit.message}>
          {commit.message}
        </span>
        <span className="shrink-0 text-[10px] text-faint">
          +{diff.nodesAdded.length}/~{diff.nodesModified.length}/-{diff.nodesRemoved.length}
        </span>
        <span className="shrink-0 text-[10px] text-muted">{commit.author}</span>
        <span className="shrink-0 text-[10px] text-faint">{new Date(commit.ts).toLocaleString()}</span>
      </button>
      {open && changeCount > 0 && (
        <div className="flex flex-wrap gap-1 border-t border-hairline px-2 py-1.5">
          {diff.nodesAdded.map((n) => (
            <NodeChip key={n.id} node={n} tone="added" />
          ))}
          {diff.nodesModified.map((n) => (
            <NodeChip key={n.id} node={n} tone="modified" />
          ))}
          {diff.nodesRemoved.map((id) => (
            <RemovedChip key={id} id={id} />
          ))}
        </div>
      )}
    </div>
  );
}

export function BrainTimeline({ branch = 'main' }: { branch?: string }) {
  const { commits, error } = useBrainCommits(branch);

  if (error) {
    return <div className="p-2 text-xs text-red-700">Failed to load brain history: {error}</div>;
  }
  if (commits.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-faint">
        No commits on "{branch}" yet — the company brain fills in as employees push
        (<code>nff-brain push</code>, or automatically from the VS Code/Chrome extensions).
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 overflow-y-auto">
      {commits.map((c, i) => (
        <CommitRow key={c.id} commit={c} defaultOpen={i === 0} />
      ))}
    </div>
  );
}
