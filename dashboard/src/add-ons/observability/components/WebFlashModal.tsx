import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useEspFlasher } from '../hooks/useEspFlasher';
import type { FlashInput } from '../hooks/useEspFlasher';
import { supabase } from '../../../lib/supabase';
import { BRAND_ACCENT } from '../../../lib/brand';

interface Props {
  onClose: () => void;
  projectId?: string; // current project — the device is provisioned into it (real nff firmware)
}

// Styles mirror EnrollDeviceModal's brutalist monospace look for visual consistency.
const btnPrimary: React.CSSProperties = {
  fontSize: 12, fontWeight: 'bold',
  border: '1px solid #000', background: BRAND_ACCENT, color: '#fff', cursor: 'pointer', padding: '6px 14px',
};
const btnSecondary: React.CSSProperties = { ...btnPrimary, background: '#fff', color: '#000', fontWeight: 'normal' };
const btnDisabled: React.CSSProperties = { ...btnPrimary, background: '#888', borderColor: '#888', cursor: 'default' };
const hint: React.CSSProperties = { marginTop: 8, fontSize: 11.5, color: '#666', lineHeight: 1.55 };

const PHASE_LABEL: Record<string, string> = {
  idle: '',
  requesting: 'Waiting for you to pick the device…',
  provisioning: 'Provisioning your device to your project…',
  connecting: 'Connecting to the chip…',
  writing: 'Writing firmware…',
  resetting: 'Rebooting the board…',
  monitoring: 'Listening to your board…',
  done: 'Done',
  cancelled: 'Cancelled',
  error: 'Flash failed',
};

interface FirmwareEntry {
  id: string;
  name: string;
  manifest: string; // path relative to BASE_URL, e.g. "firmware/manifest.json"
  blurb?: string;
  local?: boolean;
  inputs?: FlashInput[]; // user-supplied values patched into the image (e.g. WiFi creds)
  requiresAuth?: boolean; // firmware provisions a device to the signed-in user's project
}

const inputStyle: React.CSSProperties = {
  fontSize: 12, width: '100%', boxSizing: 'border-box',
  border: '1px solid #000', padding: '5px 7px', background: '#fff',
};

