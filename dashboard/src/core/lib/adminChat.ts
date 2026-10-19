import { apiDelete, apiPost } from './api';
import { invalidatePrefix } from './resourceCache';
import { supabase } from './supabase';

// Shared data-chat engine — one send path for both surfaces (the floating
// ChatDock and the full-page ChatTab): worker queue first, Vercel fallback.

// Mirrors TraceEntry in api/_lib/chat.ts — one chip per tool call.
export interface TraceEntry {
  table: string;
  filters: string;
  rows: number;
  ms: number;
  error: string | null;
  write?: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  trace?: TraceEntry[];
  // User messages only: snapshot of the chips attached at send time. Immutable
  // history — detaching a chip later never rewrites past messages.
  artifacts?: ArtifactChip[];
}

export interface ChatResponse {
  reply: string;
  trace: TraceEntry[];
  /** Set by the Vercel loop when a reply was cut off by its round/time budget, not a natural stop. */
  truncated?: boolean;
}

// Fire-and-forget signal for "ask the data-chat agent this" from anywhere in
// the UI (e.g. a picked metric tile) without prop-drilling into whichever
// ChatDock instance happens to be mounted for the current tab.
export const ASK_CHAT_EVENT = 'nff-admin-ask-chat';
export function askChat(question: string) {
  window.dispatchEvent(new CustomEvent<string>(ASK_CHAT_EVENT, { detail: question }));
}

