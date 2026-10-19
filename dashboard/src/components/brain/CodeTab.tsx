import type React from 'react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { BRAND_ACCENT } from '../../lib/brand';
import { useCodeStream } from '../../hooks/useCodeStream';
import { useGithubConnections } from '../../add-ons/github/hooks/useGithubConnections';
import { useRepoTree, fetchRepoFile, invalidateRepoTree } from '../../hooks/useRepoTree';
import { useCurrentProject } from '../../context/CurrentProjectContext';
import { CommitGraph } from './CommitGraph';
import { FlashCodeModal } from './FlashCodeModal';
import { CopyButton } from '../squeletton/CopyButton';
import { CodeHighlight, langFromPath } from '../squeletton/CodeHighlight';
import { Markdown } from '../squeletton/Markdown';
import { lineDiff } from '../../utils/lineDiff';
import { adoptDemoFiles } from '../../data/babynffCodeStream';
import { BABYNFF_REPO } from '../../data/babynffRepo';
import type { CodeFile, CodeStreamStatus } from '../../types/code';

// The "Code" tab: a full code browser for the project's connected repo(s). The whole repo
// file tree + every file's contents are shown immediately (driven off useGithubConnections,
// not off agent runs), so you can read the deployed firmware any time. Files the agent has
// edited (across all code-runs for the repo) are flagged ● edited and open to the drafted
// version. The right panel is the live git graph (branches + deploy spine). Repo tree/content
// come through the server-side proxy to nff-github (useRepoTree / fetchRepoFile); the live agent
// stream (used to follow the file being written) comes from useCodeStream.

// A merged view of one agent code-run (live session or history row).
interface CodeView {
  id: string;
  repoFullName: string | null;
  status: CodeStreamStatus;
  files: CodeFile[];
  prNumber: number | null;
  prUrl: string | null;
  reasoning: string | null;   // null = replayed from history (reasoning is never stored)
  live: boolean;
  when: Date;
}

const EDITED_COLOR = '#b45309';

// Monaco is ~2-3 MB. Lazy so it is fetched only when someone opens a file the agent edited —
// never on the demo/floor entries, which have no agent.
const DiffView = lazy(() => import('./DiffView'));

const panelHeader: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid #000',
  fontSize: 12,
  fontWeight: 'bold',
  flexShrink: 0,
};

const codePre: React.CSSProperties = {
  margin: 0,
  padding: 8,
  fontSize: 11,
  lineHeight: 1.45,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  background: '#fff',
  color: '#000',
};

// ─── File tree (the whole repo, with the agent's edits highlighted) ───────────
interface TreeFolder { type: 'folder'; name: string; children: TreeEntry[] }
interface TreeFile { type: 'file'; name: string; path: string; edited: boolean }
type TreeEntry = TreeFolder | TreeFile;

function buildTree(paths: string[], edited: Set<string>): TreeEntry[] {
  const root: TreeFolder = { type: 'folder', name: '', children: [] };
  for (const path of paths) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let cur = root;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        if (!cur.children.some(c => c.type === 'file' && c.name === part)) {
          cur.children.push({ type: 'file', name: part, path, edited: edited.has(path) });
        }
        return;
      }
      let next = cur.children.find(c => c.type === 'folder' && c.name === part) as TreeFolder | undefined;
      if (!next) { next = { type: 'folder', name: part, children: [] }; cur.children.push(next); }
      cur = next;
    });
  }
  const sortRec = (n: TreeFolder) => {
    n.children.sort((a, b) =>
      a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name),
    );
    n.children.forEach(c => c.type === 'folder' && sortRec(c));
  };
  sortRec(root);
  return root.children;
}

