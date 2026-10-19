import { useSyncExternalStore } from 'react';
import { subscribeServiceStatus, serviceStatusVersion, getServiceInfo } from '../lib/serviceStatusStore';

export type ServiceName = 'nff-fleet' | 'nff-ota' | 'nff-agent-worker' | 'nff-github' | 'nff-admin-worker';

export const SERVICES: ServiceName[] = ['nff-fleet', 'nff-ota', 'nff-agent-worker', 'nff-github', 'nff-admin-worker'];

// Down-but-not-critical vs down-and-critical, for the Overview tab's tri-state verdict.
export const CRITICAL_SERVICES: ServiceName[] = ['nff-admin-worker', 'nff-fleet'];

// online   — beating and reporting status 'ok'
// unhealthy — beating, but the service degraded itself (e.g. the agent worker's
//             Claude login expired: status 'auth_error', detail = the error line;
//             migration 0098). Alive-but-broken must not masquerade as online.
// offline  — beat gone stale (~3 missed beats)
export type ServiceState = 'online' | 'unhealthy' | 'offline';

// Same liveness logic as nff-dashboard's hook: services beat every ~10s into
// service_status (SELECT policy is USING(true), so any authenticated user can
// read it); ~3 missed beats = offline. The select + Realtime channel + stale
// tick live ONCE in lib/serviceStatusStore — every consumer of this hook
// shares them (ChatDock is always mounted, so tabs used to double everything).
const STALE_MS = 30_000;

export function useServiceStatus() {
  useSyncExternalStore(subscribeServiceStatus, serviceStatusVersion, serviceStatusVersion);

  function getState(service: ServiceName): { state: ServiceState; detail: string | null } {
    const entry = getServiceInfo(service);
    if (!entry || Date.now() - entry.beat >= STALE_MS) return { state: 'offline', detail: null };
    if (entry.status !== 'ok') return { state: 'unhealthy', detail: entry.detail };
    return { state: 'online', detail: null };
  }

  function isOnline(service: ServiceName): boolean {
    return getState(service).state === 'online';
  }

  return { getState, isOnline };
}
