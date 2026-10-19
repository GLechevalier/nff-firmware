import { useEffect, useState } from 'react';
import { ONBOARDING_MODE } from '../lib/onboardingMode';
import { DEMO_MODE } from '../lib/demoMode';

/**
 * First-run onboarding state, persisted per user in localStorage (same idiom as
 * WelcomeBanner's dismissal flag). The tour auto-opens once per user; `finish`
 * records that it has been seen, `start` replays it on demand without clearing
 * the seen flag (so a manual replay doesn't re-trigger the auto-open later).
 * v3: the gated "grow your brain" loop — bumped so users who saw the narrated v2 get it once.
 *
 * `path` is the persona picked in the modal that opens FIRST (OnboardingPathModal):
 * Dev → physical devices | pure software, or Sales. The tour waits on it; the rest of
 * onboarding branches on it. Asked once per user; a "? Tour" replay skips the modal.
 *
 * Under the local onboarding mode the flags are ignored on both ends: the tour
 * auto-opens every load, the path is asked again every reload, and nothing is written.
 */
const LS_PREFIX = 'nff.onboarding.v3.';

export type OnboardingPath = 'dev-physical' | 'dev-soft';
const PATHS: readonly OnboardingPath[] = ['dev-physical', 'dev-soft'];
export const parseOnboardingPath = (raw: string | null): OnboardingPath | null =>
  (PATHS as readonly string[]).includes(raw ?? '') ? (raw as OnboardingPath) : null;

export function useOnboarding(userId: string) {
  const key = LS_PREFIX + userId;
  const pathKey = LS_PREFIX + 'path.' + userId;
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<OnboardingPath | null>(
    () => (ONBOARDING_MODE ? null : parseOnboardingPath(localStorage.getItem(pathKey))),
  );

  useEffect(() => {
    // Never over a demo: the tour is the brand-new-workspace story, the demo is the opposite one.
    if (!DEMO_MODE && (ONBOARDING_MODE || !localStorage.getItem(key))) setOpen(true);
  }, [key]);

  function choosePath(p: OnboardingPath) {
    if (!ONBOARDING_MODE) localStorage.setItem(pathKey, p);
    setPath(p);
  }

  function finish() {
    if (!ONBOARDING_MODE) localStorage.setItem(key, '1');
    setOpen(false);
  }

  function start() {
    setOpen(true);
  }

  return { open, path, choosePath, start, finish };
}
