// previewSso — single-sign-on from the admin app into per-user preview
// instances (preview-<slug>.nanoforgeflow.com), so a preview never shows a
// login screen: the admin app hands its Supabase session across origins and
// the preview adopts it with setSession().
//
// Two transports, both sender-initiated from the admin origin only:
//   * postMessage into the embedded iframe (re-sent on every TOKEN_REFRESHED,
//     so the frame stays signed in indefinitely);
//   * a one-shot `#sso=<base64url session>` fragment for "open in new tab"
//     (stripped from the URL immediately on adoption; lives ~1h, the access
//     token's lifetime).
//
// SECURITY. The receiver is HARD-GATED to preview-* hostnames: the real admin
// app never adopts a session from a URL fragment or a message, so a crafted
// admin.nanoforgeflow.com/#sso=… link cannot fixate someone onto an attacker's
// session. Messages are only accepted from ADMIN_ORIGIN. After adopting, the
// preview STOPS auto-refresh: Supabase rotates refresh tokens on use, and two
// clients sharing one family would race — the loser trips reuse detection and
// kills the admin's own session. The iframe stays fresh via parent re-sends;
// a stand-alone tab simply expires after ~1h (reopen from the Improve tab).

import type { SupabaseClient } from '@supabase/supabase-js';

export const ADMIN_ORIGIN = 'https://admin.nanoforgeflow.com';
const MSG_TYPE = 'nff-admin-sso';
export const READY_MSG_TYPE = 'nff-admin-sso-ready';

type SsoPayload = { type: typeof MSG_TYPE; access_token: string; refresh_token: string };

export function isPreviewHost(): boolean {
  return window.location.hostname.startsWith('preview-');
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}

/** Sender side: append the current session to a preview URL as a fragment. */
export async function withSsoFragment(supabase: SupabaseClient, url: string): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const s = data.session;
  if (!s) return url;
  const payload = JSON.stringify({ access_token: s.access_token, refresh_token: s.refresh_token });
  return `${url.replace(/#.*$/, '')}#sso=${b64urlEncode(payload)}`;
}

/** Sender side: push the current session into an embedded preview frame. */
export async function sendSsoToFrame(supabase: SupabaseClient, frame: HTMLIFrameElement, previewUrl: string): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const s = data.session;
  if (!s || !frame.contentWindow) return;
  const msg: SsoPayload = { type: MSG_TYPE, access_token: s.access_token, refresh_token: s.refresh_token };
  frame.contentWindow.postMessage(msg, new URL(previewUrl).origin);
}

async function adopt(supabase: SupabaseClient, access_token: string, refresh_token: string): Promise<void> {
  await supabase.auth.setSession({ access_token, refresh_token });
  // Never refresh from the preview — the admin app owns the token family
  // (see header comment). Re-sends from the parent keep the iframe fresh.
  supabase.auth.stopAutoRefresh();
}

/**
 * Receiver side — call once at boot, before rendering. No-op outside
 * preview-* hosts. Returns a promise that resolves once any fragment SSO has
 * been applied, so the app's initial getSession() sees the adopted session.
 */
export async function installPreviewSsoReceiver(supabase: SupabaseClient): Promise<void> {
  if (!isPreviewHost()) return;

  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.origin !== ADMIN_ORIGIN) return;
    const d = ev.data as Partial<SsoPayload> | null;
    if (!d || d.type !== MSG_TYPE || !d.access_token || !d.refresh_token) return;
    void adopt(supabase, d.access_token, d.refresh_token);
  });

  // Embedded case: the parent's iframe-onLoad can fire before this listener
  // exists, so announce readiness — the parent answers with the session.
  if (window.parent !== window) {
    window.parent.postMessage({ type: READY_MSG_TYPE }, ADMIN_ORIGIN);
  }

  const m = /^#sso=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  if (!m) return;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  try {
    const { access_token, refresh_token } = JSON.parse(b64urlDecode(m[1])) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (access_token && refresh_token) await adopt(supabase, access_token, refresh_token);
  } catch {
    // Malformed fragment — fall through to the normal login screen.
  }
}
