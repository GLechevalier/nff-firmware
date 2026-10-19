import { supabase } from './supabase';

/**
 * Records one page visit per page load via the anon-callable log_page_visit RPC
 * (migration 11). Vercel exposes no Web Analytics API, so nff-admin reads these
 * rows instead. session_key persists for the browser session so reloads can be
 * deduplicated into "unique sessions" server-side.
 */
let logged = false; // module guard — survives StrictMode's dev double-effect

export function logPageVisitOnce(): void {
  if (logged) return;
  logged = true;

  let key = sessionStorage.getItem('nff_visit');
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem('nff_visit', key);
  }

  void supabase.rpc('log_page_visit', {
    p_app: 'nff-dashboard',
    p_path: window.location.pathname,
    p_session_key: key,
  });
}
