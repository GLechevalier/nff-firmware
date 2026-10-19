// Shared server-side helper backing the CLI auth surface (`nff auth login` direct login and the
// refresh-once-on-401 in ota_client/provisioning_client/repair). Used by both the Vercel function
// (api/auth.ts, prod) and the Vite dev middleware (vite.config.ts) — same split as api/_ota.ts.
//
// Historically these endpoints lived on the VPS diagnosis service (nff-diagnosis auth/router.py);
// with prod fronted by Vercel they must exist here or every CLI token refresh 404s into the SPA
// catch-all. This is a thin proxy over Supabase GoTrue with the ANON key — no service-role key,
// no session state. Response contract matches nff/tools/auth.py::TokenResponse:
// { access_token, refresh_token, token_type, expires_in }.

const SUPABASE_TIMEOUT_MS = 8_000;

// Vite dev middleware passes env explicitly (process.env isn't populated there) — same
// seam as OtaCfg in _ota.ts.
export interface AuthCfg {
  supabaseUrl?: string;
  anonKey?: string;
}

interface Env {
  supabaseUrl: string;
  anonKey: string;
}

function readEnv(cfg?: AuthCfg): Env {
  return {
    supabaseUrl: (cfg?.supabaseUrl ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, ''),
    anonKey: cfg?.anonKey ?? process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
  };
}

export interface AuthResult {
  ok: boolean;
  status: number; // HTTP status to return to the client
  data?: unknown;
  error?: string;
}

function supabaseError(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const msg = b.error_description ?? b.msg ?? b.error;
    if (typeof msg === 'string' && msg) return msg;
  }
  return 'Request failed';
}

async function tokenGrant(
  grantType: string,
  payload: Record<string, string>,
  cfg?: AuthCfg,
): Promise<AuthResult> {
  const env = readEnv(cfg);
  if (!env.supabaseUrl || !env.anonKey) {
    return { ok: false, status: 503, error: 'Auth service not configured' };
  }
  let resp: Response;
  try {
    resp = await fetch(`${env.supabaseUrl}/auth/v1/token?grant_type=${grantType}`, {
      method: 'POST',
      headers: { apikey: env.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 502, error: 'Auth backend unreachable' };
  }
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    /* fall through */
  }
  if (resp.status !== 200) {
    return { ok: false, status: 401, error: supabaseError(body) };
  }
  const b = body as Record<string, unknown>;
  return {
    ok: true,
    status: 200,
    data: {
      access_token: b.access_token,
      refresh_token: b.refresh_token,
      token_type: b.token_type ?? 'bearer',
      expires_in: b.expires_in ?? 3600,
    },
  };
}

export async function authLogin(email: unknown, password: unknown, cfg?: AuthCfg): Promise<AuthResult> {
  if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) {
    return { ok: false, status: 400, error: 'email and password are required' };
  }
  return tokenGrant('password', { email, password }, cfg);
}

export async function authRefresh(refreshToken: unknown, cfg?: AuthCfg): Promise<AuthResult> {
  if (typeof refreshToken !== 'string' || !refreshToken) {
    return { ok: false, status: 400, error: 'refresh_token is required' };
  }
  return tokenGrant('refresh_token', { refresh_token: refreshToken }, cfg);
}

export async function authLogout(authorization: unknown, cfg?: AuthCfg): Promise<AuthResult> {
  const env = readEnv(cfg);
  if (!env.supabaseUrl || !env.anonKey) {
    return { ok: false, status: 503, error: 'Auth service not configured' };
  }
  const token = typeof authorization === 'string' ? authorization : '';
  if (!token) return { ok: false, status: 401, error: 'missing bearer token' };
  // Best-effort revocation; the CLI clears its local tokens regardless.
  try {
    await fetch(`${env.supabaseUrl}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: env.anonKey, Authorization: token },
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    });
  } catch {
    /* revocation is best-effort */
  }
  return { ok: true, status: 204 };
}
