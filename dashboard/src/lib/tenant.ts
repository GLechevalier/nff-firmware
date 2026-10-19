import { supabase } from './supabase';
import { DEV_MODE } from './devMode';

/**
 * Tenant resolution (migration 0105).
 *
 * Every customer domain serves this same SPA; the tenant — branding + a lock
 * to one workspace project — is resolved from window.location.hostname via the
 * anon `get_tenant_branding` RPC (same pre-auth pattern as checkInvite). An
 * unknown hostname, and ANY transport failure, resolve to null: the default
 * experience. Fail-open is deliberate — a Supabase blip must never brick the
 * main domain.
 *
 * Local testing (DEV_MODE only): `?tenant=<hostname>` overrides the hostname
 * and persists to sessionStorage so it survives OAuth round-trips and reloads
 * within the tab; `?tenant=off` clears it.
 */

export interface Tenant {
  hostname: string;
  displayName: string;
  logoUrl: string | null;
  accentColor: string | null;
  hiddenGroups: string[];
  projectId: string;
}

const DEV_TENANT_KEY = 'nff.devTenant';

/** Darken a #rrggbb color by `amount` (0..1) — used for the accent hover shade. */
export function darkenHex(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const scale = (c: number) => Math.max(0, Math.round(c * (1 - amount)));
  const r = scale((n >> 16) & 0xff);
  const g = scale((n >> 8) & 0xff);
  const b = scale(n & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export function resolveTenantHostname(): string {
  if (DEV_MODE) {
    const param = new URLSearchParams(window.location.search).get('tenant');
    if (param === 'off') sessionStorage.removeItem(DEV_TENANT_KEY);
    else if (param) sessionStorage.setItem(DEV_TENANT_KEY, param.toLowerCase());
    const override = sessionStorage.getItem(DEV_TENANT_KEY);
    if (override) return override;
  }
  return window.location.hostname.toLowerCase();
}

export async function fetchTenant(hostname: string): Promise<Tenant | null> {
  try {
    const { data, error } = await supabase.rpc('get_tenant_branding', { p_hostname: hostname });
    if (error) return null;
    const r = data as {
      found: boolean;
      display_name?: string;
      logo_url?: string | null;
      accent_color?: string | null;
      hidden_groups?: string[];
      project_id?: string;
    };
    if (!r?.found || !r.project_id || !r.display_name) return null;
    return {
      hostname,
      displayName: r.display_name,
      logoUrl: r.logo_url ?? null,
      accentColor: r.accent_color ?? null,
      hiddenGroups: Array.isArray(r.hidden_groups) ? r.hidden_groups : [],
      projectId: r.project_id,
    };
  } catch {
    return null;
  }
}
