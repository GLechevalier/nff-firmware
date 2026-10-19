// WifiHandoffModal — the "cut the cord" onboarding step. The device has been living on the wired
// (USB/PPPoS) link through this tab; here the user types their WiFi network and we push the
// credentials OVER THE SERIAL CABLE: the WiredLink tears PPP down with an LCP Terminate-Req,
// which drops the firmware into a line-mode config window, then sends
// "NFF+CFG <b64 ssid> <b64 pass>" and waits for NFF+OK. The device stores the creds in NVS and
// reboots straight onto WiFi — the user can then unplug and go.
//
// Styles mirror WebFlashModal's brutalist monospace look.

import type React from 'react';
import { useEffect, useState } from 'react';
import { useWiredLinkState } from '../hooks/useWiredLink';
import { BRAND_ACCENT } from '../../../lib/brand';
import { sendWifiCredsViaLink } from '../../../lib/ppplink/linkStore';

interface Props {
  onClose: () => void;
  onSuccess?: () => void; // e.g. mark the onboarding node done
}

const btnPrimary: React.CSSProperties = {
  fontSize: 12, fontWeight: 'bold',
  border: '1px solid #000', background: BRAND_ACCENT, color: '#fff', cursor: 'pointer', padding: '6px 14px',
};
const btnSecondary: React.CSSProperties = { ...btnPrimary, background: '#fff', color: '#000', fontWeight: 'normal' };
const btnDisabled: React.CSSProperties = { ...btnPrimary, background: '#888', borderColor: '#888', cursor: 'default' };
const inputStyle: React.CSSProperties = {
  fontSize: 12, width: '100%', boxSizing: 'border-box',
  border: '1px solid #000', padding: '5px 7px', background: '#fff',
};
const hint: React.CSSProperties = { marginTop: 8, fontSize: 11.5, color: '#666', lineHeight: 1.55 };

type Phase = 'form' | 'sending' | 'done' | 'failed';

export function WifiHandoffModal({ onClose, onSuccess }: Props) {
  const linkState = useWiredLinkState();
  const [ssid, setSsid] = useState('');
  const [pass, setPass] = useState('');
  const [phase, setPhase] = useState<Phase>('form');

  const busy = phase === 'sending';
  const linked = linkState !== null && linkState !== 'closed' && linkState !== 'error';

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !busy) onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  async function send() {
    setPhase('sending');
    try {
      const ok = await sendWifiCredsViaLink(ssid.trim(), pass);
      setPhase(ok ? 'done' : 'failed');
      if (ok) onSuccess?.();
    } catch {
      setPhase('failed');
    }
  }

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
          width: 480, maxWidth: '94vw', maxHeight: '86vh', overflowY: 'auto',
          background: '#fff', border: '1.5px solid #000', boxShadow: '4px 4px 0 #000',
          display: 'flex', flexDirection: 'column', fontSize: 13,
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '7px 12px', borderBottom: '1px solid #000', background: BRAND_ACCENT, color: '#fff',
        }}>
          <strong style={{ letterSpacing: 0.3 }}>📡 Cut the cord — move your device to WiFi</strong>
          <button
            onClick={() => { if (!busy) onClose(); }}
            aria-label="Close" disabled={busy}
            style={{
              background: 'none', border: 'none', color: '#fff',
              cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.4 : 1,
              fontSize: 16, lineHeight: 1, padding: '0 2px',
            }}
          >×</button>
        </div>

        <div style={{ padding: '14px 16px' }}>
          {phase === 'done' ? (
            <div style={{ border: '1.5px solid #000', background: '#eaffea', padding: '10px 12px' }}>
              <div style={{ fontWeight: 'bold' }}>Credentials delivered ✨</div>
              <div style={{ fontSize: 11.5, color: '#555', lineHeight: 1.6, marginTop: 6 }}>
                Your device stored the WiFi credentials and is <b>rebooting onto your network</b>.
                Watch the fleet: it should come back <b>online</b> in under a minute — over WiFi
                this time. When it does, you can <b>unplug the USB cable</b> and power the board
                from anywhere.
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                <button onClick={onClose} style={btnPrimary}>Close</button>
              </div>
            </div>
          ) : !linked ? (
            <div>
              <p style={{ marginTop: 0, lineHeight: 1.6 }}>
                No device is <b>wired through this tab</b> right now, so there's nothing to hand
                WiFi credentials to over the cable.
              </p>
              <p style={hint}>
                Flash your ESP32 over USB first (the <b>Enroll your own devices</b> step) and keep
                it plugged in, then come back here. If your board is already on WiFi, you're done —
                just mark the step complete.
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                <button onClick={onClose} style={btnSecondary}>Close</button>
              </div>
            </div>
          ) : (
            <div>
              <p style={{ marginTop: 0, marginBottom: 12, color: '#444', lineHeight: 1.6 }}>
                Your device currently reaches the fleet <b>through this tab's USB link</b>. Enter
                your WiFi network and nff will send the credentials <b>over the serial cable</b> —
                the device stores them, reboots onto WiFi, and no longer needs the cable.
              </p>

              <div style={{ marginBottom: 8 }}>
                <label style={{ display: 'block', fontSize: 11.5, fontWeight: 'bold', marginBottom: 3 }}>
                  WiFi network (SSID)<span style={{ color: '#b00' }}> *</span>
                </label>
                <input
                  type="text" value={ssid} maxLength={32} disabled={busy} autoComplete="off"
                  placeholder="your-wifi-name"
                  onChange={(e) => setSsid(e.target.value)} style={inputStyle}
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 11.5, fontWeight: 'bold', marginBottom: 3 }}>
                  WiFi password
                </label>
                <input
                  type="password" value={pass} maxLength={64} disabled={busy} autoComplete="off"
                  placeholder="leave blank for open networks"
                  onChange={(e) => setPass(e.target.value)} style={inputStyle}
                />
              </div>

              {phase === 'failed' && (
                <div style={{
                  marginBottom: 10, border: '1px solid #b00', background: '#fff0f0',
                  padding: '8px 10px', color: '#900', fontSize: 11.5, lineHeight: 1.5,
                }}>
                  The device didn't acknowledge the credentials. Check it's still plugged in and
                  the link badge shows it wired, then try again.
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  onClick={() => void send()}
                  disabled={busy || !ssid.trim()}
                  style={busy || !ssid.trim() ? btnDisabled : btnPrimary}
                >
                  {busy ? 'Sending over the cable…' : 'Send WiFi to my device'}
                </button>
                <span style={{ fontSize: 11.5, color: '#666' }}>
                  🔌 wired: {linkState}
                </span>
              </div>

              <div style={hint}>
                ESP32s are <b>2.4 GHz-only</b> — a 5 GHz-only network won't work. The credentials
                travel over your USB cable and are stored only on the device.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