// Overview → Chat handoff: when the embedded (BrainCard) dock gets a reply, the
// finished exchange is parked here and the shell navigates to the Chat tab,
// which adopts it as a persisted session (and opens its brain pane).
// sessionStorage, not just the event: nff-admin mounts only the active tab, so
// ChatTab isn't listening yet when the reply lands — it consumes on mount.
export const CHAT_HANDOFF_EVENT = 'nff-admin-chat-handoff';
const HANDOFF_KEY = 'nff-admin-chat-handoff';
export interface ChatHandoff {
  messages: ChatMessage[];
  artifacts: ArtifactChip[];
}
export function handoffToChatTab(h: ChatHandoff) {
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(h));
  } catch {
    return; // quota — stay on Overview rather than jump to an empty chat
  }
  window.dispatchEvent(new Event(CHAT_HANDOFF_EVENT));
}
/** Side-effect-free peek — safe in a useState initializer (StrictMode double-invokes those). */
export function hasChatHandoff(): boolean {
  return sessionStorage.getItem(HANDOFF_KEY) !== null;
}
/** Consume the parked handoff (once); null when there is none. */
export function takeChatHandoff(): ChatHandoff | null {
  const raw = sessionStorage.getItem(HANDOFF_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(HANDOFF_KEY);
  try {
    const h = JSON.parse(raw) as ChatHandoff;
    return Array.isArray(h?.messages) && h.messages.length > 0 ? { messages: h.messages, artifacts: h.artifacts ?? [] } : null;
  } catch {
    return null;
  }
}

// A brain sync landed — nff-app's auto-sync on connect, or the rail's Sync
// database button. The workspace graph refetches and glows the added nodes.
export const BRAIN_SYNCED_EVENT = 'nff-brain-synced';
export interface BrainSyncedDetail {
  synced: number;
  edges: number;
  added: number;
  changed: number;
  removed: number;
  addedIds?: string[];
}

// A chat reply landed anywhere (dock, Chat tab, a /skill) — the tour's "Ask it" gate.
export const CHAT_REPLIED_EVENT = 'nff-chat-replied';

// The brain graph's hover/selection state, for the tour's "hover the core" / "click the
// node" gates (BrainCard dispatches it whenever either changes).
export const BRAIN_TOUR_EVENT = 'nff-brain-tour';
export interface BrainTourDetail {
  hubRevealed: boolean;
  selectedId: string | null;
}

// "Query mode": armed from the chat popup's Query button, it makes metric
// tiles across the app highlight and become clickable so picking one asks
// the agent how to improve it. Global (not per-tab) — a module var + a
// window event, same bridge pattern as ASK_CHAT_EVENT above, so any number
// of StatCard instances can react without a shared React tree.
export const QUERY_MODE_EVENT = 'nff-admin-query-mode';
let queryModeOn = false;
export function isQueryModeOn() {
  return queryModeOn;
}
export function setQueryMode(on: boolean) {
  queryModeOn = on;
  window.dispatchEvent(new CustomEvent<boolean>(QUERY_MODE_EVENT, { detail: on }));
}

// Mirrors ArtifactInfo in api/_lib/artifacts.ts — pasted/uploaded data blobs
// attached to a conversation.
export interface ArtifactChip {
  id: string;
  name: string;
  kind: 'table' | 'text';
  meta: { columns?: string[]; rowCount?: number };
  sizeChars: number;
}

// Pastes above this length (or anything tabular-looking) become artifacts.
export const PASTE_ARTIFACT_THRESHOLD = 2_000;
export const MAX_ARTIFACT_CHARS = 3_500_000; // matches MAX_CONTENT_CHARS server-side

// Text formats the artifact pipeline can store; drives both the file inputs'
// accept attr and drag-and-drop validation.
export const CHAT_FILE_EXTENSIONS = ['.csv', '.tsv', '.txt', '.json', '.md', '.log'];
// Binary spreadsheets — parsed client-side (SheetJS) into per-sheet CSV artifacts.
export const CHAT_SPREADSHEET_EXTENSIONS = ['.xlsx', '.xls'];
export const CHAT_FILE_ACCEPT = [...CHAT_FILE_EXTENSIONS, ...CHAT_SPREADSHEET_EXTENSIONS].join(',');
export const MAX_CHAT_ARTIFACTS = 8; // matches MAX_CHAT_ARTIFACTS in api/_lib/chat.ts

export interface PreparedChatFile {
  name: string;
  content: string;
  kindHint?: 'table';
}

/**
 * Read and validate picked/dropped files. Returns the ones ready to upload plus
 * human-readable skip reasons for the rest. `slotsLeft` bounds how many are
 * accepted — the server rejects requests past MAX_CHAT_ARTIFACTS anyway.
 */
export async function prepareChatFiles(
  files: File[],
  slotsLeft: number,
): Promise<{ accepted: PreparedChatFile[]; skipped: string[] }> {
  const accepted: PreparedChatFile[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const lower = file.name.toLowerCase();

    if (CHAT_SPREADSHEET_EXTENSIONS.some((e) => lower.endsWith(e))) {
      let sheets: Array<{ name: string; csv: string }>;
      try {
        const XLSX = await import('xlsx'); // dynamic — Vite splits SheetJS into a lazy chunk
        const wb = XLSX.read(await file.arrayBuffer());
        sheets = wb.SheetNames.map((n) => ({ name: n, csv: XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false }) })).filter(
          (s) => s.csv.trim().length > 0,
        );
      } catch {
        skipped.push(`${file.name} (could not parse spreadsheet)`);
        continue;
      }
      if (!sheets.length) {
        skipped.push(`${file.name} (no data)`);
        continue;
      }
      for (const s of sheets) {
        // One artifact per sheet, each counting against the attachment cap.
        const name = (sheets.length > 1 ? `${file.name} · ${s.name}` : file.name).slice(0, 120); // server MAX_NAME_LEN
        if (accepted.length >= slotsLeft) {
          skipped.push(`${name} (over ${MAX_CHAT_ARTIFACTS}-attachment limit)`);
          continue;
        }
        if (s.csv.length > MAX_ARTIFACT_CHARS) {
          skipped.push(`${name} (too large)`);
          continue;
        }
        accepted.push({ name, content: s.csv, kindHint: 'table' });
      }
      continue;
    }

    const ext = CHAT_FILE_EXTENSIONS.find((e) => lower.endsWith(e));
    if (!ext) {
      skipped.push(`${file.name} (unsupported type)`);
      continue;
    }
    if (accepted.length >= slotsLeft) {
      skipped.push(`${file.name} (over ${MAX_CHAT_ARTIFACTS}-attachment limit)`);
      continue;
    }
    let content: string;
    try {
      content = await file.text();
    } catch {
      skipped.push(`${file.name} (unreadable)`);
      continue;
    }
    if (content.length > MAX_ARTIFACT_CHARS) {
      skipped.push(`${file.name} (too large)`);
      continue;
    }
    // Only .csv/.tsv are surely tabular; everything else lets the server auto-detect.
    accepted.push({ name: file.name, content, kindHint: ext === '.csv' || ext === '.tsv' ? 'table' : undefined });
  }
  return { accepted, skipped };
}

// Mirrors MAX_HISTORY_MESSAGES in api/_lib/chat.ts — the Vercel loop trims
// server-side anyway; trimming here bounds the worker payload too.
export const MAX_HISTORY_MESSAGES = 30;

// How long a request may sit UNCLAIMED ('pending') before we conclude the worker
// isn't picking up and fall back to the Vercel loop. A claimed row ('running') is
// never timed out here: the agent is working, and the UI keeps its thinking
// indicator up until the row settles — the worker's own run timeout and its
// reaper are what flip a truly dead run to 'error'.
export const WORKER_TIMEOUT_MS = 120_000;

