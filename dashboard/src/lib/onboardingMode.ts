import { DEV_MODE } from './devMode';

/**
 * Local-only "brand new workspace" mask. The onboarding flow (the gated tour, the
 * seed-hub brain, the rail lenses) is only visible to someone whose brain is empty
 * and whose sources are all disconnected — which a developer's own workspace never
 * is. This makes the app BELIEVE it is that new workspace so the flow can be tested
 * against a real account: nothing is written, synced or deleted, four read points
 * are simply masked (useProjectBrain, useSourceStatus, App's connections, useOnboarding).
 *
 * DEV_MODE-gated, so it cannot exist in a production build. sessionStorage (like
 * `nff.devTenant`) so it survives the connectors' OAuth round-trips but dies with
 * the tab. Read once at import: setOnboardingMode reloads, which is what restarts
 * every tour gate (nodesAdded / chatReplied / seedRevealed) as genuinely unsatisfied.
 */
const KEY = 'nff.devOnboarding';

// globalThis.: read at import time, so a node-env unit test that pulls in any
// consumer of this module must not blow up on a missing sessionStorage.
export const ONBOARDING_MODE = DEV_MODE && globalThis.sessionStorage?.getItem(KEY) === '1';

export function setOnboardingMode(on: boolean) {
  if (on) sessionStorage.setItem(KEY, '1');
  else sessionStorage.removeItem(KEY);
  location.reload();
}
