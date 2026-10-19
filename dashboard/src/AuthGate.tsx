import { useEffect } from 'react';
import type { User } from '@supabase/supabase-js';
import App from './App';
import { LoginPage } from './components/squeletton/LoginPage';
import { supabase } from './lib/supabase';
import { useUser } from './hooks/useUser';
import { usePresence } from './hooks/usePresence';
import { useHiddenParts } from './hooks/useHiddenParts';
import { buildStore, hiddenGroups } from './lib/store';
import { setApiProjectId } from './core/lib/api';
import { logPageVisitOnce } from './lib/pageVisit';
import { CurrentProjectProvider, useCurrentProject } from './context/CurrentProjectContext';
import { DeviceHealthProvider } from './context/DeviceHealthContext';
import { useTenant, useTenantLoading } from './context/TenantContext';
import { DEV_MODE } from './lib/devMode';

// Dashboard groups retired from the nav outright (not Store-toggleable): same
// hidden-groups mechanics as Store removals — gone from the sidebar, arrow
// keys and the tab guard. 'builder' isn't released; 'agents' was folded away.
const RETIRED_GROUPS = ['agents', 'follow-us', 'security', 'builder'];

/**
 * Mounts App keyed on the current project so switching projects cleanly remounts
 * the dashboard and every hook refetches scoped to the new tenant. Also tracks
 * this user on the shared presence channel so nff-admin can count live users.
 */
function ProjectScopedApp({ user }: { user: User }) {
  const { currentProjectId } = useCurrentProject();
  usePresence(user.id, currentProjectId);
  // The per-workspace add-on API reads this via the X-Project-Id header
  // (src/core/lib/api.ts). Standalone nff-admin never sets it.
  useEffect(() => setApiProjectId(currentProjectId), [currentProjectId]);
  const { hidden, toggle, setParts } = useHiddenParts(user);
  return (
    // Keyed on the project so the dot-health overlay (and its crash
    // subscription) remounts cleanly on a project switch.
    <DeviceHealthProvider key={currentProjectId}>
      <App
        userId={user.id}
        hiddenParts={[...hiddenGroups(hidden), ...RETIRED_GROUPS]}
        store={buildStore(hidden, toggle, setParts)}
      />
    </DeviceHealthProvider>
  );
}

/**
 * Auth boundary for the whole app. While the Supabase session resolves we show
 * nothing; with no user we show the login page; once signed in the dashboard
 * mounts. `useUser`'s `onAuthStateChange` listener flips this automatically the
 * moment a sign-in (password or OAuth redirect) lands — no manual navigation.
 */
/** The CLI's loopback callback from `nff auth login`'s `?cb=` param, or null.
 * Loopback-only so a crafted link can never hand the session to a remote host. */
function cliCallbackUrl(): URL | null {
  const cb = new URLSearchParams(window.location.search).get('cb');
  if (!cb) return null;
  try {
    const url = new URL(cb);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    return url.protocol === 'http:' && loopback ? url : null;
  } catch {
    return null;
  }
}

export function AuthGate() {
  const { user, loading } = useUser();
  const tenant = useTenant();
  const tenantLoading = useTenantLoading();

  // One visit row per page load, signed-in or not (anon-callable RPC).
  useEffect(() => {
    logPageVisitOnce();
  }, []);

  // Accounts claimed through a branded invite carry `tenant_hostname` in their
  // metadata (0107): signing in on the UNBRANDED main domain sends them home to
  // their branded console. Never fires on a tenant domain (theirs is where they
  // land; a wrong one shows the access-denied panel), never during the CLI
  // loopback handshake (that flow must deliver tokens, not navigate away), and
  // never in local dev.
  const brandedHome = (user?.user_metadata as { tenant_hostname?: string } | undefined)?.tenant_hostname;
  const redirectingToBrandedHome =
    !!user && !tenantLoading && !tenant && !DEV_MODE && !cliCallbackUrl() &&
    !!brandedHome && window.location.hostname.toLowerCase() !== brandedHome;
  useEffect(() => {
    if (redirectingToBrandedHome) window.location.replace(`https://${brandedHome}`);
  }, [redirectingToBrandedHome, brandedHome]);

  // CLI login handshake: `nff auth login` opens the app with ?cb=http://127.0.0.1:<port>/callback
  // and waits on that socket. The moment a session exists (fresh sign-in via the gate below, or
  // already signed in), deliver the tokens to the local callback — the same handshake the landing
  // site's LoginPage performs, so the CLI works against either host.
  useEffect(() => {
    if (!user) return;
    const cb = cliCallbackUrl();
    if (!cb) return;
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      const session = data.session;
      if (cancelled || !session) return;
      cb.searchParams.set('access_token', session.access_token);
      cb.searchParams.set('refresh_token', session.refresh_token);
      window.location.replace(cb.toString());
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (loading || redirectingToBrandedHome) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 13,
          color: '#666',
        }}
      >
        Loading…
      </div>
    );
  }

  if (!user) return <LoginPage />;

  return (
    <CurrentProjectProvider>
      <ProjectScopedApp user={user} />
    </CurrentProjectProvider>
  );
}