interface WorkerRow {
  status?: string;
  reply?: string | null;
  trace?: TraceEntry[] | null;
  error?: string | null;
}

// The request in flight for a persisted Chat-tab session, remembered across
// reloads so the transcript re-attaches to the row — still "thinking", elapsed
// time counted from the ORIGINAL send — instead of showing a finished-looking
// conversation while the worker is still answering. Cleared when the row settles.
const PENDING_KEY = 'nff.chat.pending.';
interface PendingMarker {
  id: string;
  startedAt: number;
}

function readPending(sessionId: string): PendingMarker | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY + sessionId);
    const m = raw ? (JSON.parse(raw) as PendingMarker) : null;
    return m && typeof m.id === 'string' && typeof m.startedAt === 'number' ? m : null;
  } catch {
    return null;
  }
}

function writePending(sessionId: string, m: PendingMarker | null): void {
  try {
    if (m) localStorage.setItem(PENDING_KEY + sessionId, JSON.stringify(m));
    else localStorage.removeItem(PENDING_KEY + sessionId);
  } catch {
    /* storage unavailable — the in-memory wait still works */
  }
}

/**
 * Wait for request row `id` to settle — via Realtime UPDATE plus a 3s poll
 * (Realtime silently drops oversized payloads, so the poll is the guarantee).
 * Rejects on 'error', on a vanished row, or when the row is still unclaimed
 * WORKER_TIMEOUT_MS after `startedAt`; a 'running' row is waited on for as long
 * as it runs.
 *
 * ONE wait per row, shared by every caller (`inFlight`): a tab switch unmounts
 * the Chat tab (the shells render only the active <Main/>), so its remount
 * re-attaches to a row `askWorker` is still waiting on. Without the share that
 * second call is fatal — supabase.channel() hands back the ALREADY subscribed
 * channel for a duplicate topic, and `.on()` throws there ("cannot add
 * `postgres_changes` callbacks for realtime:chatreq-… after `subscribe()`").
 */
const inFlight = new Map<string, Promise<ChatResponse>>();

