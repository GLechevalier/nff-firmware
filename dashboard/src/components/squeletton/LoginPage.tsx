import { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { checkInvite, getPendingInvite, setPendingInvite } from '../../lib/invite';
import { useTenant } from '../../context/TenantContext';

/**
 * Pure login page for the dashboard, matching the landing site's LoginPage
 * (nanoforgeflow.com): monospace, ink-on-warm-paper, hard borders, a hard
 * offset-shadow card, sharp corners, and hover-swapping OAuth buttons.
 *
 * Unlike the landing version it carries no react-router, no react-hook-form,
 * no Header/SiteFooter chrome and no cross-domain `?cb=` handshake — the page
 * lives *inside* the app it signs you into, so a successful sign-in simply lets
 * Supabase persist the session and `useUser` (in the auth gate) re-renders
 * straight through to the dashboard. It also keeps the inline signin/signup
 * toggle the landing site splits across `/login` and `/signup` routes.
 */

// Terminal register, copied from the landing site's `sections/tokens.ts`.
const INK    = '#000';
const PAPER  = '#faf9f5';              // warm off-white
const SHADOW = '4px 4px 0 #000';       // active boxes
const ERR    = '#cc0000';
const MEDIUM = 17;                     // landing's --sz-medium (desktop)

export function LoginPage() {
  const tenant = useTenant();
  const [mode, setMode]           = useState<'signin' | 'signup' | 'invite'>('signin');
  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [errors, setErrors]       = useState<{ email?: string; password?: string }>({});
  const [serverError, setServerError] = useState('');
  const [notice, setNotice]       = useState('');
  const [submitting, setSubmitting]   = useState(false);

  // Customer invite (username + one-time code → pre-provisioned workspace).
  // A validated invite is parked in localStorage BEFORE auth so it survives the
  // OAuth redirect and the email-confirm detour; the claim itself runs post-auth
  // in CurrentProjectProvider. Seeding from getPendingInvite() keeps the banner
  // up when the user comes back to confirm their email.
  const [inviteUsername, setInviteUsername] = useState('');
  const [inviteCode, setInviteCode]         = useState('');
  const [invite, setInvite] = useState<{ username: string; projectName?: string } | null>(
    () => { const p = getPendingInvite(); return p ? { username: p.username } : null; },
  );

  function switchMode(next: 'signin' | 'signup' | 'invite') {
    setMode(next);
    setErrors({});
    setServerError('');
    setNotice('');
  }

  async function onCheckInvite(e: React.FormEvent) {
    e.preventDefault();
    setServerError('');
    if (!inviteUsername.trim() || !inviteCode.trim()) {
      setServerError('Username and code are required');
      return;
    }
    setSubmitting(true);
    try {
      const username = inviteUsername.trim().toLowerCase();
      const result = await checkInvite(username, inviteCode.trim());
      setSubmitting(false);
      if (!result.valid) {
        // One generic message on purpose — the RPC is a no-oracle check.
        setServerError('Invalid username or code');
        return;
      }
      setPendingInvite({ username, code: inviteCode.trim() });
      setInvite({ username, projectName: result.projectName });
      switchMode('signup');
    } catch (err) {
      setSubmitting(false);
      setServerError(err instanceof Error ? err.message : 'Could not verify the invite');
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError('');
    setNotice('');

    const next: { email?: string; password?: string } = {};
    if (!email) next.email = 'Email is required';
    if (!password) next.password = 'Password is required';
    else if (mode === 'signup' && password.length < 6) next.password = 'Password must be at least 6 characters';
    setErrors(next);
    if (next.email || next.password) return;

    setSubmitting(true);
    if (mode === 'signup') {
      // The `on_auth_user_created` trigger (migration 05) provisions the
      // personal + demo projects atomically, so there's nothing to do here on
      // success beyond letting the session land.
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      setSubmitting(false);
      if (error) { setServerError(error.message); return; }
      // When email confirmation is enabled Supabase returns a user but no
      // session — the gate stays on the login page until they confirm.
      if (!data.session) {
        setNotice('Check your email to confirm your account, then sign in.');
        setMode('signin');
      }
      // Otherwise the gate's `useUser` listener swaps us to the dashboard.
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    // On success the gate's `useUser` listener swaps us to the dashboard;
    // nothing more to do here.
    if (error) setServerError(error.message);
  }

  async function signInWithProvider(provider: 'github' | 'google') {
    setServerError('');
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) setServerError(error.message);
  }

  return (
    <main
      style={{
        minHeight: '100%',
        boxSizing: 'border-box',
        background: PAPER,
        color: INK,
        overflowY: 'auto',
      }}
    >
      <div style={{ maxWidth: 400, margin: '40px auto', padding: '0 20px' }}>

        {tenant && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 12px' }}>
            {tenant.logoUrl && <img src={tenant.logoUrl} alt="" style={{ height: 48, width: 'auto' }} />}
            <span style={{ fontSize: MEDIUM, fontWeight: 700 }}>{tenant.displayName}</span>
          </div>
        )}

        <h1 style={{ fontSize: MEDIUM, fontWeight: 700, lineHeight: 1.15, letterSpacing: '-0.02em', margin: '0 0 16px' }}>
          {mode === 'invite' ? 'Claim your workspace.' : mode === 'signin' ? 'Sign in.' : 'Create account.'}
        </h1>

        {notice && (
          <p style={{ fontSize: MEDIUM, margin: '0 0 16px', color: INK, opacity: 0.8 }}>{notice}</p>
        )}

        {invite && mode !== 'invite' && (
          <div style={{ border: `1px solid ${INK}`, background: PAPER, padding: '10px 14px', margin: '0 0 16px', fontSize: MEDIUM }}>
            Claiming{' '}
            {invite.projectName ? <>workspace <strong>{invite.projectName}</strong></> : 'your workspace'}
            {' '}as <strong>{invite.username}</strong> — sign in below to finish.
            <span style={{ display: 'block', opacity: 0.6, marginTop: 4 }}>
              Using email? Confirm it in this browser to finish claiming.
            </span>
          </div>
        )}

        {mode === 'invite' ? (
          <div style={{ border: `1px solid ${INK}`, boxShadow: SHADOW, background: PAPER, padding: '20px 20px' }}>
            <form onSubmit={onCheckInvite} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ fontSize: MEDIUM, margin: 0, opacity: 0.7 }}>
                Enter the username and code you received.
              </p>

              <div>
                <label style={labelStyle}>Username</label>
                <input
                  autoComplete="off"
                  value={inviteUsername}
                  onChange={e => setInviteUsername(e.target.value.toLowerCase())}
                  placeholder="acme-7k2f"
                  style={inputStyle(false)}
                />
              </div>

              <div>
                <label style={labelStyle}>Code</label>
                <input
                  autoComplete="off"
                  value={inviteCode}
                  // Long codes get pasted — uppercase and drop any whitespace the
                  // clipboard picked up; the hyphens are part of the code itself.
                  onChange={e => setInviteCode(e.target.value.toUpperCase().replace(/\s+/g, ''))}
                  placeholder="A7KM-2PQ9-XW4R-…"
                  style={inputStyle(false)}
                />
              </div>

              {serverError && (
                <p style={{ fontSize: MEDIUM, margin: 0, color: ERR }}>{serverError}</p>
              )}

              <button type="submit" disabled={submitting} className="press" style={submitBtn(submitting)}>
                {submitting ? 'Checking…' : 'Continue →'}
              </button>

              <p style={{ fontSize: MEDIUM, margin: 0, opacity: 0.6 }}>
                Already set up?{' '}
                <button type="button" onClick={() => switchMode('signin')} style={linkBtn}>
                  Sign in
                </button>
              </p>
            </form>
          </div>
        ) : (
        <div style={{ border: `1px solid ${INK}`, boxShadow: SHADOW, background: PAPER, padding: '20px 20px' }}>

          {/* OAuth buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            <button type="button" onClick={() => signInWithProvider('github')} style={oauthStyle} onMouseEnter={oauthEnter} onMouseLeave={oauthLeave}>
              <GitHubIcon />
              Continue with GitHub
            </button>
            <button type="button" onClick={() => signInWithProvider('google')} style={oauthStyle} onMouseEnter={oauthEnter} onMouseLeave={oauthLeave}>
              <GoogleIcon />
              Continue with Google
            </button>
          </div>

          {/* Divider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
            <div style={{ flex: 1, height: 1, background: INK, opacity: 0.2 }} />
            <span style={{ fontSize: MEDIUM, opacity: 0.5 }}>or</span>
            <div style={{ flex: 1, height: 1, background: INK, opacity: 0.2 }} />
          </div>

          {/* Email / password form */}
          <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={labelStyle}>Email</label>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                style={inputStyle(!!errors.email)}
              />
              {errors.email && <span style={fieldErr}>{errors.email}</span>}
            </div>

            <div>
              <label style={labelStyle}>Password</label>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                style={inputStyle(!!errors.password)}
              />
              {errors.password && <span style={fieldErr}>{errors.password}</span>}
            </div>

            {serverError && (
              <p style={{ fontSize: MEDIUM, margin: 0, color: ERR }}>{serverError}</p>
            )}

            <button type="submit" disabled={submitting} className="press" style={submitBtn(submitting)}>
              {submitting
                ? (mode === 'signin' ? 'Signing in…' : 'Creating account…')
                : (mode === 'signin' ? 'Sign in →' : 'Create account →')}
            </button>

            {/* Mode toggle */}
            <p style={{ fontSize: MEDIUM, margin: 0, opacity: 0.6 }}>
              {mode === 'signin' ? (
                <>
                  No account?{' '}
                  <button type="button" onClick={() => switchMode('signup')} style={linkBtn}>
                    Sign up
                  </button>
                </>
              ) : (
                <>
                  Already have an account?{' '}
                  <button type="button" onClick={() => switchMode('signin')} style={linkBtn}>
                    Sign in
                  </button>
                </>
              )}
            </p>

            {!invite && (
              <p style={{ fontSize: MEDIUM, margin: 0, opacity: 0.6 }}>
                Have an access code?{' '}
                <button type="button" onClick={() => switchMode('invite')} style={linkBtn}>
                  Claim your workspace
                </button>
              </p>
            )}
          </form>

        </div>
        )}

      </div>
    </main>
  );
}

