import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useEspFlasher } from '../../add-ons/observability/hooks/useEspFlasher';
import type { FlashInput, InMemoryManifest, ProvisionSpec } from '../../add-ons/observability/hooks/useEspFlasher';
import { supabase } from '../../lib/supabase';
import { BRAND_ACCENT } from '../../lib/brand';

// The Code-tab "Flash (build & enroll)" flow: compile the project's CONNECTED REPO firmware
// (production-branch HEAD) on demand, inject the nff enrollment machinery server-side, and flash
// the result to a USB ESP32 — so the device runs the user's OWN code AND joins their fleet. This
// is the sibling of WebFlashModal (which flashes the static golden image); it reuses the same
// useEspFlasher pipeline via an in-memory manifest whose segments come from /api/compile-flash.

interface Props {
  onClose: () => void;
  projectId: string;
  repoFullName: string;
  productionBranch: string;
}

// Styles mirror WebFlashModal's brutalist monospace look.
const btnPrimary: React.CSSProperties = {
  fontSize: 12, fontWeight: 'bold',
  border: '1px solid #000', background: BRAND_ACCENT, color: '#fff', cursor: 'pointer', padding: '6px 14px',
};
const btnSecondary: React.CSSProperties = { ...btnPrimary, background: '#fff', color: '#000', fontWeight: 'normal' };
const btnDisabled: React.CSSProperties = { ...btnPrimary, background: '#888', borderColor: '#888', cursor: 'default' };
const hint: React.CSSProperties = { marginTop: 8, fontSize: 11.5, color: '#666', lineHeight: 1.55 };
const inputStyle: React.CSSProperties = {
  fontSize: 12, width: '100%', boxSizing: 'border-box',
  border: '1px solid #000', padding: '5px 7px', background: '#fff',
};

const PHASE_LABEL: Record<string, string> = {
  idle: '',
  requesting: 'Waiting for you to pick the device…',
  compiling: 'Building your firmware (this can take a minute)…',
  provisioning: 'Provisioning your device to your project…',
  connecting: 'Connecting to the chip…',
  writing: 'Writing firmware…',
  resetting: 'Rebooting the board…',
  monitoring: 'Listening to your board…',
  done: 'Done',
  cancelled: 'Cancelled',
  error: 'Flash failed',
};

// WiFi inputs the browser patches into the compiled image (same magic tokens the golden image
// uses). Optional since the sidecar resolves creds NVS-first: a board that was onboarded over
// USB (cut-the-cord) — or that ever connected once — already has creds stored on-device, and a
// blank flash preserves them (eraseAll:false below).
const WIFI_INPUTS: FlashInput[] = [
  { key: 'ssid', label: 'WiFi network (SSID)', type: 'text', token: 'NFFxSSID', maxLen: 32, required: false, placeholder: 'your-wifi-name' },
  { key: 'pass', label: 'WiFi password', type: 'password', token: 'NFFxPASS', maxLen: 64, required: false, placeholder: 'leave blank for open networks' },
];

// The golden bootstrap provision map: each C symbol in the credentials.h → its magic slot + maxLen.
// The injected enrollment slots (nff-github inject.py) are byte-identical to the golden layout, so
// this map patches a compiled-from-source image exactly as it patches the golden one.
const PROVISION_SPEC: ProvisionSpec = {
  url: '/api/provision',
  requiresAuth: true,
  map: [
    { kind: 'str', source: 'NFF_PROJECT_ID', token: 'NFFxPROJ', maxLen: 36 },
    { kind: 'str', source: 'NFF_BATCH_ID', token: 'NFFxBTCH', maxLen: 36 },
    { kind: 'der', source: 'NFF_CLIENT_CERT_DER', token: 'NFFxCERT', maxLen: 640 },
    { kind: 'der', source: 'NFF_INTERMEDIATE_CERT_DER', token: 'NFFxICRT', maxLen: 640 },
    { kind: 'der', source: 'NFF_CLIENT_KEY_DER', token: 'NFFxCKEY', maxLen: 160 },
    { kind: 'der', source: 'NFF_CA_CERT_DER', token: 'NFFxCACT', maxLen: 640 },
    { kind: 'der', source: 'NFF_ROLLOVER_VERIFY_KEY_DER', token: 'NFFxVKEY', maxLen: 80 },
  ],
};

