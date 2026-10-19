// Shared server-side helper: mint a short-lived signed URL for nff-fleet's /link WebSocket
// bridge (the wired-onboarding data path — the browser's WiredLink splices the device's
// mTLS-MQTT flow through it; see src/lib/ppplink). Used by both the Vercel function
// (api/link-token.ts, prod) and the Vite dev middleware (vite.config.ts).
//
// Security: membership is enforced with the USER's own Supabase JWT (RLS) — a plain SELECT of the
// project under their token; a non-member gets an empty result → 403. The token we mint is an
// HMAC over "<project_id>.<exp>" with the fleet shared secret (NFF_FLEET_SECRET), which never
// reaches the browser — only the derived signature does. The bridge only moves opaque TLS bytes
// (the device authenticates itself to the broker with its own client cert), so a leaked URL
// expires in minutes and can't impersonate a device.

import { createHmac } from 'node:crypto';
import { isTimeoutError } from './_fleet.js';

const SUPABASE_TIMEOUT_MS = 8_000;
const TOKEN_TTL_S = 300;

export interface LinkTokenCfg {
  supabaseUrl?: string;
  anonKey?: string;
  fleetWsUrl?: string;
  fleetSecret?: string;
  httpMirror?: string;
}

export type LinkTokenResult =
  | { ok: false; status: number; error: string }
  | { ok: true; status: 200; url: string };

export async function mintLinkToken(
  authorization: unknown,
  projectId: unknown,
  dst?: unknown,
  cfg?: LinkTokenCfg,
): Promise<LinkTokenResult> {
  const supabaseUrl = (cfg?.supabaseUrl ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const anonKey = cfg?.anonKey ?? process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '';
  const fleetWsUrl = (cfg?.fleetWsUrl ?? process.env.NFF_FLEET_WS_URL ?? '').replace(/\/+$/, '');
  const fleetSecret = cfg?.fleetSecret ?? process.env.NFF_FLEET_SECRET ?? '';

  if (!supabaseUrl || !anonKey) return { ok: false, status: 500, error: 'Supabase env is not configured' };
  if (!fleetWsUrl) return { ok: false, status: 500, error: 'NFF_FLEET_WS_URL is not configured' };
  if (!fleetSecret) return { ok: false, status: 500, error: 'NFF_FLEET_SECRET is not configured' };

  const token = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '').trim() : '';
  if (!token) return { ok: false, status: 401, error: 'sign in first (missing bearer token)' };
  if (typeof projectId !== 'string' || !projectId) return { ok: false, status: 400, error: 'project_id is required' };

  // Destination authorization: the bridge dials whatever the token says, so the allowlist lives
  // HERE, inside the membership-gated API — '' (the broker), the artifact host (Supabase
  // Storage :443, same project as this dashboard env), or an optional plain-HTTP artifact
  // mirror on the fleet's network (NFF_LINK_HTTP_MIRROR, e.g. "mirror-host:80" — used to deliver
  // an OTA to a device whose current image cannot do TLS on the download path; integrity still
  // comes from the sha256 in the fleet-signed OTA command). Everything else is refused, which
  // is what keeps the bridge from being an open proxy.
  const dstStr = dst === undefined || dst === null ? '' : String(dst);
  const artifactHost = `${new URL(supabaseUrl).host}:443`;
  const httpMirror = cfg?.httpMirror ?? process.env.NFF_LINK_HTTP_MIRROR ?? '';
  if (dstStr !== '' && dstStr !== artifactHost && !(httpMirror && dstStr === httpMirror)) {
    return { ok: false, status: 403, error: `destination not allowed: ${dstStr.slice(0, 100)}` };
  }

  // Membership under the user's JWT (RLS): non-member → empty result → 403.
  let rows: unknown;
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/projects?id=eq.${encodeURIComponent(projectId)}&select=id`,
      {
        headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
      },
    );
    if (r.status === 401) return { ok: false, status: 401, error: 'session expired — sign in again' };
    rows = await r.json().catch(() => []);
  } catch (e) {
    if (isTimeoutError(e)) {
      return { ok: false, status: 504, error: `auth backend timed out after ${SUPABASE_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, status: 502, error: `auth backend unreachable: ${(e as Error)?.message ?? e}` };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, status: 403, error: 'you are not a member of this project' };
  }

  // 4-part token: <project>.<exp>.<b64url(dst)>.<hmac over "project.exp.dst"> — the signature
  // covers the destination, so a token minted for the broker cannot be replayed against another
  // host. (The bridge also accepts the legacy 3-part broker-only form.)
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
  const sig = createHmac('sha256', fleetSecret).update(`${projectId}.${exp}.${dstStr}`).digest('hex');
  const dstB64 = Buffer.from(dstStr).toString('base64url');
  const linkToken = `${projectId}.${exp}.${dstB64}.${sig}`;
  return { ok: true, status: 200, url: `${fleetWsUrl}/link?token=${encodeURIComponent(linkToken)}` };
}
