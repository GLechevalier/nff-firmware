import type React from 'react';
import { useEffect } from 'react';
import { BRAND_ACCENT } from '../../../lib/brand';

interface Props {
  onClose: () => void;
  // Optional: jump to the in-app Enroll tab (where announced devices are accepted).
  onGoToEnroll?: () => void;
  // Optional: open the zero-install browser (Web Serial) flasher instead of the CLI path.
  onFlashOverUsb?: () => void;
}

const codeBlock: React.CSSProperties = {
  background: '#f4f4f4',
  border: '1px solid #ddd',
  padding: '7px 9px',
  fontSize: 12,
  whiteSpace: 'pre',
  overflowX: 'auto',
  margin: '6px 0 0',
  lineHeight: 1.5,
};

const hint: React.CSSProperties = { marginTop: 6, fontSize: 11.5, color: '#666', lineHeight: 1.5 };

const btnPrimary: React.CSSProperties = {
  fontSize: 12, fontWeight: 'bold',
  border: '1px solid #000', background: BRAND_ACCENT, color: '#fff', cursor: 'pointer', padding: '4px 12px',
};
const btnSecondary: React.CSSProperties = { ...btnPrimary, background: '#fff', color: '#000', fontWeight: 'normal' };

function Step({ n, title, last, children }: { n: number; title: string; last?: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', gap: 10,
      paddingBottom: last ? 0 : 14, marginBottom: last ? 0 : 14,
      borderBottom: last ? 'none' : '1px solid #eee',
    }}>
      <div style={{
        flexShrink: 0, width: 22, height: 22, borderRadius: '50%',
        background: '#000', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 'bold',
      }}>{n}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 'bold', marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: 12.5, color: '#333', lineHeight: 1.55 }}>{children}</div>
      </div>
    </div>
  );
}

// Explains how to bring a real ESP32 online with nff: install the SDK + provision credentials,
// flash a minimal sketch that connects over mTLS, then accept the announced device. Steps mirror
// the nff-sdk-c quickstart and the fleet announce→accept→rollover handshake.
export function EnrollDeviceModal({ onClose, onGoToEnroll, onFlashOverUsb }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 580, maxWidth: '94vw', maxHeight: '86vh', overflowY: 'auto',
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
          <strong style={{ letterSpacing: 0.3 }}>Enroll a real device</strong>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}
          >×</button>
        </div>

        <div style={{ padding: '14px 16px' }}>
          <p style={{ marginTop: 0, marginBottom: 12, color: '#444', lineHeight: 1.55 }}>
            Bring your own ESP32 online. The fastest way needs no install at all — flash it
            straight from this browser over USB. Prefer the CLI? The three-step path is below.
          </p>

          {onFlashOverUsb && (
            <div style={{
              border: '1.5px solid #000', boxShadow: '3px 3px 0 #000', padding: '10px 12px', marginBottom: 16,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 'bold' }}>⚡ Flash over USB — no install</div>
                <div style={{ fontSize: 11.5, color: '#666', marginTop: 3, lineHeight: 1.5 }}>
                  Plug in via USB and flash a demo firmware from Chrome, Edge or Opera in seconds.
                </div>
              </div>
              <button onClick={() => { onFlashOverUsb(); onClose(); }} style={{ ...btnPrimary, flexShrink: 0 }}>
                Flash now →
              </button>
            </div>
          )}

          <div style={{ fontSize: 11, fontWeight: 'bold', color: '#888', letterSpacing: 0.5, marginBottom: 10 }}>
            OR USE THE CLI
          </div>

          <Step n={1} title="Install the SDK & get credentials">
            Install the CLI, add the nff Arduino library to your sketchbook, then provision a device
            identity. That last command writes a <code>credentials.h</code> holding the device's mTLS
            certificate, private key and your project id.
            <pre style={codeBlock}>{`pip install nff
nff auth status                 # confirm you're logged in

# add the nff Arduino library to your sketchbook
python tools/sync_arduino_lib.py

# create a device identity → writes credentials.h
nff provision new-device --id my-device-01`}</pre>
            <div style={hint}>
              Onboarding a whole fleet? Use <code>nff provision batch --project &lt;id&gt;</code> to flash
              one shared image to many boards; each rolls over to its own identity on first accept.
            </div>
          </Step>

          <Step n={2} title="Flash firmware that connects to the server">
            A minimal sketch includes <code>&lt;nff.h&gt;</code> and the generated
            <code> credentials.h</code>, joins WiFi, then calls the three nff lifecycle functions.
            Flash it with the CLI.
            <pre style={codeBlock}>{`#include <WiFi.h>
#include <nff.h>
#include "credentials.h"          // from step 1 — never commit this

NFF_CONFIG(cfg, DEVICE_ID, NFF_BROKER_HOST);

void setup() {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  nff_init(&cfg);     // panic hook + last-boot crash / OTA check
  nff_connect();      // mTLS handshake to the nff fleet
}
void loop() { nff_loop(); }        // non-blocking`}</pre>
            <pre style={codeBlock}>{`nff flash path/to/your/sketch`}</pre>
            <div style={hint}>
              The device reaches the nff fleet broker over <b>mTLS MQTT (port 8883)</b>, pinning the CA
              baked into <code>credentials.h</code> — no passwords and no inbound ports to open.
            </div>
          </Step>

          <Step n={3} title="Accept it here" last>
            On boot the device <b>announces itself</b> and shows up in the <b>Enroll</b> tab's{' '}
            <b>unclaimed</b> lane. Click <b>Accept</b> and nff rolls it over to its own unique
            certificate; it reconnects and appears <b>online</b> on your Dashboard.
          </Step>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button onClick={onClose} style={btnSecondary}>Close</button>
            {onGoToEnroll && (
              <button onClick={() => { onGoToEnroll(); onClose(); }} style={btnPrimary}>
                Open the Enroll tab →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
