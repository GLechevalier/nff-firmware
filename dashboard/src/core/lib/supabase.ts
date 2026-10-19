import { createClient } from '@supabase/supabase-js';

// Anon key only — the browser never sees the service role. Cross-project data
// comes exclusively from /api/* (which verifies the JWT + platform_admins).
//
// Accept either naming convention: `.env.dev` uses VITE_SUPABASE_*, while a
// Vercel/Supabase-integration `vercel env pull` writes VITE_PUBLIC_SUPABASE_*.
// Fail loudly rather than silently constructing a client with undefined config.
// VITE_ADMIN_* wins when set: the hosting nff-dashboard build defines it so
// this client keeps pointing at the admin project while the host's own
// VITE_SUPABASE_* points at the dashboard project.
const url =
  (import.meta.env.VITE_ADMIN_SUPABASE_URL as string | undefined) ??
  (import.meta.env.VITE_SUPABASE_URL as string | undefined) ??
  (import.meta.env.VITE_PUBLIC_SUPABASE_URL as string | undefined);
const anon =
  (import.meta.env.VITE_ADMIN_SUPABASE_ANON_KEY as string | undefined) ??
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ??
  (import.meta.env.VITE_PUBLIC_SUPABASE_ANON_KEY as string | undefined);

if (!url || !anon) {
  throw new Error(
    'Missing Supabase config: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY ' +
      '(or the VITE_PUBLIC_* equivalents).',
  );
}

export const supabase = createClient(url, anon);
