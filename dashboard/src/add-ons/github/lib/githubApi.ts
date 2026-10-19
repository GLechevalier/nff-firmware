import { supabase } from '../../../lib/supabase';

// The GitHub add-on's server contract, host-agnostic. Paths are relative to the host's github
// router — `/api/github/<action>` in the dashboard, `/api/git/<action>` in nff-admin — so the same
// components (ConnectGithubModal, the Connect GitHub button) run against either backend.
// Both implementations reject with an Error carrying the server's `error` message.
export interface GithubApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

async function jwtHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function unwrap<T>(resp: Response): Promise<T> {
  const body = await resp.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!resp.ok || body.ok === false) throw new Error(body.error ?? `request failed (${resp.status})`);
  return body as T;
}

// Dashboard host: api/github.ts (?action= router behind the /api/github/:action rewrite).
export const dashboardGithubApi: GithubApi = {
  async get(path) {
    const resp = await fetch(`/api/github${path}`, { headers: await jwtHeaders() });
    return unwrap(resp);
  },
  async post(path, body) {
    const resp = await fetch(`/api/github${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await jwtHeaders()) },
      body: JSON.stringify(body),
    });
    return unwrap(resp);
  },
};
