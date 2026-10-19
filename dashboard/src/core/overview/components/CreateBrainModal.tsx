// CreateBrainModal — the Overview tab dropdown's "+ Create a new brain…" entry.
// Names an admin-authored "context picker" brain (0142), feeds it pasted text
// and/or files, and creates it via api/_lib/brain.ts's handleCustomBrains.
//
// Same modal idiom as MemoryModal/DecisionModal: z-[60] over an ink/40
// backdrop, Escape and backdrop-click close, DecisionModal's busy/error act()
// wrapper for the submit call.
//
// File support is exactly what prepareChatFiles (the chat dock's existing
// upload pipeline) already knows how to turn into text — .txt/.md/.csv/.tsv/
// .json/.log read as-is, .xlsx/.xls parsed client-side via SheetJS. PDFs,
// Word docs, images are out of scope: no parser for them exists in this repo.

import { useEffect, useState } from 'react';
import { useFileDrop } from '../../hooks/useFileDrop';
import { prepareChatFiles, CHAT_FILE_ACCEPT, type PreparedChatFile } from '../../lib/adminChat';
import { BRAIN_TOOL_CATALOG } from '../lib/toolCatalog';
import { PermissionSwitch } from '../../../components/squeletton/StoreSection';
import { useToast } from '../../components/ToastProvider';

export function CreateBrainModal({
  onClose,
  onCreated,
  createCustomBrain,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  createCustomBrain: (payload: {
    name: string;
    description: string;
    enabledTools: string[];
    items: Array<{ name: string; content: string }>;
  }) => Promise<{ customBrain: { id: string } }>;
}) {
  const { push } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [pastedText, setPastedText] = useState('');
  const [files, setFiles] = useState<PreparedChatFile[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [enabledTools, setEnabledTools] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleFiles(picked: File[]) {
    const { accepted, skipped: skippedNow } = await prepareChatFiles(picked, Math.max(0, 50 - files.length));
    setFiles((prev) => [...prev, ...accepted]);
    setSkipped(skippedNow);
  }

  const { dragActive, dropProps } = useFileDrop((picked) => void handleFiles(picked));

  function toggleTool(id: string) {
    setEnabledTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit() {
    if (!name.trim()) {
      push({ tone: 'error', title: 'Name is required' });
      return;
    }
    setBusy(true);
    try {
      const items = [
        ...files.map((f) => ({ name: f.name, content: f.content })),
        ...(pastedText.trim() ? [{ name: 'Pasted text', content: pastedText.trim() }] : []),
      ];
      const { customBrain } = await createCustomBrain({
        name: name.trim(),
        description: description.trim(),
        enabledTools: [...enabledTools],
        items,
      });
      push({ tone: 'info', title: `"${name.trim()}" brain created` });
      onCreated(customBrain.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      push({ tone: 'error', title: 'Could not create brain', detail: msg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Create a new brain"
        className="flex max-h-[85vh] w-full max-w-xl flex-col border border-ink bg-paper font-mono shadow-hard"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-ink px-4 py-2">
          <span className="text-[11px] uppercase tracking-label text-ink">Create a new brain</span>
          <button onClick={onClose} aria-label="Close" className="text-xs text-muted hover:text-ink">
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5" {...dropProps}>
          <label className="mb-3 block text-xs">
            <span className="mb-1 block text-[10px] uppercase tracking-label text-muted">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q3 pricing research"
              className="w-full border border-ink bg-paper px-2 py-1.5 text-xs text-ink focus:outline-none"
              autoFocus
            />
          </label>

          <label className="mb-3 block text-xs">
            <span className="mb-1 block text-[10px] uppercase tracking-label text-muted">
              Description — what it is, what it's for
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full resize-y border border-ink bg-paper px-2 py-1.5 text-xs text-ink focus:outline-none"
            />
          </label>

          <label className="mb-3 block text-xs">
            <span className="mb-1 block text-[10px] uppercase tracking-label text-muted">Paste context</span>
            <textarea
              value={pastedText}
              onChange={(e) => setPastedText(e.target.value)}
              rows={5}
              placeholder="Paste as much raw context as you like…"
              className="w-full resize-y border border-ink bg-paper px-2 py-1.5 text-xs text-ink focus:outline-none"
            />
          </label>

          <div className="mb-3">
            <span className="mb-1 block text-[10px] uppercase tracking-label text-muted">Files</span>
            <div
              className={`flex flex-col items-start gap-2 border border-dashed px-3 py-3 text-xs ${
                dragActive ? 'border-ink bg-elevated' : 'border-hairline'
              }`}
            >
              <label className="cursor-pointer text-ink underline hover:no-underline">
                Browse files…
                <input
                  type="file"
                  multiple
                  accept={CHAT_FILE_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) void handleFiles(Array.from(e.target.files));
                    e.target.value = '';
                  }}
                />
              </label>
              <span className="text-[11px] text-faint">or drop files here — .txt .md .csv .tsv .json .log .xlsx .xls</span>
              {files.length > 0 && (
                <ul className="w-full text-[11px] text-ink">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 border-t border-hairline py-1">
                      <span className="truncate">{f.name}</span>
                      <button
                        onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                        className="shrink-0 text-faint hover:text-ink"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {skipped.length > 0 && (
                <ul className="w-full text-[11px] text-red-600">
                  {skipped.map((s) => (
                    <li key={s}>Skipped: {s}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div>
            <span className="mb-1 block text-[10px] uppercase tracking-label text-muted">
              Tools this context is meant to be used with
            </span>
            <div className="flex flex-col gap-1.5">
              {BRAIN_TOOL_CATALOG.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-ink">{t.label}</span>
                  <PermissionSwitch checked={enabledTools.has(t.id)} onChange={() => toggleTool(t.id)} />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-ink px-4 py-2.5">
          <button onClick={onClose} className="text-xs text-muted hover:text-ink">
            Cancel
          </button>
          <button
            onClick={() => void handleSubmit()}
            disabled={busy || !name.trim()}
            className={`border border-ink px-3 py-1.5 text-[11px] tracking-wide ${
              busy || !name.trim() ? 'cursor-default bg-elevated text-muted' : 'bg-ink text-paper hover:bg-paper hover:text-ink'
            }`}
          >
            {busy ? 'Creating…' : 'Create brain'}
          </button>
        </div>
      </div>
    </div>
  );
}
