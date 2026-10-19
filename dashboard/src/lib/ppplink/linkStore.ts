// linkStore.ts — module-level owner of the (at most one) active WiredLink.
//
// The link is born in the flash modal but must OUTLIVE it: while the device is wired, this tab is
// its network, and the user roams the dashboard (fleet grid, break/self-heal, builder) with the
// modal long closed. So components never own the link — they adopt it into this store and observe
// it via useSyncExternalStore (src/hooks/useWiredLink.ts).

import { WiredLink } from './index';
import type { WiredLinkPlan, WiredLinkState } from './index';
import { supabase } from '../supabase';

let link: WiredLink | null = null;
let state: WiredLinkState | null = null;
let linkDeviceId: string | null = null;   // best-effort: which fleet device this link is wired to
const listeners = new Set<() => void>();

// Device serial console (0xC0FF frames the firmware sends over the live link). A bounded ring,
// exposed to React via useSyncExternalStore — getConsoleSnapshot returns a STABLE array reference
// that is only replaced on push, so React doesn't loop on an ever-changing snapshot.
const CONSOLE_MAX = 2000;
let consoleSnapshot: readonly string[] = [];
const consoleListeners = new Set<() => void>();

// ── Cloud sync of the console (device_serial_logs) ─────────────────────────────────────────────
// The browser is the ONLY place these lines exist, so it is also the writer of record: lines are
// timestamped at receipt, buffered, and batch-inserted under the user's JWT (RLS: project member
// + device-in-project). Kept separate from the render ring so a resumed page never re-uploads the
// old ring. Until the device id is known (fresh flash → enrollment claim), lines accumulate in
// `pending` (bounded) and flush retroactively the moment attachLinkDevice() names the device —
// that is what preserves the first-boot log, where the interesting failures live.
interface PendingLine { ts: string; seq: number; line: string }
const FLUSH_MS = 2000;
const FLUSH_MAX = 100;          // lines per insert batch
const PENDING_CAP = 1000;       // pre-claim backlog bound
const LINE_MAX = 512;           // must match the DB check constraint
let pending: PendingLine[] = [];
let seqCounter = 0;             // monotone per-session; (ts, seq) reconstructs console order
let uploadProjectId: string | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let backoffUntil = 0;           // epoch ms; grows 5s → 5min on insert failure
let backoffMs = 5_000;

function scheduleFlush(): void {
  if (pending.length >= FLUSH_MAX) { void flushSerialLogs(); return; }
  if (flushTimer === null) {
    flushTimer = setTimeout(() => { flushTimer = null; void flushSerialLogs(); }, FLUSH_MS);
  }
}

async function flushSerialLogs(): Promise<void> {
  if (flushing) return;
  if (!linkDeviceId || !uploadProjectId || pending.length === 0) return;
  if (Date.now() < backoffUntil) { scheduleFlush(); return; }
  flushing = true;
  const batch = pending.slice(0, FLUSH_MAX * 2);
  pending = pending.slice(batch.length);
  const rows = batch.map((p) => ({
    device_id: linkDeviceId,
    project_id: uploadProjectId,
    ts: p.ts,
    seq: p.seq,
    line: p.line,
  }));
  try {
    const { error } = await supabase.from('device_serial_logs').insert(rows);
    if (error) throw error;
    backoffMs = 5_000; // success — reset backoff
  } catch {
    // Insert is atomic (all-or-nothing): re-queue the whole batch and back off. Offline tabs and
    // RLS rejections must not spam — the ring/UI is unaffected either way.
    pending = batch.concat(pending).slice(-PENDING_CAP);
    backoffUntil = Date.now() + backoffMs;
    backoffMs = Math.min(backoffMs * 2, 300_000);
  } finally {
    flushing = false;
  }
  if (pending.length > 0) scheduleFlush();
}

/** Late-bind the fleet device id to the active link (enrollment claim names it after the first
    boot log has already streamed). Persists it for resume and drains the buffered backlog. */
export function attachLinkDevice(deviceId: string): void {
  setLinkDeviceId(deviceId);
  const cfg = loadLinkConfig();
  if (cfg && cfg.deviceId !== deviceId) persistLinkConfig(cfg.projectId, cfg.plan, deviceId);
  scheduleFlush();
}

// Persisted so a page reload can resume the wired link on an already-granted serial port instead
// of forcing a re-flash. Web Serial keeps granted ports across reloads (navigator.serial.getPorts),
// and reopening one needs no user gesture — so resume is silent.
const CFG_KEY = 'nff.wiredlink.v1';
// ESP32 dev boards ship a CP210x (0x10c4) or CH340 (0x1a86) USB-serial bridge; prefer one of those
// among the granted ports so we don't grab an unrelated device.
const ESP_VENDOR_IDS = new Set([0x10c4, 0x1a86, 0x0403, 0x303a]);

interface PersistedLink { projectId: string; plan: WiredLinkPlan; deviceId?: string }

export function persistLinkConfig(projectId: string, plan: WiredLinkPlan, deviceId?: string): void {
  if (deviceId) linkDeviceId = deviceId;
  uploadProjectId = projectId;   // console cloud-sync scope (device_serial_logs.project_id)
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify({ projectId, plan, deviceId }));
  } catch { /* private mode */ }
}

function loadLinkConfig(): PersistedLink | null {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    return raw ? (JSON.parse(raw) as PersistedLink) : null;
  } catch { return null; }
}

// Forget the persisted link once the device leaves the cable (cut-the-cord): the next page load
// must not resume-probe (and eventually EN-pulse) a device that now lives on WiFi.
function clearLinkConfig(): void {
  try { localStorage.removeItem(CFG_KEY); } catch { /* private mode */ }
}