// Secondary (OAuth) button — flat bordered, color-swaps to ink on hover.
const oauthStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 16px',
  fontSize: MEDIUM,
  fontWeight: 400,
  background: PAPER,
  border: `1px solid ${INK}`,
  borderRadius: 0,
  color: INK,
  cursor: 'pointer',
  transition: 'background .15s, color .15s',
};
const oauthEnter = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = INK; e.currentTarget.style.color = PAPER; };
const oauthLeave = (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.background = PAPER; e.currentTarget.style.color = INK; };

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: MEDIUM,
  fontWeight: 700,
  marginBottom: 5,
};

function inputStyle(invalid: boolean): React.CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    fontSize: MEDIUM,
    padding: '7px 12px',
    border: `1px solid ${invalid ? ERR : INK}`,
    borderRadius: 0,
    background: 'transparent',
    color: INK,
    outline: 'none',
  };
}

const fieldErr: React.CSSProperties = {
  fontSize: 14,
  color: ERR,
  marginTop: 4,
  display: 'block',
};

const linkBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  fontSize: MEDIUM,
  color: INK,
  textDecoration: 'underline',
  cursor: 'pointer',
};

function submitBtn(submitting: boolean): React.CSSProperties {
  return {
    fontSize: MEDIUM,
    fontWeight: 700,
    padding: '9px 16px',
    // --brand-accent set by TenantContext on branded domains; stock ink otherwise.
    background: `var(--brand-accent, ${INK})`,
    color: PAPER,
    border: `1px solid var(--brand-accent, ${INK})`,
    borderRadius: 0,
    cursor: submitting ? 'not-allowed' : 'pointer',
  };
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}
