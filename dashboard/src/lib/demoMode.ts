/**
 * "Demo mode": the opposite hypothesis to onboarding mode (onboardingMode.ts).
 * Onboarding fakes a brand-new workspace; the demo assumes EVERYTHING is already
 * set up — brain, mock fleet, tools — so the only thing left is to press
 * "Trigger the self-heal demo" and watch nff break a device and heal it.
 *
 * Five read points are masked, nothing is written: CurrentProjectContext picks the
 * account's is_demo project (its mock fleet is kept alive by useDemoFleetSeed),
 * useProjectBrain serves the canned graph (data/demoBrain.ts), App hides every
 * rail group but Overview and collapses the story's tab jumps onto it, and the
 * tour never auto-opens. Available in production on purpose — a demo is given
 * from whatever build is in front of the prospect.
 *
 * sessionStorage so it survives the connectors' OAuth round-trips but dies with
 * the tab. Read once at import: setDemoMode reloads, which is what resets the
 * story state. Entering the demo also leaves onboarding mode — the two are
 * mutually exclusive hypotheses about the workspace.
 */
const KEY = 'nff.demoMode';

export const DEMO_MODE = globalThis.sessionStorage?.getItem(KEY) === '1';

export function setDemoMode(on: boolean) {
  if (on) {
    sessionStorage.setItem(KEY, '1');
    sessionStorage.removeItem('nff.devOnboarding');
  } else {
    sessionStorage.removeItem(KEY);
  }
  location.reload();
}
