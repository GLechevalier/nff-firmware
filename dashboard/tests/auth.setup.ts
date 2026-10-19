import { test as setup, expect } from '@playwright/test';

// Signs in through the real login form once, then saves the Supabase session so the
// `dashboard` project starts already authenticated (no re-login per test). The saved
// state lands in .auth/user.json (gitignored). Credentials come from
// nff-app/.env.local.dev — seed/confirm that user with `npm run test:seed-user`.
const authFile = '.auth/user.json';

setup('authenticate against dev Supabase', async ({ page }) => {
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'TEST_USER_EMAIL / TEST_USER_PASSWORD are not set.\n' +
      'Set TEST_USER_EMAIL / TEST_USER_PASSWORD in nff-app/.env.local.dev (see .env.example) and run `npm run test:seed-user`.',
    );
  }

  await page.goto('/');

  // The labels aren't associated to inputs (no htmlFor), so target by input type —
  // the login form has exactly one email + one password field.
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  // "Sign in →" submit button (not the OAuth "Continue with ..." buttons).
  await page.getByRole('button', { name: /sign in/i }).click();

  // The sidebar header ("IoT Monitor") only renders once AuthGate swaps LoginPage → App.
  await expect(page.getByText('IoT Monitor')).toBeVisible({ timeout: 30_000 });

  // A brand-new user auto-opens the first-run onboarding tour, whose full-screen
  // dimming overlay intercepts every click. Mark it "seen" (useOnboarding's per-user
  // localStorage flag) and bake that into the saved session so the click-through
  // tests aren't blocked by it. The user id comes from the Supabase auth token.
  await page.evaluate(() => {
    const authKey = Object.keys(localStorage).find((k) => k.startsWith('sb-') && k.endsWith('-auth-token'));
    if (!authKey) return;
    try {
      const uid = JSON.parse(localStorage.getItem(authKey) as string)?.user?.id;
      if (uid) localStorage.setItem('nff.onboarding.v3.' + uid, '1');
    } catch { /* leave the tour on if we can't parse the session */ }
  });

  await page.context().storageState({ path: authFile });
});
