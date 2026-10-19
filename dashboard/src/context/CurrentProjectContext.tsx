import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { forceSignOut, isOrphanedUserError } from '../lib/staleSession';
import { claimPendingInvite } from '../lib/invite';
import { useTenant, useTenantLoading } from './TenantContext';
import { DEMO_MODE } from '../lib/demoMode';

/**
 * The current tenant. Every data hook reads `currentProjectId` from here and scopes
 * its Supabase queries to it; RLS (migration 04) enforces the same boundary in the
 * database. A "project" is one workspace — Free plan = one user owns one project,
 * Team plan = the same project with several members.
 *
 * Membership is read through `project_members` (RLS returns only the caller's rows).
 * A brand-new user already has a personal project from the auth.users trigger; the
 * `ensure_personal_project` RPC is an idempotent fallback for users created before
 * that trigger existed.
 */

export interface ProjectSummary {
  id: string;
  name: string;
  plan: 'free' | 'team';
  role: 'owner' | 'admin' | 'member';
  is_demo: boolean;
  created_at: string | null;
  pr_auto_merge: boolean;
  // Per-project OTA rate-limit window (seconds); null = use nff-ota's global default.
  ota_rate_limit_seconds: number | null;
  // What the Code-tab git graph lists as branches: 'agent' (default) or 'all' GitHub branches.
  git_graph_branch_source: 'agent' | 'all';
}

interface CurrentProjectValue {
  projects: ProjectSummary[];
  currentProjectId: string;
  currentProject: ProjectSummary;
  setCurrentProjectId: (id: string) => void;
  reload: () => Promise<void>;
}

const Ctx = createContext<CurrentProjectValue | null>(null);
const LS_KEY = 'nff.currentProjectId';

interface MemberRow {
  role: ProjectSummary['role'];
  projects: { id: string; name: string; plan: ProjectSummary['plan']; is_demo?: boolean; created_at?: string | null; pr_auto_merge?: boolean; ota_rate_limit_seconds?: number | null; git_graph_branch_source?: 'agent' | 'all' } | null;
}

// Deduped by project id: two project_members rows for the same project (an
// invite claimed on top of an existing membership) would otherwise yield two
// identical entries — duplicate React keys in every list rendering `projects`.
function toSummaries(rows: MemberRow[] | null): ProjectSummary[] {
  const seen = new Set<string>();
  return (rows ?? [])
    .filter((r): r is MemberRow & { projects: NonNullable<MemberRow['projects']> } => r.projects != null)
    .filter(r => !seen.has(r.projects.id) && !!seen.add(r.projects.id))
    .map(r => ({ id: r.projects.id, name: r.projects.name, plan: r.projects.plan, role: r.role, is_demo: r.projects.is_demo ?? false, created_at: r.projects.created_at ?? null, pr_auto_merge: r.projects.pr_auto_merge ?? false, ota_rate_limit_seconds: r.projects.ota_rate_limit_seconds ?? null, git_graph_branch_source: r.projects.git_graph_branch_source ?? 'agent' }));
}

async function fetchMemberships(): Promise<ProjectSummary[]> {
  const { data, error } = await supabase
    .from('project_members')
    .select('role, projects(id, name, plan, is_demo, created_at, pr_auto_merge, ota_rate_limit_seconds, git_graph_branch_source)')
    .order('created_at', { ascending: true });

  // is_demo / pr_auto_merge / ota_rate_limit_seconds columns may not exist yet (migration pending) — fall back gracefully.
  if (error) {
    const { data: fallback } = await supabase
      .from('project_members')
      .select('role, projects(id, name, plan)')
      .order('created_at', { ascending: true });
    return toSummaries(fallback as unknown as MemberRow[] | null);
  }

  return toSummaries(data as unknown as MemberRow[] | null);
}

const INVITE_FAIL_MSG: Record<string, string> = {
  claimed: 'This invite was already used.',
  expired: 'This invite has expired.',
  revoked: 'This invite is no longer valid.',
  invalid: 'Invalid invite.',
};

