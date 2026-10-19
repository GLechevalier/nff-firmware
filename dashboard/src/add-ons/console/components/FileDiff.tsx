import { useMemo, useState } from 'react';
import { lineDiff } from '../../../utils/lineDiff';
import type { Part } from '../types';

// A drafted file, ported from opencode's session-turn diff rows.
//
// The diff itself is src/utils/lineDiff.ts — the LCS + hunk collapser the demo PR
// already shipped. No diff library, and no second implementation.

type FilePart = Extract<Part, { kind: 'file' }>;

/**
 * `src/core/lib/api.ts` → directory `src/core/lib`, filename `/api.ts`.
 *
 * The separator rides with the FILENAME on purpose: the directory span is
 * `direction: rtl` so it ellipsizes from the left (upstream's trick for long
 * paths), and a trailing neutral `/` on an rtl run gets reordered to the front —
 * which rendered `/nff-ota/srcdeploy.ts`.
 */
function splitPath(path: string): [string, string] {
  const i = path.lastIndexOf('/');
  return i === -1 ? ['', path] : [path.slice(0, i), path.slice(i)];
}

export function FileDiff({ part }: { part: FilePart }) {
  const [open, setOpen] = useState(false);
  const diff = useMemo(() => lineDiff(part.before ?? '', part.after), [part.before, part.after]);
  const [dir, name] = splitPath(part.path);

  return (
    <div data-component="file-part">
      <button
        type="button"
        data-slot="session-turn-diff-trigger"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span data-slot="session-turn-diff-path">
          <span data-slot="session-turn-diff-directory">{dir}</span>
          <span data-slot="session-turn-diff-filename">{name}</span>
        </span>
        <span data-slot="session-turn-diff-meta">
          {diff.added > 0 && <span data-slot="diff-added">+{diff.added}</span>}
          {diff.removed > 0 && <span data-slot="diff-removed">−{diff.removed}</span>}
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        </span>
      </button>

      {open && (
        <div data-slot="session-turn-diff-view">
          {diff.lines.length === 0 ? (
            <div data-slot="diff-line" data-kind="ctx">
              <span />
              <span>{part.before === null ? 'New file.' : 'No changes.'}</span>
            </div>
          ) : (
            diff.lines.map((l, i) => (
              <div key={i} data-slot="diff-line" data-kind={l.kind}>
                <span>{l.kind === 'add' ? l.headNo : l.kind === 'del' ? l.baseNo : l.kind === 'hunk' ? '' : l.headNo}</span>
                <span>
                  {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : l.kind === 'hunk' ? '' : ' '}
                  {l.text}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
