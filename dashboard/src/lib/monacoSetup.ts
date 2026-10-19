// Monaco, self-hosted. Imported ONLY by DiffView, which CodeTab lazy-loads — so the ~2-3 MB
// monaco chunk stays out of the initial bundle of every entry (main, demo, floor) and is fetched
// the first time someone opens a file the agent edited.
//
// Two things have to be said explicitly:
//
//  • `loader.config({ monaco })` — by default @monaco-editor/react pulls monaco off a jsdelivr CDN
//    at runtime. We ship it from the bundle instead: no third-party request, and the diff still
//    renders on a locked-down network.
//  • `MonacoEnvironment.getWorker` — monaco resolves its workers by URL unless told otherwise, which
//    breaks under Vite's hashed asset names. `?worker` hands us a constructor Vite has already
//    wired up. Only the base `editor.worker` is needed: .ino/.cpp/.py highlight via Monarch
//    grammars on the main thread. The json/ts workers exist for language services (diagnostics,
//    IntelliSense) that a read-only diff has no use for.

import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

// `MonacoEnvironment` is declared globally by monaco-editor's own types — don't redeclare it.
self.MonacoEnvironment = { getWorker: () => new editorWorker() };

loader.config({ monaco });

/**
 * Map a file path's extension to a MONACO language id. Deliberately separate from CodeHighlight's
 * langFromPath (which returns Prism ids): the two vocabularies disagree — Prism's `tsx`/`jsx`/`bash`
 * are Monaco's `typescript`/`javascript`/`shell`, and Monaco has no `text`, it wants `plaintext`.
 * Unknown → 'plaintext' (renders, no highlighting, never throws).
 */
export function monacoLangFromPath(path: string | null): string {
  const ext = (path ?? '').toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'ino': case 'cpp': case 'cc': case 'cxx': case 'c': case 'h': case 'hpp': case 'hxx':
      return 'cpp';
    case 'py': return 'python';
    case 'json': return 'json';
    case 'ts': case 'tsx': return 'typescript';
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript';
    case 'sh': case 'bash': case 'zsh': return 'shell';
    case 'md': case 'markdown': return 'markdown';
    case 'yml': case 'yaml': return 'yaml';
    case 'toml': return 'plaintext';   // monaco ships no toml grammar
    case 'ini': case 'cfg': case 'conf': return 'ini';
    case 'html': case 'htm': return 'html';
    case 'css': return 'css';
    case 'sql': return 'sql';
    case 'rs': return 'rust';
    case 'go': return 'go';
    default: return 'plaintext';
  }
}
