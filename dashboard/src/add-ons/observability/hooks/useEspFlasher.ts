// Browser-based ESP32 flasher over the Web Serial API, powered by esptool-js.
//
// This is the zero-CLI onboarding path: the user plugs an ESP32 into USB, clicks a button,
// and Chrome writes real firmware straight to the chip — no `pip install nff`, no Arduino IDE,
// no toolchain. It flashes a static "golden" demo image described by
// `public/firmware/manifest.json` (a multi-segment layout: bootloader@0x1000, partitions@0x8000,
// boot_app0@0xe000, app@0x10000), exactly the layout arduino-cli/PlatformIO emit.
//
// After flashing it reopens the port at 115200 and streams the firmware's serial output back
// into the UI for a few seconds — a board-independent proof-of-life (the demo prints a heartbeat),
// since not every ESP32 board wires its onboard LED to the same pin.
//
// Web Serial is Chromium-desktop-only (Chrome/Edge/Opera) and needs a secure context
// (HTTPS or localhost — both satisfied here) plus a user gesture, so `flash()` MUST be called
// straight from a click handler.

import { useCallback, useRef, useState } from 'react';
import { ESPLoader, HardReset, Transport } from 'esptool-js';
import { supabase } from '../../../lib/supabase';
import { WiredLink } from '../../../lib/ppplink/index';
import type { WiredLinkPlan, WiredLinkState } from '../../../lib/ppplink/index';
import { adoptLink, fetchBridgeUrl, persistLinkConfig, pushConsole, sendWifiCredsViaLink, setLinkState, stopWiredLink } from '../../../lib/ppplink/linkStore';
import type {
  FlashFreqValues,
  FlashModeValues,
  FlashOptions,
  FlashSizeValues,
  IEspLoaderTerminal,
  LoaderOptions,
} from 'esptool-js';

// idle → requesting (port picker) → connecting (sync + stub) → writing (progress) →
// resetting (hard reset) → monitoring (read serial heartbeat) → done | error.
// `cancelled` is the benign state when the user dismisses the browser port picker.
export type FlashPhase =
  | 'idle'
  | 'requesting'
  | 'compiling'
  | 'provisioning'
  | 'connecting'
  | 'writing'
  | 'resetting'
  | 'monitoring'
  | 'done'
  | 'cancelled'
  | 'error';

interface ManifestPart {
  path: string; // relative to the app base URL, e.g. "firmware/nff-demo-blink/app.bin"
  offset: string; // hex string, e.g. "0x10000"
  size?: number;
  sha256?: string;
}

// A user-supplied value patched into the compiled image before flashing (e.g. WiFi creds).
// The firmware reserves a fixed-size buffer laid out as [8-byte magic `token`][value…]; we write
// the value at magic+8, so no recompile is needed to set per-flash values.
export interface FlashInput {
  key: string;
  label: string;
  type?: 'text' | 'password';
  token: string;
  maxLen: number;
  required?: boolean;
  placeholder?: string;
}

// A field sourced from the provisioning response (credentials_h) and patched into the image.
// `str` fields (project/batch id) come from `#define`s; `der` fields come from `uint8_t[]` arrays
// and are written as [2-byte LE length][bytes] at magic+8. `source` is the C symbol name.
export interface ProvisionField {
  kind: 'str' | 'der';
  source: string;
  token: string;
  maxLen: number;
}

// Per-user provisioning: fetch bootstrap creds for the signed-in user's project, then patch them
// in. `url` is the /api/provision-batch endpoint (overridable via VITE_NFF_DIAGNOSIS_URL).
export interface ProvisionSpec {
  url: string;
  requiresAuth?: boolean;
  map: ProvisionField[];
}

// WiredLinkPlan (manifest `link` section) lives in ppplink now (shared with linkStore's reattach
// path). Re-exported so manifest consumers keep importing it from the flasher.
export type { WiredLinkPlan };

interface FlashManifest {
  name: string;
  description?: string;
  chip: string;
  flashMode: FlashModeValues;
  flashFreq: FlashFreqValues;
  flashSize: FlashSizeValues;
  monitorBaud?: number; // baud for the post-flash serial readout (firmware-specific)
  inputs?: FlashInput[];
  provision?: ProvisionSpec;
  link?: WiredLinkPlan;
  parts: ManifestPart[];
}