// Mint a short-lived, dst-signed WS URL for the fleet /link bridge (shared with useEspFlasher).
export async function fetchBridgeUrl(projectId: string, dst: string): Promise<string> {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) throw new Error('not signed in');
  const resp = await fetch('/api/link-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ project_id: projectId, dst }),
  });
  if (!resp.ok) throw new Error(`link-token failed (${resp.status})`);
  const data = (await resp.json()) as { url?: string };
  if (!data.url) throw new Error('link-token returned no url');
  return data.url;
}

function emit(): void {
  for (const fn of listeners) fn();
}

export function subscribeLink(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getLinkState(): WiredLinkState | null {
  return state;
}

export function setLinkState(s: WiredLinkState | null): void {
  state = s;
  emit();
}

export function getLinkDeviceId(): string | null {
  return linkDeviceId;
}

export function setLinkDeviceId(id: string | null): void {
  linkDeviceId = id;
  emit();
}

// ── Device serial console ring-buffer ──────────────────────────────────────────────────────────
export function subscribeConsole(fn: () => void): () => void {
  consoleListeners.add(fn);
  return () => consoleListeners.delete(fn);
}

export function getConsoleSnapshot(): readonly string[] {
  return consoleSnapshot;
}

export function pushConsole(text: string): void {
  // Firmware sends whole formatted log lines; split on newlines and keep non-empty ones.
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  if (lines.length === 0) return;
  const next = consoleSnapshot.concat(lines);
  consoleSnapshot = next.length > CONSOLE_MAX ? next.slice(next.length - CONSOLE_MAX) : next;
  for (const fn of consoleListeners) fn();
  // Cloud sync: stamp receipt time now (the wire carries no timestamps) and batch-upload.
  const ts = new Date().toISOString();
  for (const l of lines) pending.push({ ts, seq: seqCounter++, line: l.slice(0, LINE_MAX) });
  if (pending.length > PENDING_CAP) pending = pending.slice(pending.length - PENDING_CAP);
  scheduleFlush();
}

export function clearConsole(): void {
  consoleSnapshot = [];
  for (const fn of consoleListeners) fn();
}

/** Hand a freshly-opened link to the store (closing any predecessor). */
export function adoptLink(l: WiredLink): void {
  if (link && link !== l) void link.close();
  link = l;
}

export function hasLink(): boolean {
  return link !== null;
}

export async function stopWiredLink(): Promise<void> {
  const l = link;
  link = null;
  if (l) await l.close();
  setLinkState(null);
  void flushSerialLogs();   // final drain — don't lose the tail of the session
}

// Attempt, once per page load, to resume the wired link on an already-granted ESP32 port. No-op
// if a link is already active, nothing was persisted, or no granted port matches. Safe to call
// eagerly on app mount: opening a previously-granted port needs no user gesture.
let resumeTried = false;
export async function resumeWiredLink(): Promise<void> {
  if (resumeTried || link) return;
  resumeTried = true;
  const cfg = loadLinkConfig();
  if (!cfg || typeof navigator === 'undefined' || !('serial' in navigator)) return;

  let ports: SerialPort[];
  try { ports = await navigator.serial.getPorts(); } catch { return; }
  if (ports.length === 0) return;
  const port =
    ports.find((p) => { try { return ESP_VENDOR_IDS.has(p.getInfo().usbVendorId ?? -1); } catch { return false; } })
    ?? ports[0];

  const { projectId, plan } = cfg;
  if (cfg.deviceId) linkDeviceId = cfg.deviceId;
  uploadProjectId = projectId;   // console cloud-sync scope survives the reload
  const l = new WiredLink({
    port,
    baud: plan.baud,
    hostIp: plan.hostIp,
    deviceIp: plan.deviceIp,
    brokerIp: plan.brokerIp,
    brokerPort: plan.brokerPort,
    bridgeUrl: (dst: string) => fetchBridgeUrl(projectId, dst),
    // The resumed link is otherwise invisible — no modal owns it — so a silent failure here
    // reads as "device mysteriously offline". Surface state + link events on the console in
    // dev; a stuck link then names its own failure instead of needing a bench autopsy.
    onState: (s) => {
      if (import.meta.env.DEV) console.debug('[wiredlink] state:', s);
      setLinkState(s);
    },
    onLog: (line) => { if (import.meta.env.DEV) console.debug('[wiredlink]', line); },
    onConsole: pushConsole,   // device serial console → dashboard Serial Monitor
  });
  adoptLink(l);
  setLinkState('negotiating');
  try {
    // 'probe': never EN-pulse a device that is already alive on the link — a reload/re-attach
    // must not reboot it (that was the "phantom flip" — it destroyed in-flight OTA state).
    await l.open('probe');
  } catch {
    // Port busy (mid-flash) or unplugged — drop it; a flash re-establishes the link.
    await stopWiredLink();
  }
}

/** Cut-the-cord: arm the wired device's config window, then push WiFi creds through it.
    VITE_NFF_WIFI_BROKER (host:port, e.g. "192.168.1.50:8883") is the fleet's LAN address the
    device should dial once it's on WiFi — its address must be in the fleet server cert's SANs
    (re-mint with issue_server_cert when it changes; the root-CA pin on devices is untouched). */
export async function sendWifiCredsViaLink(ssid: string, pass: string): Promise<boolean> {
  if (!link) throw new Error('no wired link is active — flash a device over USB first');
  const broker = (import.meta.env.VITE_NFF_WIFI_BROKER as string | undefined) || undefined;
  const ok = await link.sendWifiCreds(ssid, pass, broker);
  if (ok) {
    clearLinkConfig();      // no resume-probe of a device that has moved to WiFi
    await stopWiredLink();  // device is rebooting into WiFi mode; the cable job is done
  }
  return ok;
}