function waitWorkerRow(id: string, startedAt: number): Promise<ChatResponse> {
  const live = inFlight.get(id);
  if (live) return live;
  const wait = new Promise<ChatResponse>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      void supabase.removeChannel(channel);
      fn();
    };
    const finish = (row: WorkerRow) => {
      if (row.status === 'done') settle(() => resolve({ reply: row.reply ?? '', trace: row.trace ?? [] }));
      else if (row.status === 'error') settle(() => reject(new Error(row.error ?? 'worker errored')));
      else if (row.status !== 'running' && Date.now() - startedAt > WORKER_TIMEOUT_MS) {
        settle(() => reject(new Error('worker did not pick up the request')));
      }
    };
    const channel = supabase
      .channel(`chatreq-${id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'admin_chat_requests', filter: `id=eq.${id}` },
        (p) => finish(p.new as WorkerRow),
      )
      .subscribe();
    const poll = setInterval(() => {
      void supabase
        .from('admin_chat_requests')
        .select('status,reply,trace,error')
        .eq('id', id)
        .single()
        .then(({ data: row, error }) => {
          if (row) finish(row as WorkerRow);
          else if (error?.code === 'PGRST116') settle(() => reject(new Error('request row missing'))); // 0 rows
        });
    }, 3_000);
  }).finally(() => inFlight.delete(id));
  inFlight.set(id, wait);
  return wait;
}

/**
 * Ask the VPS worker: insert a request row (RLS: platform admins only), then
 * wait for the worker to settle it. Throws on error/no-pickup; the caller falls
 * back to the Vercel loop. With `pending` (a persisted Chat-tab session), the
 * in-flight row is remembered so a reload re-attaches — see resumePendingReply.
 */
export async function askWorker(
  payload: Array<{ role: string; content: string }>,
  artifactIds: string[],
  pending?: { sessionId: string; startedAt: number },
): Promise<ChatResponse> {
  const { data, error } = await supabase
    .from('admin_chat_requests')
    .insert({ messages: payload, artifact_ids: artifactIds })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'request insert failed');
  const id = data.id as string;
  const startedAt = pending?.startedAt ?? Date.now();
  if (pending) writePending(pending.sessionId, { id, startedAt });
  try {
    return await waitWorkerRow(id, startedAt);
  } finally {
    if (pending) writePending(pending.sessionId, null);
  }
}

/**
 * Re-attach to a session's reply still in flight from before a reload (or from
 * another tab). Null when nothing is pending. `startedAt` is the original send,
 * for the elapsed counter; `reply` settles exactly like sendChat's.
 */
export function resumePendingReply(sessionId: string): { startedAt: number; reply: Promise<ChatResponse> } | null {
  const m = readPending(sessionId);
  if (!m) return null;
  const reply = waitWorkerRow(m.id, m.startedAt)
    .finally(() => writePending(sessionId, null))
    .then((resp) => {
      invalidateFromTrace(resp.trace);
      return replied(resp);
    });
  return { startedAt: m.startedAt, reply };
}

// ── skills ───────────────────────────────────────────────────────────────────
// A skill IS a workflow (Settings → Workflows, admin_workflows 0120): a named
// list of steps the admin agent executes in ONE run with a 5-minute budget —
// what a chat turn (25s on Vercel, 300s on the worker) cannot do. From the chat
// composer, `/<name> <free text>` queues a manual admin_workflow_runs row with
// the text as `input` (0157) and waits on it exactly like askWorker; the reply
// renders as a normal assistant message. Worker only — there is no Vercel path.

/** `/email-to-brain past month` → { name: 'email-to-brain', input: 'past month' }; null for plain text. */
export function parseSkillCommand(text: string): { name: string; input: string } | null {
  const m = /^\/([a-z0-9][\w-]*)\s*([\s\S]*)$/i.exec(text.trim());
  return m ? { name: m[1], input: m[2].trim() } : null;
}

// Worker run timeout (ADMIN_WORKFLOW_RUN_TIMEOUT_MS, 300s) + queue slack; the
// worker reaper flips a truly stuck row later, so a timeout here is "still
// running", not "failed" — the result stays visible in Settings → Workflows.
export const SKILL_TIMEOUT_MS = 420_000;

export async function runSkill(name: string, input: string): Promise<ChatResponse> {
  const { data: wf, error: wfErr } = await supabase
    .from('admin_workflows')
    .select('id,name')
    .ilike('name', name)
    .limit(1)
    .maybeSingle();
  if (wfErr) throw new Error(wfErr.message);
  if (!wf) throw new Error(`No skill named "${name}". Skills are the workflows in Settings → Workflows; type / to list them.`);

  const { data, error } = await supabase
    .from('admin_workflow_runs')
    .insert({ workflow_id: wf.id, trigger: 'manual', input: input || null })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'skill run insert failed');
  const id = data.id as string;
  invalidatePrefix('sb:admin_workflow_runs'); // Settings history shows it as pending

  return new Promise<ChatResponse>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poll);
      void supabase.removeChannel(channel);
    };
    const finish = (row: WorkerRow) => {
      if (settled || !row.status || row.status === 'pending' || row.status === 'running') return;
      settled = true;
      cleanup();
      invalidatePrefix('sb:admin_workflow_runs');
      if (row.status === 'done') resolve({ reply: row.reply ?? '', trace: row.trace ?? [] });
      else reject(new Error(row.error ?? 'skill run errored'));
    };
    const channel = supabase
      .channel(`skillrun-${id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'admin_workflow_runs', filter: `id=eq.${id}` },
        (p) => finish(p.new as WorkerRow),
      )
      .subscribe();
    // Realtime is the nudge; this poll is the guarantee (oversized replies are dropped).
    const poll = setInterval(() => {
      void supabase
        .from('admin_workflow_runs')
        .select('status,reply,trace,error')
        .eq('id', id)
        .single()
        .then(({ data: row }) => {
          if (row) finish(row as WorkerRow);
        });
    }, 3_000);
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Skill "${wf.name}" is still running — its result will appear in Settings → Workflows.`));
      }
    }, SKILL_TIMEOUT_MS);
  });
}

// A truncated reply (MAX_TOOL_ROUNDS/TIME_BUDGET_MS cut it off mid-task, not a
// natural stop) used to just sit there until the admin noticed and typed
// "continue" themselves. Auto-continue a bounded number of times instead —
// bulk ingestion (a big pasted artifact) finishes in one exchange instead of
// stalling every ~6 tool rounds.
const MAX_AUTO_CONTINUES = 3;

/**
 * Send a transcript and get the assistant's reply. Worker-first: when
 * nff-admin-worker beats healthy on the VPS, questions go through its Supabase
 * queue (Max-plan CLI, no 30s cap). Any worker failure — insert error, run
 * error, timeout — silently falls back to the Vercel loop. Throws on failure.
 * A `/skill` turn runs the workflow instead (worker only, see runSkill).
 *
 * `sessionId` (the persisted Chat-tab session, when there is one) lets the
 * server fall back to that session's full retained artifact set
 * (admin_chat_sessions.all_artifact_ids) instead of only the live composer
 * chips — see loadSessionArtifactIds in api/_lib/chat.ts — so an artifact
 * attached earlier in the conversation stays readable even if this
 * particular request's chip list doesn't carry it.
 */
export async function sendChat(
  history: ChatMessage[],
  artifactIds: string[],
  workerOnline: boolean,
  sessionId?: string,
): Promise<ChatResponse> {
  const last = history[history.length - 1];
  const skill = last?.role === 'user' ? parseSkillCommand(last.text) : null;
  if (skill) {
    if (!workerOnline) throw new Error('Skills run on the admin worker, which is offline right now.');
    const resp = await runSkill(skill.name, skill.input);
    invalidateFromTrace(resp.trace);
    return replied(resp);
  }

  let workingHistory = history;
  const trace: TraceEntry[] = [];
  let resp: ChatResponse;
  // One start for the whole exchange (auto-continue rounds included) — the
  // persisted pending marker and the elapsed counter both count from here.
  const pending = sessionId ? { sessionId, startedAt: Date.now() } : undefined;
  for (let round = 0; ; round++) {
    const payload = workingHistory.slice(-MAX_HISTORY_MESSAGES).map((m) => ({ role: m.role, content: m.text }));
    const viaVercel = () => apiPost<ChatResponse>('/api/tables/chat', { messages: payload, artifactIds, sessionId });
    resp = workerOnline ? await askWorker(payload, artifactIds, pending).catch(viaVercel) : await viaVercel();
    trace.push(...(resp.trace ?? []));
    if (!resp.truncated || round >= MAX_AUTO_CONTINUES) break;
    workingHistory = [
      ...workingHistory,
      { role: 'assistant', text: resp.reply, trace: resp.trace },
      { role: 'user', text: 'continue' },
    ];
  }
  invalidateFromTrace(trace);
  return replied({ reply: resp.reply, trace, truncated: resp.truncated });
}

function replied(resp: ChatResponse): ChatResponse {
  window.dispatchEvent(new Event(CHAT_REPLIED_EVENT));
  return resp;
}

function invalidateFromTrace(trace: TraceEntry[] | undefined): void {
  // Brain writes: the Overview graph polls /api/tables/brain — drop its cache too.
  if (trace?.some((t) => t.write && !t.error && t.table === 'brain_nodes')) invalidatePrefix('/api/tables/brain');
}

/**
 * Best-effort LLM title for a new session, from its first question (Claude-style
 * sidebar labels). Serverless one-shot — works whichever path answers the chat.
 * Returns null when unavailable (preview without keys, API failure): the caller
 * keeps the mechanical truncation.
 */
export async function fetchSessionTitle(question: string): Promise<string | null> {
  try {
    const { title } = await apiPost<{ title: string | null }>('/api/tables/chat/title', { question });
    return title?.trim() ? title : null;
  } catch {
    return null;
  }
}

/** Store pasted/uploaded data server-side; throws on oversize or upload failure. */
export async function uploadArtifactRequest(
  name: string,
  content: string,
  kindHint?: 'table' | 'text',
): Promise<ArtifactChip> {
  if (content.length > MAX_ARTIFACT_CHARS) {
    throw new Error(`too large — max ~3.5MB of text (got ${(content.length / 1e6).toFixed(1)}M chars)`);
  }
  return apiPost<ArtifactChip>('/api/tables/artifacts', { name, content, kindHint });
}

const MAX_DELETE_IDS = 20; // matches MAX_DELETE_IDS in api/_lib/artifacts.ts

export function deleteArtifactsBestEffort(ids: string[]): void {
  for (let i = 0; i < ids.length; i += MAX_DELETE_IDS) {
    void apiDelete('/api/tables/artifacts', { ids: ids.slice(i, i + MAX_DELETE_IDS) }).catch(() => {
      /* best-effort — the server sweep is the backstop */
    });
  }
}

/**
 * Every artifact id a session must retain: ids snapshotted on any message ∪
 * the live composer set. Persisted as admin_chat_sessions.all_artifact_ids —
 * the 48h server sweep spares ids in that column (0118).
 */
export function collectArtifactIds(messages: ChatMessage[], live: ArtifactChip[]): string[] {
  const ids = new Set<string>();
  for (const m of messages) for (const a of m.artifacts ?? []) ids.add(a.id);
  for (const a of live) ids.add(a.id);
  return [...ids];
}