// An in-memory manifest whose segment bytes are already decoded (not fetched from static URLs).
// The Code-tab "Flash (build & enroll)" path uses this: it compiles the user's repo on demand and
// hands the resulting segments straight to the flasher, reusing the same provision/patch/reseal/
// baud-ladder/monitor pipeline as the golden static image.
export interface InMemorySegment {
  data: Uint8Array;
  address: number; // flash offset, e.g. 0x10000
}
export interface InMemoryManifest {
  chip?: string;
  flashMode: FlashModeValues;
  flashFreq: FlashFreqValues;
  flashSize: FlashSizeValues;
  monitorBaud?: number;
  inputs?: FlashInput[];
  provision?: ProvisionSpec;
  link?: WiredLinkPlan;
  // Default true: wipe the whole flash (incl. NVS) so the board boots FRESH — stale NVS from a
  // prior claim otherwise comes up CLAIMED on old creds → mTLS X509 failure. Set false to keep
  // NVS (same-project re-flash relying on device-stored WiFi creds and claim state).
  eraseAll?: boolean;
  segments: InMemorySegment[];
}

// What flash() accepts as its firmware source: a static manifest URL (golden path), a ready
// in-memory manifest, or an async provider that produces one (compiled after the port is granted,
// so a long build never precedes the user-gesture-bound requestPort()).
export type FlashSource = string | InMemoryManifest | (() => Promise<InMemoryManifest>);

export interface FlashState {
  phase: FlashPhase;
  progress: number; // 0..1 across the whole image
  chip: string | null; // detected chip description, once connected
  error: string | null;
  log: string[]; // esptool-js terminal output, newest last
  serial: string; // live serial output captured from the board after flashing
  linkState: WiredLinkState | null; // wired (USB/PPPoS) link status, when the manifest has a link plan
}

// Flashing baud rates to try, fastest first. 921600 is deliberately excluded: on common
// CP210x/CH340 USB-serial bridges it corrupts the stream right after the baud switch
// ("Invalid head of packet"). 460800 is a fast-but-safe default; 115200 is the rock-solid
// fallback (no baud change at all) that works on flaky cables/bridges.
const BAUD_LADDER = [460800, 115200];

// Baud + duration for the post-flash proof-of-life serial read (the demo prints at 115200).
const MONITOR_BAUD = 115200;
const MONITOR_MS = 12000;

export interface UseEspFlasher extends FlashState {
  supported: boolean;
  flash: (source?: FlashSource, values?: Record<string, string>, opts?: { projectId?: string }) => Promise<void>;
  reset: () => void;
  /** Cut-the-cord: push WiFi creds to the wired device over serial. Requires an active wired link. */
  sendWifiCreds: (ssid: string, pass: string) => Promise<boolean>;
  /** Tear down the wired link (also happens automatically on unmount / next flash). */
  stopLink: () => Promise<void>;
}

// Naive byte-substring search over a Uint8Array.
function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return -1;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}

// Locate a slot by its 8-byte magic `token` and return the offset, or throw. Slots are laid out
// [8-byte magic][value…]; callers write at `at + 8`.
function findSlot(segments: Segment[], token: string, label: string): { seg: Segment; at: number } {
  const tokBytes = new TextEncoder().encode(token);
  for (const seg of segments) {
    const at = indexOfBytes(seg.data, tokBytes);
    if (at >= 0) return { seg, at };
  }
  throw new Error(`could not find the ${label} slot in the firmware image`);
}

// Patch a NUL-terminated string value into a slot (value at magic+8).
function patchStr(segments: Segment[], token: string, value: string, maxLen: number, label: string): void {
  const valBytes = new TextEncoder().encode(value);
  if (valBytes.length > maxLen) {
    throw new Error(`${label} is too long (max ${maxLen} bytes, got ${valBytes.length})`);
  }
  const { seg, at } = findSlot(segments, token, label);
  const base = at + 8;
  if (base + maxLen + 1 > seg.data.length) throw new Error(`patch slot for ${label} overflows the image`);
  for (let k = 0; k <= maxLen; k++) seg.data[base + k] = 0; // clear value region + NUL
  seg.data.set(valBytes, base);
}