export function CurrentProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects]         = useState<ProjectSummary[] | null>(null);
  const [currentProjectId, setCurrentId] = useState<string | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const tenant        = useTenant();
  const tenantLoading = useTenantLoading();

  async function load() {
    // A customer invite parked by the LoginPage claims BEFORE memberships are
    // fetched, so the freshly-claimed workspace is in the first project list —
    // and writing it to LS_KEY makes the saved-project pick land the customer
    // directly in it. A failed claim never blocks login; it just surfaces a
    // banner over the normal personal/demo projects.
    const claim = await claimPendingInvite();
    if (claim) {
      if (claim.ok) localStorage.setItem(LS_KEY, claim.projectId);
      else setInviteNotice(INVITE_FAIL_MSG[claim.reason] ?? INVITE_FAIL_MSG.invalid);
    }

    let rows = await fetchMemberships();

    // Branded tenant domain (0105): the session is LOCKED to the tenant's
    // workspace — personal/demo projects don't exist on this origin.
    if (tenant) rows = rows.filter(r => r.id === tenant.projectId);

    // Provision missing projects, then re-read. ensure_personal_project is
    // idempotent and creates whichever projects the caller lacks:
    //   • brand-new users (no rows) get their personal project, and
    //   • users created before the demo-project migration get the demo project
    //     on their next dashboard load.
    // NEVER on a tenant domain — a non-member landing there must get the
    // access-denied panel below, not a freshly provisioned personal project.
    if (!tenant && (rows.length === 0 || !rows.some(r => r.is_demo))) {
      const { error } = await supabase.rpc('ensure_personal_project');
      // The session outlived its account: `owner_id` points at a deleted auth.users
      // row, so provisioning can never succeed. Drop the session — AuthGate unmounts
      // this provider and renders the login page.
      if (isOrphanedUserError(error)) {
        await forceSignOut();
        return;
      }
      rows = await fetchMemberships();
    }

    setProjects(rows);
    const saved        = localStorage.getItem(LS_KEY);
    const savedIsValid = rows.some(r => r.id === saved);
    const demoId       = rows.find(r => r.is_demo)?.id;
    // Demo mode lands on the account's is_demo project (its mock fleet is what
    // the self-heal breaks) WITHOUT touching LS_KEY, so leaving the demo
    // restores the saved workspace. A tenant domain has no demo row → unchanged.
    const pick         = DEMO_MODE && demoId
      ? demoId
      : savedIsValid ? saved! : (demoId ?? rows[0]?.id ?? null);
    setCurrentId(pick);
  }

  // Gated on the tenant lookup so the workspace lock can never race it; the
  // provider renders its loading state until then either way.
  useEffect(() => {
    if (!tenantLoading) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantLoading]);

  function setCurrentProjectId(id: string) {
    localStorage.setItem(LS_KEY, id);
    setCurrentId(id);
  }

  // Signed in on a branded tenant domain without membership in that workspace:
  // a dead end by design — never provision or reveal other projects here.
  if (tenant && projects !== null && projects.length === 0) {
    return (
      <div style={{
        height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 12, color: '#000',
        background: '#faf9f5', padding: 20, textAlign: 'center',
      }}>
        {tenant.logoUrl && <img src={tenant.logoUrl} alt="" style={{ height: 64, width: 'auto' }} />}
        <div style={{ fontSize: 15, fontWeight: 'bold' }}>{tenant.displayName}</div>
        <div style={{ fontSize: 13, maxWidth: 420 }}>
          Your account doesn't have access to the {tenant.displayName} workspace.
          If you have an invite code, sign out and use “Claim your workspace” on the login page.
        </div>
        <button
          onClick={() => { void supabase.auth.signOut(); }}
          style={{
            fontSize: 13, fontWeight: 'bold', cursor: 'pointer',
            background: 'var(--brand-accent, #000)', color: '#fff',
            border: '1px solid var(--brand-accent, #000)', padding: '8px 16px', borderRadius: 0,
          }}
        >
          Sign out
        </button>
      </div>
    );
  }

  if (projects === null || currentProjectId === null) {
    return (
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13, color: '#666',
      }}>
        {projects !== null && projects.length === 0 ? 'No project available.' : 'Loading project…'}
      </div>
    );
  }

  const currentProject = projects.find(p => p.id === currentProjectId)!;

  return (
    <Ctx.Provider value={{ projects, currentProjectId, currentProject, setCurrentProjectId, reload: load }}>
      {inviteNotice && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
          padding: '6px 12px', background: '#fff3cd', borderBottom: '1px solid #000',
          fontSize: 13, color: '#000',
        }}>
          <span>{inviteNotice}</span>
          <button
            onClick={() => setInviteNotice(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, textDecoration: 'underline', padding: 0 }}
          >
            dismiss
          </button>
        </div>
      )}
      {children}
    </Ctx.Provider>
  );
}

export function useCurrentProject(): CurrentProjectValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCurrentProject must be used within a CurrentProjectProvider');
  return v;
}

/**
 * Non-throwing variant for shared add-on hooks (src/core/hooks, src/add-ons/<addon>/hooks) that run
 * under BOTH nff-app (wrapped in CurrentProjectProvider by AuthGate.tsx) and
 * standalone nff-admin (which has no such provider — it has no notion of
 * "current project" and always acts on its own vendor workspace). Returns
 * null outside a provider instead of throwing.
 */
export function useCurrentProjectIdOptional(): string | null {
  return useContext(Ctx)?.currentProjectId ?? null;
}
