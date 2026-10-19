import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { darkenHex, fetchTenant, resolveTenantHostname, type Tenant } from '../lib/tenant';

/**
 * Resolves the tenant for the current hostname once at boot and applies the
 * document-level branding (title, favicon, accent CSS variable).
 *
 * NON-BLOCKING by design: children render immediately with tenant = null and
 * re-render when the lookup lands (~a fast anon RPC). The one consumer where
 * that would be a correctness bug — CurrentProjectProvider, whose membership
 * lock must not race the lookup — gates its own load() on `tenantLoading`
 * instead. Cosmetic consumers (LoginPage, TabBar) just flash default branding
 * for a beat on first paint, the accepted trade against delaying the main
 * domain's login page by a round-trip.
 */

interface TenantValue {
  tenant: Tenant | null;
  tenantLoading: boolean;
}

const Ctx = createContext<TenantValue>({ tenant: null, tenantLoading: true });

export function TenantProvider({ children }: { children: ReactNode }) {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [tenantLoading, setTenantLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void fetchTenant(resolveTenantHostname()).then(t => {
      if (cancelled) return;
      setTenant(t);
      setTenantLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!tenant) return;
    document.title = tenant.displayName;
    if (tenant.logoUrl) {
      const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
      if (link) link.href = tenant.logoUrl;
    }
    if (tenant.accentColor) {
      document.documentElement.style.setProperty('--brand-accent', tenant.accentColor);
      // Hover shade for sites whose handlers previously hard-coded '#222'.
      document.documentElement.style.setProperty('--brand-accent-hover', darkenHex(tenant.accentColor, 0.15));
    }
  }, [tenant]);

  return <Ctx.Provider value={{ tenant, tenantLoading }}>{children}</Ctx.Provider>;
}

export function useTenant(): Tenant | null {
  return useContext(Ctx).tenant;
}

export function useTenantLoading(): boolean {
  return useContext(Ctx).tenantLoading;
}