function FileTree({
  entries, depth, selectedPath, onSelect,
}: { entries: TreeEntry[]; depth: number; selectedPath: string | null; onSelect: (p: string) => void }) {
  return (
    <>
      {entries.map(entry => {
        const pad = 8 + depth * 14;
        if (entry.type === 'folder') {
          return (
            <div key={`d:${depth}:${entry.name}`}>
              <div style={{ padding: '3px 8px', paddingLeft: pad, fontSize: 11, fontWeight: 'bold', color: '#555' }}>
                <span style={{ opacity: 0.6 }}>▾</span> {entry.name}/
              </div>
              <FileTree entries={entry.children} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />
            </div>
          );
        }
        const isSel = entry.path === selectedPath;
        return (
          <button
            key={`f:${entry.path}`}
            onClick={() => onSelect(entry.path)}
            title={entry.path}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
              cursor: 'pointer', border: 'none', borderBottom: '1px solid #f0f0f0',
              background: isSel ? '#000' : 'none', color: isSel ? '#fff' : '#000',
              padding: '3px 8px', paddingLeft: pad, fontSize: 11,
              fontWeight: entry.edited ? 'bold' : 'normal',
            }}
          >
            <span style={{ opacity: 0.55, flexShrink: 0 }}>›</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.name}</span>
            {entry.edited && (
              <span style={{ color: isSel ? '#fff' : EDITED_COLOR, flexShrink: 0, fontSize: 10, whiteSpace: 'nowrap' }}>
                ● edited
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}

// `compact`: only the file pane — no tree rail, no commit graph (600px of fixed chrome). The
// demo's brain side panel mounts it this way; the pane already follows the agent's live edit.
export function CodeTab({ compact = false }: { compact?: boolean } = {}) {
  const { connections, loading: connLoading } = useGithubConnections();
  const { currentProjectId } = useCurrentProject();
  const { live, history, repoUpdate } = useCodeStream();
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  // Code-tab "Flash (build & enroll)" modal — compiles the selected connected repo + flashes USB.
  const [flashOpen, setFlashOpen] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Markdown files render formatted by default; this flips the selected .md file to raw source.
  const [mdRaw, setMdRaw] = useState(false);
  // An agent-edited file opens on its diff; this flips it to the whole file.
  const [showDiff, setShowDiff] = useState(true);
  // Bumped to force useRepoTree to refetch when a push lands new code (see repoUpdate effect).
  const [treeNonce, setTreeNonce] = useState(0);
  const lastRepoUpdateRef = useRef(0);
  // Once the user picks a file from the tree, stop auto-following the streaming file so we
  // never yank the pane away from what they're reading.
  const userPinnedRef = useRef(false);
  const selectFile = (p: string) => { userPinnedRef.current = true; setSelectedPath(p); };

  // The bundled demo repo is in play (no real repo connected). Its self-heal runs go through
  // nff-ota, which leaves them with no repo and a synthetic `firmware.ino` path — see `adopt`.
  const hasDemoRepo = connections.some(c => c.virtual);

  // Attribute a self-heal run to the demo repo it actually edited. The worker can't: it heals via
  // nff-ota's submit_firmware_fix, which carries neither a repo nor a path (data/babynffCodeStream).
  // Without this the run's file never joins `editedMap` (its null repo matches nothing), so the tab
  // shows no diff and auto-follow chases a path that isn't in the tree. Inert for a real repo: those
  // runs carry a repo_full_name, and `hasDemoRepo` is false the moment one is connected.
  const adopt = useMemo(() => (v: CodeView): CodeView => {
    if (!hasDemoRepo || v.repoFullName !== null) return v;
    return { ...v, repoFullName: BABYNFF_REPO, files: adoptDemoFiles(v.files) };
  }, [hasDemoRepo]);

  // Merge live sessions + history into one run list (live wins — it carries reasoning).
  const views: CodeView[] = useMemo(() => {
    const byId = new Map<string, CodeView>();
    for (const h of history) {
      byId.set(h.id, adopt({
        id: h.id, repoFullName: h.repoFullName, status: h.status, files: h.files,
        prNumber: h.prNumber, prUrl: h.prUrl, reasoning: null, live: false, when: h.createdAt,
      }));
    }
    for (const s of live) {
      byId.set(s.runId, adopt({
        id: s.runId, repoFullName: s.repoFullName, status: s.status, files: s.files,
        prNumber: s.prNumber, prUrl: s.prUrl, reasoning: s.reasoning, live: s.live, when: s.startedAt,
      }));
    }
    return [...byId.values()].sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return b.when.getTime() - a.when.getTime();
    });
  }, [live, history, adopt]);

  // The repos you can browse: connected repos first, plus any repo an agent run touched.
  const repoOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of connections) set.add(c.repoFullName);
    for (const v of views) if (v.repoFullName) set.add(v.repoFullName);
    return [...set];
  }, [connections, views]);

  // Auto-select a repo once: the newest live run's repo, else the first connected repo.
  useEffect(() => {
    if (selectedRepo && repoOptions.includes(selectedRepo)) return;
    const liveRepo = views.find(v => v.live && v.repoFullName)?.repoFullName ?? null;
    const next = liveRepo ?? repoOptions[0] ?? null;
    if (next !== selectedRepo) setSelectedRepo(next);
  }, [selectedRepo, repoOptions, views]);

  // The production branch for the selected repo (so we show the deployed code). Falls back to
  // the default branch (resolved server-side) when the repo isn't a known connection.
  const branch = useMemo(
    () => connections.find(c => c.repoFullName === selectedRepo)?.productionBranch ?? null,
    [connections, selectedRepo],
  );
  const repoTree = useRepoTree(selectedRepo, branch, treeNonce);

  // The selected repo can be USB-flashed when it's a REAL connection (not the bundled babynff demo
  // repo, which has no GitHub App to build) with a production branch. Compiling arbitrary source over
  // USB is only wired for real connections; the demo flashes via the golden onboarding image instead.
  const selectedConn = useMemo(
    () => connections.find(c => c.repoFullName === selectedRepo) ?? null,
    [connections, selectedRepo],
  );
  const canFlash = !!selectedConn && !selectedConn.virtual && !!branch && !!currentProjectId;

  // A push landed new code on a connected repo's production branch (nff-github broadcast).
  // Drop the stale session-cached tree/files for it and force a refetch so the Code tab shows
  // the latest without a reload; select that repo so the update is what you're looking at.
  useEffect(() => {
    if (!repoUpdate || repoUpdate.n === lastRepoUpdateRef.current) return;
    lastRepoUpdateRef.current = repoUpdate.n;
    // Invalidate both keyings: the server-sent ref and the branch this tab actually browses
    // with (they normally match, but the tab may have fetched with a null/default ref).
    invalidateRepoTree(repoUpdate.repo, repoUpdate.ref);
    invalidateRepoTree(repoUpdate.repo, branch);
    if (repoOptions.includes(repoUpdate.repo)) setSelectedRepo(repoUpdate.repo);
    setTreeNonce(n => n + 1);
  }, [repoUpdate, branch, repoOptions]);

  // Files the agent edited for THIS repo, across all runs (latest run wins on a path clash).
  // The whole CodeFile is kept, not just its content, so `before` survives to drive the diff.
  const editedMap = useMemo(() => {
    const m = new Map<string, CodeFile>();
    const oldestFirst = [...views].sort((a, b) => a.when.getTime() - b.when.getTime());
    for (const v of oldestFirst) {
      if (v.repoFullName !== selectedRepo) continue;
      for (const f of v.files) m.set(f.path, f);
    }
    return m;
  }, [views, selectedRepo]);

  // Use the full repo tree when we have one; otherwise fall back to the edited files only.
  const haveFullTree =
    !!selectedRepo && !repoTree.loading && !repoTree.error && !repoTree.truncated && repoTree.entries.length > 0;

  const paths = useMemo(() => {
    const set = new Set<string>(editedMap.keys());
    if (haveFullTree) for (const e of repoTree.entries) if (e.type === 'blob') set.add(e.path);
    return [...set];
  }, [haveFullTree, repoTree.entries, editedMap]);

  const tree = useMemo(() => buildTree(paths, new Set(editedMap.keys())), [paths, editedMap]);

  const treeNotice =
    !selectedRepo ? null
    : repoTree.loading ? 'Loading repo…'
    : repoTree.error ? 'Repo tree unavailable — showing edited files only.'
    : repoTree.truncated ? 'Repo too large to list — showing edited files only.'
    : null;

  // Keep a valid file selection: default to the repo's README, else the first file. Repairs
  // itself when the repo (and thus the file set) changes, and never fights a run selection
  // (a run's edited file is in editedMap, so it counts as valid).
  useEffect(() => {
    if (paths.length === 0) return;
    const valid = selectedPath && (paths.includes(selectedPath) || editedMap.has(selectedPath));
    if (valid) return;
    const rootReadme = paths.find(p => p.toLowerCase() === 'readme.md');
    const anyReadme = paths.find(p => p.toLowerCase().endsWith('readme.md'));
    setSelectedPath(rootReadme ?? anyReadme ?? [...paths].sort((a, b) => a.localeCompare(b))[0]);
  }, [paths, selectedPath, editedMap]);

  // Follow the file the agent is currently writing: while a run streams and the user hasn't
  // manually picked a file, switch to the newest streaming run's latest file (and its repo) so
  // the centre pane updates itself as the firmware is written.
  const liveRun = views.find(v => v.live && v.status === 'streaming');
  const liveLatestPath = liveRun?.files[liveRun.files.length - 1]?.path ?? null;
  useEffect(() => {
    if (userPinnedRef.current) return;
    if (!liveRun || !liveLatestPath) return;
    if (liveRun.repoFullName && liveRun.repoFullName !== selectedRepo) setSelectedRepo(liveRun.repoFullName);
    if (liveLatestPath !== selectedPath) setSelectedPath(liveLatestPath);
  }, [liveRun, liveLatestPath, selectedRepo, selectedPath]);

  // Lazy content for NON-edited files (edited ones carry their drafted content). Keyed by
  // repo@sha:path so a different repo/branch refetches.
  const [lazyFiles, setLazyFiles] = useState<Record<string, { content: string | null; loading: boolean; error: string | null }>>({});
  const isEdited = selectedPath != null && editedMap.has(selectedPath);
  // An edit whose `before` the worker never captured (the agent wrote a file it never read) still
  // deserves a diff — fetch what the repo holds at that path and diff against that instead.
  const needsBaseline = isEdited && selectedPath != null && editedMap.get(selectedPath)?.before == null;
  const fileKey = selectedRepo && selectedPath ? `${selectedRepo}@${repoTree.sha ?? ''}:${selectedPath}` : null;
  useEffect(() => {
    if (!selectedRepo || !selectedPath || !fileKey) return;
    if (isEdited && !needsBaseline) return;  // the edit carries both sides already
    if (lazyFiles[fileKey]) return;  // already fetched / in flight
    setLazyFiles(prev => ({ ...prev, [fileKey]: { content: null, loading: true, error: null } }));
    fetchRepoFile(selectedRepo, selectedPath, repoTree.sha).then(({ content, error }) => {
      setLazyFiles(prev => ({ ...prev, [fileKey]: { content, loading: false, error } }));
    });
  }, [selectedRepo, selectedPath, isEdited, needsBaseline, fileKey, repoTree.sha, lazyFiles]);

  // The repo-side baseline fetched for an edit that carried no `before` (null while in flight).
  const fetchedBaseline = fileKey ? lazyFiles[fileKey] : undefined;
  const baselinePending = needsBaseline && (!fetchedBaseline || fetchedBaseline.loading);

  // Resolve what to render for the selected path. `before` prefers what the agent actually read;
  // failing that, what the repo holds at the path today — that pair is what the diff needs.
  const view = useMemo(() => {
    const blank = { loading: false, error: null as string | null, edited: false, before: null as string | null };
    if (selectedPath == null) return null;
    const edit = editedMap.get(selectedPath);
    if (edit) return { ...blank, content: edit.content, edited: true, before: edit.before ?? fetchedBaseline?.content ?? null };
    if (fileKey && lazyFiles[fileKey]) return { ...blank, ...lazyFiles[fileKey] };
    return { ...blank, content: null as string | null, loading: true };
  }, [selectedPath, editedMap, fileKey, lazyFiles, fetchedBaseline]);

  // The latest PR opened against the selected repo (header link).
  const repoPr = useMemo(() => {
    for (const v of views) if (v.repoFullName === selectedRepo && v.prUrl) return { url: v.prUrl, number: v.prNumber };
    return null;
  }, [views, selectedRepo]);

  // A newly selected file always opens in the default view (rendered, for Markdown; diff, for an
  // agent edit) — the change is the thing you came to see.
  useEffect(() => { setMdRaw(false); setShowDiff(true); }, [selectedPath]);

  const isMd = selectedPath != null && selectedPath.toLowerCase().endsWith('.md');
  const editedCount = editedMap.size;

  // An agent edit, as a diff. `before` is what the agent read, else what the repo holds at the path;
  // if neither exists the file really is new to us, and an empty original diffs as "+N −0", which is
  // exactly what lineDiff reports. Held back while the repo-side baseline is still in flight so the
  // whole file doesn't flash green before the original lands.
  const diff = useMemo(() => {
    if (!view?.edited || view.error || view.content == null || baselinePending) return null;
    const before = view.before ?? '';
    const { added, removed } = lineDiff(before, view.content);
    return { before, after: view.content, added, removed };
  }, [view, baselinePending]);

  // Reveal the agent's edit as it is written: while its run is still streaming, DiffView types the
  // modified side in line by line. The frames carry whole files (the write tools never send patches),
  // so this is the only place the writing can be seen happening — and the final frame is the real
  // content, so nothing is invented.
  const animate = !!liveRun && liveRun.status === 'streaming'
    && selectedPath != null && liveRun.files.some(f => f.path === selectedPath);

  return (
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      {/* Left rail: repo selector + full file tree */}
      {!compact && <div style={{ width: 280, flexShrink: 0, borderRight: '1px solid #000', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ ...panelHeader, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flexShrink: 0 }}>Repo</span>
          {repoOptions.length > 1 ? (
            <select
              value={selectedRepo ?? ''}
              onChange={e => setSelectedRepo(e.target.value || null)}
              style={{ flex: 1, fontSize: 11, minWidth: 0 }}
            >
              {repoOptions.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          ) : (
            <span style={{ flex: 1, fontWeight: 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedRepo ?? '—'}
            </span>
          )}
          {branch && <span style={{ fontWeight: 'normal', color: '#666', fontSize: 10, flexShrink: 0 }}>@{branch}</span>}
          {canFlash && (
            <button
              onClick={() => setFlashOpen(true)}
              title="Build this repo's firmware and flash it to a USB-connected ESP32 (enrolls into your fleet)"
              style={{
                flexShrink: 0, fontSize: 10, fontWeight: 'bold',
                border: '1px solid #000', background: BRAND_ACCENT, color: '#fff', cursor: 'pointer', padding: '2px 6px',
              }}
            >
              ⚡ Flash
            </button>
          )}
        </div>
        {(editedCount > 0 || treeNotice) && (
          <div style={{ padding: '4px 8px', fontSize: 10, color: '#666', borderBottom: '1px solid #eee', flexShrink: 0, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
            <span>{treeNotice}</span>
            {editedCount > 0 && <span style={{ color: EDITED_COLOR }}>{editedCount} edited</span>}
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {connLoading && repoOptions.length === 0 ? (
            <div style={{ padding: 8, fontSize: 11, color: '#666' }}>Loading repos…</div>
          ) : repoOptions.length === 0 ? (
            <div style={{ padding: 8, fontSize: 11, color: '#666' }}>
              No repo connected — connect one in the GitHub tab to browse its code here.
            </div>
          ) : tree.length === 0 ? (
            <div style={{ padding: 8, fontSize: 11, color: '#666' }}>
              {repoTree.loading ? 'Loading files…' : 'No files to show.'}
            </div>
          ) : (
            <FileTree entries={tree} depth={0} selectedPath={selectedPath} onSelect={selectFile} />
          )}
        </div>
      </div>}

      {/* Center: selected file content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {selectedPath && view ? (
          <>
            <div style={{ ...panelHeader, background: '#fafafa', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedPath}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {view.edited ? (
                  <span style={{ color: EDITED_COLOR, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span>● agent edit</span>
                    {diff && (
                      <span style={{ fontWeight: 'normal' }}>
                        <span style={{ color: '#15803d' }}>+{diff.added}</span>
                        {' '}
                        <span style={{ color: '#b91c1c' }}>−{diff.removed}</span>
                      </span>
                    )}
                  </span>
                ) : view.loading ? (
                  <span style={{ color: '#666' }}>loading…</span>
                ) : null}
                {diff && <SegSwitch left="Diff" right="File" leftActive={showDiff} onPick={setShowDiff} />}
                {repoPr && (
                  <a href={repoPr.url} target="_blank" rel="noreferrer" style={{ color: '#1d4ed8', fontWeight: 'bold' }}>
                    PR #{repoPr.number} ↗
                  </a>
                )}
                {isMd && view.content != null && !view.loading && !view.error && (
                  <SegSwitch left="Rendered" right="Raw" leftActive={!mdRaw} onPick={l => setMdRaw(!l)} />
                )}
                {view.content != null && !view.loading && !view.error && (
                  <CopyButton variant="icon" title="Copy file" value={view.content} />
                )}
              </span>
            </div>
            {view.loading ? (
              <div style={{ padding: 8, fontSize: 11, color: '#666' }}>Loading {selectedPath}…</div>
            ) : view.error ? (
              <div style={{ padding: 8, fontSize: 11, color: '#b91c1c' }}>{view.error}</div>
            ) : view.content === null ? (
              <div style={{ padding: 8, fontSize: 11, color: '#666' }}>(binary or empty file)</div>
            ) : diff && showDiff ? (
              <Suspense fallback={<div style={{ padding: 8, fontSize: 11, color: '#666' }}>Loading diff…</div>}>
                <DiffView path={selectedPath} before={diff.before} after={diff.after} animate={animate} />
              </Suspense>
            ) : isMd && !mdRaw ? (
              <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 12, fontSize: 13, lineHeight: 1.5, color: '#000', background: '#fff' }}>
                <Markdown>{view.content}</Markdown>
              </div>
            ) : (
              <CodeHighlight
                code={view.content}
                language={langFromPath(selectedPath)}
                style={{ ...codePre, flex: 1, overflow: 'auto', minHeight: 0 }}
              />
            )}
          </>
        ) : repoOptions.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 12, padding: 16, textAlign: 'center' }}>
            Connect a GitHub repo to browse its firmware code here.
          </div>
        ) : selectedRepo && repoTree.error && editedCount === 0 ? (
          // Tree fetch failed and there are no agent edits to fall back to — show why instead
          // of a blank pane (e.g. nff-github unreachable, or the repo has no installation token).
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#b91c1c', fontSize: 12, padding: 24, textAlign: 'center', gap: 8 }}>
            <div style={{ fontWeight: 'bold' }}>Couldn't load {selectedRepo}</div>
            <div style={{ color: '#444', maxWidth: 460 }}>{repoTree.error}</div>
            <div style={{ color: '#666', fontSize: 11, maxWidth: 460 }}>
              Check that nff-github is reachable and the GitHub App is installed on this repo
              (a connection with no installation can't be cloned).
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontSize: 12, padding: 16, textAlign: 'center' }}>
            {repoTree.loading ? 'Loading repo…' : 'Select a file to view its code.'}
          </div>
        )}
      </div>

      {/* Right: the live git graph (branches + deploy spine). */}
      {!compact && <CommitGraph repoFullName={selectedRepo} />}

      {flashOpen && canFlash && selectedRepo && branch && (
        <FlashCodeModal
          onClose={() => setFlashOpen(false)}
          projectId={currentProjectId}
          repoFullName={selectedRepo}
          productionBranch={branch}
        />
      )}
    </div>
  );
}

// A two-way segmented control in the file header: Rendered|Raw for Markdown, Diff|File for an
// agent edit. `onPick` receives true when the LEFT (default) option is chosen.
function SegSwitch({
  left, right, leftActive, onPick,
}: { left: string; right: string; leftActive: boolean; onPick: (left: boolean) => void }) {
  const btn = (active: boolean): React.CSSProperties => ({
    fontSize: 10, fontWeight: 'bold', padding: '1px 6px',
    cursor: 'pointer', border: 'none', background: active ? '#000' : '#fff', color: active ? '#fff' : '#000',
  });
  return (
    <div style={{ display: 'flex', border: '1px solid #000', flexShrink: 0 }}>
      <button onClick={() => onPick(true)} style={{ ...btn(leftActive), borderRight: '1px solid #000' }}>{left}</button>
      <button onClick={() => onPick(false)} style={btn(!leftActive)}>{right}</button>
    </div>
  );
}