// Patch a DER byte blob into a slot: [2-byte LE length][bytes] at magic+8. The firmware reads the
// length back at magic+8 and the bytes at magic+10.
function patchDer(segments: Segment[], token: string, bytes: Uint8Array, maxLen: number, label: string): void {
  if (!bytes || bytes.length === 0) throw new Error(`${label} missing from the provisioning response`);
  if (bytes.length > maxLen) throw new Error(`${label} is too long (${bytes.length} > ${maxLen} bytes)`);
  const { seg, at } = findSlot(segments, token, label);
  if (at + 10 + maxLen > seg.data.length) throw new Error(`patch slot for ${label} overflows the image`);
  seg.data[at + 8] = bytes.length & 0xff;
  seg.data[at + 9] = (bytes.length >> 8) & 0xff;
  seg.data.set(bytes, at + 10);
}

// Re-seal an ESP32 app image after patching. The image ends with a 1-byte XOR checksum and (when
// the header's hash_appended flag is set) a 32-byte SHA-256; the bootloader verifies BOTH. Patching
// bytes without recomputing them makes the image unbootable ("esp_image: Checksum failed" → the
// board crash-loops). This recomputes both over the patched bytes. Requires a secure context
// (crypto.subtle) — always true here since Web Serial already needs HTTPS/localhost.
async function resealEspImage(img: Uint8Array): Promise<void> {
  if (img[0] !== 0xe9) return; // not an ESP image — nothing to seal
  const segCount = img[1];
  const hashAppended = img[23] === 0x01;
  let off = 24; // 8-byte common header + 16-byte extended header
  let checksum = 0xef; // ESP checksum seed
  for (let s = 0; s < segCount; s++) {
    const len = img[off + 4] | (img[off + 5] << 8) | (img[off + 6] << 16) | (img[off + 7] << 24);
    const dataStart = off + 8;
    for (let i = 0; i < len; i++) checksum ^= img[dataStart + i];
    off = dataStart + len;
  }
  const end = hashAppended ? img.length - 32 : img.length;
  img[end - 1] = checksum & 0xff; // 1-byte checksum sits just before the (optional) hash
  if (hashAppended) {
    // Copy into a fresh ArrayBuffer-backed view (crypto.subtle.digest rejects SharedArrayBuffer-typed).
    const body = new Uint8Array(end);
    body.set(img.subarray(0, end));
    const digest = await crypto.subtle.digest('SHA-256', body);
    img.set(new Uint8Array(digest), end);
  }
}

