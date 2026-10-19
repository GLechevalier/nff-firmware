// Shared server-side Supabase access for api/ helpers. Service-role key stays server-side
// (never in the browser bundle). Returns null when env isn't configured so callers can fall
// through best-effort. Mirrors resolveSupabase() in _selfheal.ts.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function getServiceSupabase(): SupabaseClient | null {
  const supabaseUrl = process.env.VITE_SUPABASE_URL ?? '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
