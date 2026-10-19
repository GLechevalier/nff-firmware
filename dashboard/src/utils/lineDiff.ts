// A minimal unified line diff — enough to render the demo PR's one-line firmware fix.
//
// The dashboard had no diff renderer anywhere, and pulling in a diff library for a single
// ~90-line sketch isn't worth the bytes. This is a plain LCS over lines (O(n·m) DP; the inputs
// are one Arduino sketch, so n·m is a few thousand cells), then a pass that keeps a few lines of
// context around each change and folds the long unchanged stretches into `@@` hunk markers.

export type DiffKind = 'ctx' | 'add' | 'del' | 'hunk';

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the base (absent for added lines and hunk markers). */
  baseNo?: number;
  /** 1-based line number in the head (absent for deleted lines and hunk markers). */
  headNo?: number;
}

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

/** Lines of context kept either side of a change; longer unchanged runs collapse to a `@@` marker. */
const CONTEXT = 3;

function splitLines(s: string): string[] {
  // A trailing newline would otherwise yield a phantom empty last line on both sides.
  return s.replace(/\n$/, '').split('\n');
}

/** Longest common subsequence of two line arrays, as the raw DP table's backtrace. */
function lcsOps(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i], baseNo: i + 1, headNo: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i], baseNo: i + 1 });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j], headNo: j + 1 });
      j++;
    }
  }
  for (; i < n; i++) out.push({ kind: 'del', text: a[i], baseNo: i + 1 });
  for (; j < m; j++) out.push({ kind: 'add', text: b[j], headNo: j + 1 });
  return out;
}

/** Drop unchanged stretches further than CONTEXT from any change, replacing each with a `@@` marker. */
function collapse(ops: DiffLine[]): DiffLine[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.kind === 'ctx') return;
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(ops.length - 1, idx + CONTEXT); k++) {
      keep[k] = true;
    }
  });

  const out: DiffLine[] = [];
  let skipping = false;
  ops.forEach((op, idx) => {
    if (keep[idx]) {
      skipping = false;
      out.push(op);
    } else if (!skipping) {
      skipping = true;
      out.push({ kind: 'hunk', text: '@@' });
    }
  });
  // An all-context diff (identical inputs) collapses to a lone marker — say nothing instead.
  return out.every(l => l.kind === 'hunk') ? [] : out;
}

/**
 * Unified diff of `base` → `head`, collapsed to hunks. `added`/`removed` count changed lines and
 * drive the `+N −M` summary; they are computed before collapsing so they always reflect the whole
 * file, not just the rendered hunks.
 */
export function lineDiff(base: string, head: string): LineDiff {
  const ops = lcsOps(splitLines(base), splitLines(head));
  return {
    lines: collapse(ops),
    added: ops.filter(o => o.kind === 'add').length,
    removed: ops.filter(o => o.kind === 'del').length,
  };
}
