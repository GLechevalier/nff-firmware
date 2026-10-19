import { test, expect } from '@playwright/test';

// The public demo embed (demo.html) is a scripted, no-login, no-backend page — so this
// spec runs green with zero setup (no test user, no Supabase, no dev stack). It's the
// smoke test that proves the Playwright harness itself works end to end.

test('the no-login demo renders and plays', async ({ page }) => {
  await page.goto('/demo.html');

  // The demo mounts into #root and shows the scripted agent-fixing-a-device timeline.
  const root = page.locator('#root');
  await expect(root).not.toBeEmpty();
  // The scripted stream references the fleet / a device — give it a moment to render.
  await expect(root).toContainText(/device/i, { timeout: 15_000 });

  await page.screenshot({ path: 'test-results/demo.png', fullPage: true });
});