// Parse a bootstrap credentials.h C header into { defines, arrays }. Extracts the string #defines
// (NFF_PROJECT_ID / NFF_BATCH_ID) and every `static const uint8_t NFF_..._DER[] = { 0x.., … };`.
function parseCredentialsH(text: string): { defines: Record<string, string>; arrays: Record<string, Uint8Array> } {
  const defines: Record<string, string> = {};
  for (const m of text.matchAll(/#define\s+(NFF_[A-Z0-9_]+)\s+"([^"]*)"/g)) {
    defines[m[1]] = m[2];
  }
  const arrays: Record<string, Uint8Array> = {};
  for (const m of text.matchAll(/uint8_t\s+(NFF_[A-Z0-9_]+_DER)\s*\[\]\s*=\s*\{([\s\S]*?)\}/g)) {
    const bytes = m[2].match(/0x[0-9a-fA-F]{1,2}/g)?.map((h) => parseInt(h, 16)) ?? [];
    arrays[m[1]] = new Uint8Array(bytes);
  }
  return { defines, arrays };
}


// Locate the NVS data partition in the partition-table segment (flashed at 0x8000). Entries are
// 32 bytes: [magic AA 50][type][subtype][offset u32 LE][size u32 LE][label 16B][flags u32]; the
// NVS partition is type 0x01 (data) subtype 0x02. Returns null when the table segment is absent
// or holds no NVS entry (unknown layout).
function findNvsPartition(segments: Segment[]): { offset: number; size: number } | null {
  const table = segments.find((s) => s.address === 0x8000);
  if (!table) return null;
  const d = table.data;
  for (let off = 0; off + 32 <= d.length; off += 32) {
    if (d[off] !== 0xaa || d[off + 1] !== 0x50) break; // end of entries (MD5 row / terminator)
    if (d[off + 2] === 0x01 && d[off + 3] === 0x02) {
      const pOff = d[off + 4] | (d[off + 5] << 8) | (d[off + 6] << 16) | (d[off + 7] << 24);
      const pSize = d[off + 8] | (d[off + 9] << 8) | (d[off + 10] << 16) | (d[off + 11] << 24);
      if (pOff > 0 && pSize > 0) return { offset: pOff, size: pSize };
    }
  }
  return null;
}

// Web Serial lives on `navigator.serial` in Chromium desktop browsers only.
function isSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

// Resolve a manifest-relative path against Vite's configured base URL so it works whether the
// app is served from "/" (Vercel) or a sub-path.
function assetUrl(relPath: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/$/, '')}/${relPath.replace(/^\//, '')}`;
}

interface Segment {
  data: Uint8Array;
  address: number;
}

const EMPTY: FlashState = { phase: 'idle', progress: 0, chip: null, error: null, log: [], serial: '', linkState: null };

export function useEspFlasher(): UseEspFlasher {
  const [state, setState] = useState<FlashState>(EMPTY);
  // Guard against overlapping flashes (double-clicks) without triggering a re-render.
  const busyRef = useRef(false);

  const appendLog = useCallback((line: string) => {
    setState((s) => ({ ...s, log: [...s.log, line] }));
  }, []);

  // The wired link is TAB-scoped, not component-scoped: it lives in linkStore and survives this
  // hook unmounting (the user closes the modal and roams the dashboard while wired).
  const stopLink = useCallback(async () => {
    await stopWiredLink();
    setState((s) => ({ ...s, linkState: null }));
  }, []);

  const sendWifiCreds = useCallback(async (ssid: string, pass: string) => {
    const ok = await sendWifiCredsViaLink(ssid, pass);
    if (ok) setState((s) => ({ ...s, linkState: null }));
    return ok;
  }, []);

  const reset = useCallback(() => {
    if (busyRef.current) return;
    void stopLink();
    setState(EMPTY);
  }, [stopLink]);

  const flash = useCallback(
    async (source: FlashSource = assetUrl('firmware/manifest.json'), values?: Record<string, string>, opts?: { projectId?: string; deviceId?: string }) => {
      if (busyRef.current) return;
      if (!isSupported()) {
        setState((s) => ({
          ...s,
          phase: 'error',
          error: 'Web Serial is not available. Use Chrome, Edge, or Opera on desktop.',
        }));
        return;
      }

      busyRef.current = true;
      setState({ ...EMPTY, phase: 'requesting' });

      // A terminal shim so esptool-js progress lines surface in the UI log.
      const terminal: IEspLoaderTerminal = {
        clean: () => setState((s) => ({ ...s, log: [] })),
        write: (data) => appendLog(data),
        writeLine: (data) => appendLog(data),
      };

      // 1) Ask the user to pick the serial port (requires the click gesture). Do this ONCE —
      // the granted SerialPort is reused across baud-ladder retries with no new prompt.
      let port: SerialPort;
      try {
        port = await navigator.serial.requestPort();
      } catch {
        setState((s) => ({ ...s, phase: 'cancelled' }));
        busyRef.current = false;
        return;
      }

      // A wired link (from an earlier flash or a reload-resume) holds the port; release it before
      // esptool tries to open the same port, or the connect fails with "port already open".
      await stopLink();

      try {
        // 2) Resolve the manifest + all segment bytes. A string source is the static golden path
        // (fetch the manifest JSON + each part .bin); an object/function source is an in-memory or
        // on-demand-compiled manifest whose segment bytes are already decoded. A provider function
        // runs HERE — after requestPort — so a slow build never precedes the user gesture.
        let segments: Segment[];
        let provision: ProvisionSpec | undefined;
        let inputs: FlashInput[] | undefined;
        let flashMode: FlashModeValues;
        let flashFreq: FlashFreqValues;
        let flashSize: FlashSizeValues;
        let monitorBaud: number | undefined;
        let linkPlan: WiredLinkPlan | undefined;
        let eraseAll = true;

        if (typeof source === 'string') {
          const manifestResp = await fetch(source);
          let manifest: FlashManifest;
          try {
            if (!manifestResp.ok) throw new Error(String(manifestResp.status));
            manifest = (await manifestResp.json()) as FlashManifest;
            if (!Array.isArray(manifest.parts) || manifest.parts.length === 0) throw new Error('no parts');
          } catch {
            throw new Error('Firmware manifest not found or invalid on this dashboard.');
          }
          segments = await Promise.all(
            manifest.parts.map(async (part) => {
              const buf = await (await fetch(assetUrl(part.path))).arrayBuffer();
              return { data: new Uint8Array(buf), address: parseInt(part.offset, 16) };
            }),
          );
          provision = manifest.provision;
          inputs = manifest.inputs;
          flashMode = manifest.flashMode;
          flashFreq = manifest.flashFreq;
          flashSize = manifest.flashSize;
          monitorBaud = manifest.monitorBaud;
          linkPlan = manifest.link;
        } else {
          setState((s) => ({ ...s, phase: 'compiling' }));
          const m = typeof source === 'function' ? await source() : source;
          if (!Array.isArray(m.segments) || m.segments.length === 0) {
            throw new Error('no firmware segments to flash');
          }
          segments = m.segments.map((seg) => ({ data: seg.data, address: seg.address }));
          provision = m.provision;
          inputs = m.inputs;
          flashMode = m.flashMode;
          flashFreq = m.flashFreq;
          flashSize = m.flashSize;
          monitorBaud = m.monitorBaud;
          linkPlan = m.link;
          eraseAll = m.eraseAll ?? true;
        }

        // Fresh-NVS fast path: a full-chip erase guarantees the board boots FRESH (no stale claim
        // creds in NVS) but costs 10-30s on a 4MB part before anything is written. Writing an
        // all-0xFF (erased-state) blank over just the NVS partition gives the identical outcome —
        // esptool erases exactly the sectors it writes — in well under a second. Only when the
        // partition table can't be parsed (unknown layout, can't target NVS) do we fall back to
        // the slow whole-chip erase.
        let fullChipErase = false;
        if (eraseAll) {
          const nvs = findNvsPartition(segments);
          if (nvs && !segments.some((s) => s.address === nvs.offset)) {
            segments.push({ data: new Uint8Array(nvs.size).fill(0xff), address: nvs.offset });
            segments.sort((a, b) => a.address - b.address);
          } else if (!nvs) {
            fullChipErase = true;
          }
        }

        const grandTotal = segments.reduce((n, seg) => n + seg.data.length, 0);
        // Bytes in all segments *before* index i — lets us map per-file progress to overall.
        const priorBytes: number[] = [];
        segments.reduce((acc, seg, i) => {
          priorBytes[i] = acc;
          return acc + seg.data.length;
        }, 0);

        // Per-user provisioning: mint bootstrap creds for the signed-in user's project and patch
        // them in. The port is already granted, so awaits here are safe.
        if (provision) {
          setState((s) => ({ ...s, phase: 'provisioning' }));
          const { data: sess } = await supabase.auth.getSession();
          const token = sess.session?.access_token;
          if (!token) {
            throw new Error('Please sign in first — this firmware provisions a device to your account.');
          }
          if (!opts?.projectId) throw new Error('No project selected — open a project first.');
          const resp = await fetch(provision.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ project_id: opts.projectId }),
          });
          if (!resp.ok) {
            const detail = await resp.text().catch(() => '');
            throw new Error(`Provisioning failed (${resp.status}). ${detail.slice(0, 200)}`);
          }
          const data = (await resp.json()) as { credentials_h?: string };
          if (!data.credentials_h) throw new Error('Provisioning returned no credentials.');
          const parsed = parseCredentialsH(data.credentials_h);
          for (const f of provision.map) {
            if (f.kind === 'str') {
              const v = parsed.defines[f.source];
              if (v === undefined) throw new Error(`${f.source} missing from the provisioning response`);
              patchStr(segments, f.token, v, f.maxLen, f.source);
            } else {
              patchDer(segments, f.token, parsed.arrays[f.source], f.maxLen, f.source);
            }
          }
        }

        // Patch user-supplied inputs (e.g. WiFi creds) into the image bytes before flashing.
        for (const input of inputs ?? []) {
          const value = values?.[input.key] ?? '';
          if (input.required && !value) throw new Error(`${input.label} is required`);
          if (value) patchStr(segments, input.token, value, input.maxLen, input.label);
        }

        // Patching the app image (slots live in the app partition at 0x10000) broke its checksum +
        // SHA-256; re-seal it so the bootloader accepts it. Without this the board crash-loops.
        if (provision || (inputs && inputs.length > 0)) {
          const app = segments.find((s) => s.address === 0x10000);
          if (app) await resealEspImage(app.data);
        }

        // One connect+write+reset attempt at a given baud. Throws on any failure.
        let macDeviceId: string | undefined;
        const attempt = async (baud: number): Promise<void> => {
          let transport: Transport | null = null;
          try {
            transport = new Transport(port, false);
            const loaderOpts: LoaderOptions = { transport, baudrate: baud, terminal };
            const loader = new ESPLoader(loaderOpts);
            setState((s) => ({ ...s, phase: 'connecting', progress: 0, error: null }));
            const chip = await loader.main();
            // Device id = chip MAC without separators (the fleet's hwid convention). Known BEFORE
            // enrollment, so the console cloud-sync attributes lines from the very first boot —
            // and on resumed links, where the claim UPDATE that would late-bind it already fired
            // in some long-gone session and will never fire again.
            try {
              macDeviceId = (await loader.chip.readMac(loader)).replace(/[^0-9a-f]/gi, '').toLowerCase() || undefined;
            } catch { /* best-effort — enrollment claim still late-binds via attachLinkDevice */ }
            setState((s) => ({ ...s, chip, phase: 'writing', progress: 0 }));

            const flashOpts: FlashOptions = {
              fileArray: segments,
              flashMode,
              flashFreq,
              flashSize,
              // Fresh-NVS is normally achieved by the blank-NVS segment appended above (fast);
              // a whole-chip erase only happens when the partition table was unparseable. An
              // in-memory manifest with eraseAll:false skips both, preserving device-stored WiFi
              // creds + claim state on a same-project re-flash.
              eraseAll: fullChipErase,
              compress: true,
              // esptool-js reports `written`/`total` in COMPRESSED bytes (compress:true), but our
              // priorBytes/grandTotal are UNCOMPRESSED segment sizes. Mixing them made the bar lag
              // the log's per-file percentage (bar ~60% while the log said ~80%, since the app image
              // compresses to ~60%). Convert to a per-file fraction, then weight by the segment's
              // uncompressed size so the bar tracks the log text.
              reportProgress: (fileIndex, written, total) => {
                const frac = total > 0 ? written / total : 0;
                const done = priorBytes[fileIndex] + frac * segments[fileIndex].data.length;
                setState((s) => ({ ...s, progress: Math.min(1, done / grandTotal) }));
              },
            };
            await loader.writeFlash(flashOpts);

            // Hard-reset so the freshly-flashed app boots.
            setState((s) => ({ ...s, phase: 'resetting', progress: 1 }));
            await new HardReset(transport).reset();
          } finally {
            // Release the port between attempts (and before the serial monitor) so the next
            // open — or a serial monitor — can claim it.
            try {
              await transport?.disconnect();
            } catch {
              /* already closed */
            }
          }
        };

        // 3) Walk the baud ladder: fast first, fall back to a safer speed on serial corruption.
        let lastErr: unknown = null;
        let flashed = false;
        for (let i = 0; i < BAUD_LADDER.length; i++) {
          const baud = BAUD_LADDER[i];
          try {
            if (i > 0) appendLog(`\n⚠ Retrying at ${baud} baud (safer speed)…\n`);
            await attempt(baud);
            flashed = true;
            break; // success
          } catch (err) {
            lastErr = err;
          }
        }

        if (!flashed) {
          const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
          setState((s) => ({ ...s, phase: 'error', error: message }));
          return;
        }

        if (linkPlan) {
          // 4a) Wired path: the port becomes the device's network. Bring up the browser PPP end
          // and keep it running — this tab IS the device's uplink until cut-the-cord (or close).
          if (!opts?.projectId) throw new Error('No project selected — the wired link needs a project.');
          const projectId = opts.projectId;
          await stopLink(); // a previous link from an earlier flash would hold the port
          // Persist so a page reload can silently resume this link on the granted port (no reflash).
          // deviceId preference: explicit caller > chip MAC read during flash > enrollment-claim
          // late-bind (attachLinkDevice). The MAC path is what makes console cloud-sync work for
          // an ALREADY-claimed board, whose claim event predates this tab.
          persistLinkConfig(projectId, linkPlan, opts?.deviceId ?? macDeviceId);
          const link = new WiredLink({
            port,
            baud: linkPlan.baud,
            hostIp: linkPlan.hostIp,
            deviceIp: linkPlan.deviceIp,
            brokerIp: linkPlan.brokerIp,
            brokerPort: linkPlan.brokerPort,
            bridgeUrl: (dst: string) => fetchBridgeUrl(projectId, dst),
            onState: (linkState) => {
              setLinkState(linkState);                       // tab-wide observers (badge, cut-the-cord)
              setState((s) => ({ ...s, linkState }));        // this modal's own view
            },
            onLog: appendLog,
            onConsole: pushConsole,   // device serial console → dashboard Serial Monitor
          });
          adoptLink(link);
          setState((s) => ({ ...s, phase: 'done', progress: 1, linkState: 'negotiating' }));
          setLinkState('negotiating');
          // 'always': esptool just reset the chip and closed the port — a deliberate EN pulse
          // beats the DTR/RTS reopen coin flip here (nothing in-flight to preserve post-flash).
          await link.open('always');
        } else {
          // 4b) Proof-of-life: reopen the port and stream the firmware's serial output for a few
          // seconds. Board-independent — works even if the onboard LED isn't on the demo's pin.
          setState((s) => ({ ...s, phase: 'monitoring', progress: 1 }));
          await monitorSerial(port, MONITOR_MS, monitorBaud ?? MONITOR_BAUD, (chunk) =>
            setState((s) => ({ ...s, serial: (s.serial + chunk).slice(-4000) })),
          );
          setState((s) => ({ ...s, phase: 'done', progress: 1 }));
        }
      } catch (err) {
        // Manifest/segment load or other setup failure.
        const message = err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, phase: 'error', error: message }));
      } finally {
        busyRef.current = false;
      }
    },
    [appendLog, stopLink],
  );

  return { ...state, supported: isSupported(), flash, reset, sendWifiCreds, stopLink };
}

// Reopen an already-granted SerialPort at 115200 and stream decoded text to `onChunk` for up to
// `ms` milliseconds, then close it. Best-effort: any error just ends the read quietly (the flash
// already succeeded — this is only a nice-to-have liveness readout).
async function monitorSerial(port: SerialPort, ms: number, baud: number, onChunk: (text: string) => void): Promise<void> {
  try {
    await port.open({ baudRate: baud });
  } catch {
    return; // port still releasing, or unavailable — skip the readout
  }
  const decoder = new TextDecoder();
  const stream = port.readable;
  if (!stream) {
    try { await port.close(); } catch { /* noop */ }
    return;
  }
  const reader = stream.getReader();
  // A timer cancels the reader so a silent board doesn't hang the read forever.
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, ms);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) onChunk(decoder.decode(value));
    }
  } catch {
    /* cancelled or read error — done */
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch { /* noop */ }
    try { await port.close(); } catch { /* noop */ }
  }
}