// Resolve a public-asset path against Vite's base URL (works at "/" or a sub-path).
function assetUrl(rel: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/$/, '')}/${rel.replace(/^\//, '')}`;
}

// One-click ESP32 flasher: writes a selected firmware to a USB-connected board over Web Serial.
// Firmwares come from firmware/index.json; locally-built entries (e.g. real nff firmware) only
// appear when their manifest actually resolves, so committed/prod builds show just the demo.
export function WebFlashModal({ onClose, projectId }: Props) {
  const f = useEspFlasher();
  const [firmwares, setFirmwares] = useState<FirmwareEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [values, setValues] = useState<Record<string, string>>({});
  const logBoxRef = useRef<HTMLDivElement>(null);

  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  const busy = f.phase === 'requesting' || f.phase === 'provisioning' || f.phase === 'connecting' || f.phase === 'writing' || f.phase === 'resetting' || f.phase === 'monitoring';
  const selected = firmwares.find((e) => e.id === selectedId);
  const missingRequired = (selected?.inputs ?? []).some((inp) => inp.required && !values[inp.key]?.trim());
  const needsSignIn = !!selected?.requiresAuth && signedIn === false;

  // Is there a Supabase session? (Firmware that provisions to the user's project needs one.)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSignedIn(!!data.session)).catch(() => setSignedIn(false));
  }, []);

  // Load the firmware catalog, then keep only entries whose manifest actually resolves.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let entries: FirmwareEntry[] = [];
      try {
        const idx = await (await fetch(assetUrl('firmware/index.json'))).json();
        if (Array.isArray(idx?.firmwares)) entries = idx.firmwares as FirmwareEntry[];
      } catch { /* fall through to the default below */ }
      if (entries.length === 0) {
        entries = [{ id: 'demo-blink', name: 'Demo blink', manifest: 'firmware/manifest.json' }];
      }
      // Availability probe: the manifest must be REAL JSON with a parts[] array. A plain
      // `.ok` check is not enough — a host that doesn't serve the file (hosted/prod dashboard,
      // where _local/ is gitignored) returns the SPA index.html with a 200, which would sneak
      // a local-only firmware into the list and then fail at flash time. Parsing weeds that out.
      const available: FirmwareEntry[] = [];
      await Promise.all(
        entries.map(async (e) => {
          try {
            const r = await fetch(assetUrl(e.manifest));
            if (!r.ok) return;
            const m = await r.json();
            if (Array.isArray(m?.parts) && m.parts.length > 0) {
              available.push({ ...e, inputs: m.inputs as FlashInput[] | undefined, requiresAuth: !!m.provision?.requiresAuth });
            }
          } catch { /* unavailable on this host — skip */ }
        }),
      );
      if (cancelled) return;
      setFirmwares(available);
      // Prefer the wired (zero-config USB) image, then the WiFi real firmware, else first available.
      const def = available.find((e) => e.id === 'nff-real-wired')
        ?? available.find((e) => e.id === 'nff-real')
        ?? available[0];
      setSelectedId(def ? def.id : '');
    })();
    return () => { cancelled = true; };
  }, []);

  // Close on Escape, but never mid-flash (would abandon the open serial port).
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !busy) onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  // Keep the log scrolled to the newest line.
  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [f.log]);

  const pct = Math.round(f.progress * 100);

  return (
    <div
      onClick={() => { if (!busy) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520, maxWidth: '94vw', maxHeight: '86vh', overflowY: 'auto',
          background: '#fff', border: '1.5px solid #000', boxShadow: '4px 4px 0 #000',
          display: 'flex', flexDirection: 'column', fontSize: 13,
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '7px 12px', borderBottom: '1px solid #000', background: BRAND_ACCENT, color: '#fff',
          position: 'sticky', top: 0,
        }}>
          <strong style={{ letterSpacing: 0.3 }}>⚡ Flash your ESP32 over USB</strong>
          <button
            onClick={() => { if (!busy) onClose(); }}
            aria-label="Close"
            disabled={busy}
            style={{
              background: 'none', border: 'none', color: '#fff',
              cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.4 : 1,
              fontSize: 16, lineHeight: 1, padding: '0 2px',
            }}
          >×</button>
        </div>

        <div style={{ padding: '14px 16px' }}>
          {!f.supported ? (
            // Web Serial is Chromium-desktop only.
            <div>
              <p style={{ marginTop: 0, lineHeight: 1.6 }}>
                Flashing over USB needs the <b>Web Serial API</b>, which is only available in{' '}
                <b>Chrome, Edge, or Opera on desktop</b>.
              </p>
              <p style={hint}>
                Open this dashboard in one of those browsers, or use the CLI path
                (<code>nff flash</code>) instead.
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                <button onClick={onClose} style={btnSecondary}>Close</button>
              </div>
            </div>
          ) : (
            <div>
              <p style={{ marginTop: 0, marginBottom: 12, color: '#444', lineHeight: 1.6 }}>
                Plug an ESP32 into a USB port and click <b>Flash</b>. Your browser writes real
                firmware straight to the chip — no install, no CLI. When it finishes, the board
                reboots and the onboard LED starts blinking.
              </p>

              {/* Firmware selector — only lists entries whose manifest resolves, so the real nff
                  firmware appears only once it's been built locally. */}
              {firmwares.length > 1 ? (
                <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {firmwares.map((fw) => (
                    <label key={fw.id} style={{
                      display: 'flex', gap: 8, alignItems: 'flex-start', cursor: busy ? 'default' : 'pointer',
                      border: '1px solid', borderColor: fw.id === selectedId ? '#000' : '#ddd',
                      background: fw.id === selectedId ? '#f4f4f4' : '#fff', padding: '7px 9px',
                    }}>
                      <input
                        type="radio" name="fw" checked={fw.id === selectedId} disabled={busy}
                        onChange={() => setSelectedId(fw.id)} style={{ marginTop: 2 }}
                      />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ fontWeight: 'bold' }}>{fw.name}</span>
                        {fw.local && (
                          <span style={{ fontSize: 10, marginLeft: 6, padding: '1px 4px', border: '1px solid #999', color: '#666' }}>LOCAL</span>
                        )}
                        {fw.blurb && (
                          <span style={{ display: 'block', fontSize: 11.5, color: '#666', marginTop: 2, lineHeight: 1.5 }}>{fw.blurb}</span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              ) : selected ? (
                <div style={{ border: '1px solid #ddd', background: '#fafafa', padding: '8px 10px', marginBottom: 12 }}>
                  <div style={{ fontWeight: 'bold' }}>{selected.name}</div>
                  {selected.blurb && (
                    <div style={{ fontSize: 11.5, color: '#666', marginTop: 3, lineHeight: 1.5 }}>{selected.blurb}</div>
                  )}
                </div>
              ) : null}

              {/* Primary action / result states */}
              {f.phase === 'done' ? (
                <div style={{
                  border: '1.5px solid #000', background: '#eaffea', padding: '10px 12px',
                  display: 'flex', flexDirection: 'column', gap: 6,
                }}>
                  <div style={{ fontWeight: 'bold' }}>Done — flashed straight from your browser ✨</div>
                  <div style={{ fontSize: 11.5, color: '#555', lineHeight: 1.5 }}>
                    {f.chip ? `Flashed ${f.chip}. ` : ''}
                    {f.linkState
                      ? <>Its network now runs <b>through this tab</b> over the USB cable — no WiFi needed. Watch the dashboard: the device should come <b>online</b> in your fleet.</>
                      : selected?.id === 'nff-real'
                        ? <>It rebooted into the real nff firmware — watch the serial below for <b>state=CONNECTED</b>, then check the dashboard: your device should come <b>online</b>.</>
                        : <>It rebooted into the new firmware. An LED should be blinking, and the live serial below is its heartbeat — proof it's running.</>}
                  </div>
                  {f.linkState && (
                    <div style={{
                      border: '1px solid #000', background: '#fffbe6', padding: '6px 9px',
                      fontSize: 11.5, lineHeight: 1.5,
                    }}>
                      🔌 <b>Wired via this tab</b> — {
                        f.linkState === 'negotiating' ? 'bringing up the USB network link…'
                        : f.linkState === 'link-up' ? 'link up, device is connecting to the fleet…'
                        : f.linkState === 'tunneled' ? 'device traffic flowing — it should be online.'
                        : f.linkState === 'handoff' ? 'switching the device to WiFi…'
                        : f.linkState}
                      {' '}Keep this tab open (and the board plugged in). You can close this window —
                      the link stays up. Later, the <b>cut-the-cord</b> onboarding step moves it to WiFi.
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {/* Per-flash inputs (e.g. WiFi creds) — patched into the image before flashing. */}
                  {selected?.inputs && selected.inputs.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      {selected.inputs.map((inp) => (
                        <div key={inp.key} style={{ marginBottom: 8 }}>
                          <label style={{ display: 'block', fontSize: 11.5, fontWeight: 'bold', marginBottom: 3 }}>
                            {inp.label}{inp.required && <span style={{ color: '#b00' }}> *</span>}
                          </label>
                          <input
                            type={inp.type === 'password' ? 'password' : 'text'}
                            value={values[inp.key] ?? ''}
                            placeholder={inp.placeholder}
                            maxLength={inp.maxLen}
                            disabled={busy}
                            autoComplete="off"
                            onChange={(e) => setValues((v) => ({ ...v, [inp.key]: e.target.value }))}
                            style={inputStyle}
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  {needsSignIn && (
                    <div style={{
                      marginBottom: 10, border: '1px solid #000', background: '#fffbe6',
                      padding: '8px 10px', fontSize: 11.5, lineHeight: 1.5,
                    }}>
                      <b>Sign in to flash.</b> This firmware provisions a device to your project — sign in to the dashboard first.
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      onClick={() => void f.flash(selected ? assetUrl(selected.manifest) : undefined, values, { projectId })}
                      disabled={busy || !selected || missingRequired || needsSignIn}
                      style={busy || !selected || missingRequired || needsSignIn ? btnDisabled : btnPrimary}
                    >
                      {busy ? 'Flashing…' : f.phase === 'error' || f.phase === 'cancelled' ? 'Try again' : 'Flash my ESP32'}
                    </button>
                    {(f.phase !== 'idle') && (
                      <span style={{ fontSize: 12, color: f.phase === 'error' ? '#b00' : '#333' }}>
                        {PHASE_LABEL[f.phase]}{f.phase === 'writing' ? ` ${pct}%` : ''}
                        {f.phase === 'connecting' && f.chip ? ` (${f.chip})` : ''}
                      </span>
                    )}
                  </div>

                  {/* Progress bar */}
                  {(f.phase === 'writing' || f.phase === 'resetting') && (
                    <div style={{
                      marginTop: 10, height: 14, border: '1px solid #000', background: '#fff', overflow: 'hidden',
                    }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: '#000', transition: 'width 0.15s' }} />
                    </div>
                  )}

                  {f.phase === 'error' && f.error && (
                    <div style={{
                      marginTop: 10, border: '1px solid #b00', background: '#fff0f0',
                      padding: '8px 10px', color: '#900', fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'pre-wrap',
                    }}>
                      {f.error}
                    </div>
                  )}
                </>
              )}

              {/* Live esptool log */}
              {f.log.length > 0 && (
                <div
                  ref={logBoxRef}
                  style={{
                    marginTop: 12, maxHeight: 120, overflowY: 'auto',
                    background: '#111', color: '#7CFC7C', fontSize: 11, lineHeight: 1.45,
                    padding: '7px 9px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}
                >
                  {f.log.join('')}
                </div>
              )}

              {/* Live serial heartbeat from the freshly-flashed board — board-independent
                  proof-of-life (works even if the LED isn't on GPIO 2). */}
              {(f.phase === 'monitoring' || f.serial) && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 'bold', marginBottom: 4 }}>
                    📟 Live serial from your board{f.phase === 'monitoring' ? ' — listening…' : ''}
                  </div>
                  <div style={{
                    maxHeight: 110, overflowY: 'auto',
                    background: '#001a00', color: '#7CFC7C', fontSize: 11, lineHeight: 1.45,
                    padding: '7px 9px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    border: '1px solid #0a0',
                  }}>
                    {f.serial || 'Waiting for the board to speak…'}
                  </div>
                </div>
              )}

              <div style={hint}>
                Tip: close any serial monitor or IDE holding the port first. If the chip isn't
                detected, hold the board's <b>BOOT</b> button while you click Flash, then release.
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                {f.phase === 'done' && (
                  <button onClick={f.reset} style={btnSecondary}>Flash another</button>
                )}
                <button onClick={onClose} disabled={busy} style={busy ? btnDisabled : btnPrimary}>
                  {f.phase === 'done' ? 'Close' : 'Done'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
