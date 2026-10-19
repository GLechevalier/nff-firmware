import { useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../lib/supabase';

/**
 * Email/password or Google sign-in — admins are existing Supabase users; there
 * is deliberately no sign-up path here. Access is then gated by platform_admins.
 */
export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) setError(signInError.message);
    setBusy(false);
  }

  // Same flow as nff-dashboard's LoginPage: Supabase redirects back to this
  // origin, where AdminGate's onAuthStateChange listener picks the session up.
  // The admin app's origin must be in Supabase Auth → URL Configuration →
  // Redirect URLs or the redirect falls back to the Site URL (the dashboard).
  async function signInWithGoogle() {
    setError(null);
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (oauthError) setError(oauthError.message);
  }

  return (
    <div className="flex h-full items-center justify-center">
      <form onSubmit={onSubmit} className="w-80 max-w-[calc(100vw-2rem)] border border-ink bg-paper p-6 shadow-hard">
        <h1 className="mb-1 text-lg font-bold tracking-label text-ink">nff-admin</h1>
        <p className="mb-5 text-xs text-faint">Platform supervision — admins only.</p>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs text-muted">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border border-hairline bg-paper px-2 py-1.5 text-sm text-ink outline-none focus:border-ink"
          />
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block text-xs text-muted">Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border border-hairline bg-paper px-2 py-1.5 text-sm text-ink outline-none focus:border-ink"
          />
        </label>

        {error && <p className="mb-3 text-xs text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="press w-full bg-ink py-1.5 text-sm font-bold tracking-label text-paper disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <div className="my-6 flex items-center gap-3">
          <span className="h-px flex-1 bg-hairline" />
          <span className="text-[10px] uppercase tracking-label text-faint">or</span>
          <span className="h-px flex-1 bg-hairline" />
        </div>

        <button
          type="button"
          onClick={() => void signInWithGoogle()}
          className="flex w-full items-center justify-center gap-2 border border-ink py-1.5 text-sm text-ink hover:bg-ink hover:text-paper"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.49 12c0-.73.13-1.44.35-2.1V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.16-3.16A10.96 10.96 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
          </svg>
          Continue with Google
        </button>
      </form>
    </div>
  );
}