function assetUrl(rel: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/$/, '')}/${rel.replace(/^\//, '')}`;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface CompileSegment { name: string; offset: string; b64: string }
interface CompileResult { ok: boolean; error?: string; segments?: CompileSegment[]; commit_sha?: string; logs?: string }

export function FlashCodeModal({ onClose, projectId, repoFullName, productionBranch }: Props) {
  const f = useEspFlasher();
  const [values, setValues] = useState<Record<string, string>>({});
  const logBoxRef = useRef<HTMLDivElement>(null);

  const busy = f.phase === 'requesting' || f.phase === 'compiling' || f.phase === 'provisioning'
    || f.phase === 'connecting' || f.phase === 'writing' || f.phase === 'resetting' || f.phase === 'monitoring';
  const missingRequired = WIFI_INPUTS.some((inp) => inp.required && !values[inp.key]?.trim());

  // Close on Escape, but never mid-flash (would abandon the open serial port).
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !busy) onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [f.log]);

  // Compile provider: POST /api/compile-flash, read the ndjson terminal line, decode the segments,
  // and append boot_app0 (a platform constant) from the static golden asset. Runs AFTER the port is
  // granted (useEspFlasher calls it in the 'compiling' phase), so a slow build never blocks the
  // user-gesture-bound port picker.
  async function compileProvider(): Promise<InMemoryManifest> {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) throw new Error('Please sign in first — this flashes into your project.');
    const resp = await fetch('/api/compile-flash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ project_id: projectId, repo_full_name: repoFullName, production_branch: productionBranch }),
    });
    if (!resp.ok) {
      const err = (await resp.json().catch(() => null)) as { error?: string } | null;
      throw new Error(err?.error ?? `Build request failed (${resp.status}).`);
    }
    // ndjson: keepalive lines then a terminal result line — take the last parseable line.
    const text = await resp.text();
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    let result: CompileResult | undefined;
    for (const l of lines) {
      try {
        const obj = JSON.parse(l);
        if (obj && obj.keepalive) continue;
        result = obj as CompileResult;
      } catch { /* ignore partial/non-JSON lines */ }
    }
    if (!result) throw new Error('Build returned no result.');
    if (!result.ok) throw new Error(result.error ?? 'Build failed.');
    const segments = (result.segments ?? []).map((s) => ({ data: b64ToBytes(s.b64), address: parseInt(s.offset, 16) }));
    if (segments.length === 0) throw new Error('Build produced no flashable segments.');
    // boot_app0@0xe000 is a toolchain constant — reuse the committed golden copy.
    const bootApp0 = await (await fetch(assetUrl('firmware/nff-onboard/boot_app0.bin'))).arrayBuffer();
    segments.push({ data: new Uint8Array(bootApp0), address: 0xe000 });
    // Blank WiFi = "use the creds already stored on the device": keep NVS by skipping the full
    // erase, so wifi_ssid/wifi_pass (and same-project claim state) survive the re-flash.
    const blankWifi = !values.ssid?.trim();
    return {
      chip: 'esp32', flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep', monitorBaud: 115200,
      inputs: WIFI_INPUTS, provision: PROVISION_SPEC, segments, eraseAll: !blankWifi,
    };
  }

  const pct = Math.round(f.progress * 100);

  return (
    <div
      onClick={() => { if (!busy) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
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
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '7px 12px', borderBottom: '1px solid #000', background: BRAND_ACCENT, color: '#fff',
          position: 'sticky', top: 0,
        }}>
          <strong style={{ letterSpacing: 0.3 }}>⚡ Flash your firmware over USB</strong>
          <button
            onClick={() => { if (!busy) onClose(); }}
            aria-label="Close"
            disabled={busy}
            style={{
              background: 'none', border: 'none', color: '#fff',
              cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.4 : 1, fontSize: 16, lineHeight: 1, padding: '0 2px',
            }}
          >×</button>
        </div>

        <div style={{ padding: '14px 16px' }}>
          {!f.supported ? (
            <div>
              <p style={{ marginTop: 0, lineHeight: 1.6 }}>
                Flashing over USB needs the <b>Web Serial API</b>, available only in{' '}
                <b>Chrome, Edge, or Opera on desktop</b>.
              </p>
              <p style={hint}>Open this dashboard in one of those browsers, or use <code>nff flash</code> from the CLI.</p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                <button onClick={onClose} style={btnSecondary}>Close</button>
              </div>
            </div>
          ) : (
            <div>
              <p style={{ marginTop: 0, marginBottom: 12, color: '#444', lineHeight: 1.6 }}>
                This builds <b>{repoFullName}</b>@<b>{productionBranch}</b> and flashes it straight to
                your ESP32 over USB. Your firmware is compiled with nff enrollment injected, so on boot
                the device <b>joins your fleet</b> and runs your code.
              </p>

              {f.phase === 'done' ? (
                <div style={{
                  border: '1.5px solid #000', background: '#eaffea', padding: '10px 12px',
                  display: 'flex', flexDirection: 'column', gap: 6,
                }}>
                  <div style={{ fontWeight: 'bold' }}>Done — built &amp; flashed from your browser ✨</div>
                  <div style={{ fontSize: 11.5, color: '#555', lineHeight: 1.5 }}>
                    {f.chip ? `Flashed ${f.chip}. ` : ''}
                    It rebooted into your firmware — watch the serial below for enrollment, then check the
                    dashboard: your device should come <b>online</b> in this project.
                  </div>
                </div>
              ) : (
                <>
                  <details style={{ marginBottom: 12, border: '1px solid #ddd', padding: '6px 9px' }}>
                    <summary style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 'bold' }}>
                      WiFi settings (optional)
                    </summary>
                    <div style={{ fontSize: 11, color: '#666', margin: '6px 0 8px', lineHeight: 1.5 }}>
                      Leave blank if this board was onboarded over USB or has connected before — its
                      WiFi credentials are stored on the device and a blank flash keeps them.
                    </div>
                    {WIFI_INPUTS.map((inp) => (
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
                  </details>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      onClick={() => void f.flash(compileProvider, values, { projectId })}
                      disabled={busy || missingRequired}
                      style={busy || missingRequired ? btnDisabled : btnPrimary}
                    >
                      {busy ? 'Working…' : f.phase === 'error' || f.phase === 'cancelled' ? 'Try again' : 'Build & flash'}
                    </button>
                    {(f.phase !== 'idle') && (
                      <span style={{ fontSize: 12, color: f.phase === 'error' ? '#b00' : '#333' }}>
                        {PHASE_LABEL[f.phase]}{f.phase === 'writing' ? ` ${pct}%` : ''}
                        {f.phase === 'connecting' && f.chip ? ` (${f.chip})` : ''}
                      </span>
                    )}
                  </div>

                  {(f.phase === 'writing' || f.phase === 'resetting') && (
                    <div style={{ marginTop: 10, height: 14, border: '1px solid #000', background: '#fff', overflow: 'hidden' }}>
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

              {(f.phase === 'monitoring' || f.serial) && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 'bold', marginBottom: 4 }}>
                    📟 Live serial from your board{f.phase === 'monitoring' ? ' — listening…' : ''}
                  </div>
                  <div style={{
                    maxHeight: 110, overflowY: 'auto', background: '#001a00', color: '#7CFC7C',
                    fontSize: 11, lineHeight: 1.45, padding: '7px 9px', whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word', border: '1px solid #0a0',
                  }}>
                    {f.serial || 'Waiting for the board to speak…'}
                  </div>
                </div>
              )}

              <div style={hint}>
                Heads up: this flashes WiFi + your firmware and enrolls the board. If your sketch calls
                <code> WiFi.begin(...)</code> itself, it may contend with the injected enrollment. Close any
                serial monitor holding the port; if the chip isn't detected, hold <b>BOOT</b> while clicking.
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                {f.phase === 'done' && <button onClick={f.reset} style={btnSecondary}>Flash another</button>}
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
