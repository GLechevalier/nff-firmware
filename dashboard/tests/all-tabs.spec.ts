import { test, expect } from '@playwright/test';
import { gotoDashboard, navButton } from './helpers/demo';

// SCENARIO 1 — "see all tabs, click through them to monitor the system".
// Pure UI, deterministic: no backend beyond Supabase reads. For each nav group and sub-tab we
// click it, assert it becomes active (inverted black background — data-independent), and where a
// tab has a distinctive, non-colliding content string, assert that rendered too. A screenshot per
// tab lands in test-results/tabs/ for a human to eyeball the whole surface.

// Distinctive per-tab content signals (each string appears in exactly one tab, so no visibility
// collision). null = assert active state only (graph tabs / strings that collide with nav labels).
const NAV_SIGNALS: Record<string, RegExp | null> = {
  overview: null,                  // the brain graph (SVG) — no stable heading
  sources: /Flash an ESP32 over USB/, // the Devices source card
  agents: /Agent Priorities/,     // landing sub-tab = Management
  dashboard: /Device ID/,          // device table header
  deploy: /Firmware/,              // landing sub-tab = Releases (TabBar's defaultTab: 'ota')
  // A demo project browses the bundled babynff repo; any other project with no repo says so.
  code: /babynff-repo|No repo connected/,
  crash: null,
  enrollment: /Device Enrollment/,
  security: null,                  // DEV_MODE only
  settings: null,                  // "Settings" collides with the nav label
};

const SUBTAB_SIGNALS: Record<string, RegExp | null> = {
  'agent-management': /Agent Priorities/,
  brain: null,                     // SVG graph, no stable heading
  policy: null,                    // SVG graph, no stable heading
  'chat-history': null,
  github: /Repositories/,
  ota: /Firmware/,                 // always-present panel on the Releases tab
  groups: /Device groups/,
};

const BLACK = 'rgb(0, 0, 0)';

test.beforeEach(async ({ page }) => {
  await gotoDashboard(page);
});

test('every nav group activates and renders', async ({ page }) => {
  const groups = await page
    .locator('[data-tour^="nav-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-tour')!.slice('nav-'.length)));
  expect(groups.length).toBeGreaterThan(0);

  for (const g of groups) {
    const btn = page.locator(`[data-tour="nav-${g}"]`);
    await btn.click();
    await expect(btn, `nav ${g} should become active`).toHaveCSS('background-color', BLACK);

    const signal = NAV_SIGNALS[g];
    if (signal) {
      // Inactive tabs stay mounted (display:none), so match only the visible instance.
      await expect(page.getByText(signal).filter({ visible: true }).first(), `${g} tab content`)
        .toBeVisible({ timeout: 10_000 });
    }
    await page.screenshot({ path: `test-results/tabs/nav-${g}.png`, fullPage: true });
  }
});

test('every sub-tab activates and renders', async ({ page }) => {
  // Sub-tabs only exist under the multi-tab groups (agents, deploy).
  for (const group of ['agents', 'deploy']) {
    if (await page.locator(`[data-tour="nav-${group}"]`).count() === 0) continue;
    await page.locator(`[data-tour="nav-${group}"]`).click();

    const subs = await page
      .locator('[data-tour^="subtab-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-tour')!.slice('subtab-'.length)));

    for (const s of subs) {
      const btn = page.locator(`[data-tour="subtab-${s}"]`);
      await btn.click();
      await expect(btn, `sub-tab ${s} should become active`).toHaveCSS('background-color', BLACK);

      const signal = SUBTAB_SIGNALS[s];
      if (signal) {
        await expect(page.getByText(signal).filter({ visible: true }).first(), `${s} sub-tab content`)
          .toBeVisible({ timeout: 10_000 });
      }
      await page.screenshot({ path: `test-results/tabs/subtab-${s}.png`, fullPage: true });
    }
  }
});

// SCENARIO 1b — Sources on the rail + the gated "grow your brain" tour. The Sources tab holds
// the Devices card (hardware-as-a-source actions) and the connector Store; the tour's first gated
// step waits on a source and offers "Skip this step".
test('sources tab renders and the tour gates on a source', async ({ page }) => {
  await navButton(page, 'sources').click();
  await expect(page.getByText(/Flash an ESP32 over USB/)).toBeVisible();
  await expect(page.getByText(/Break a device/)).toBeVisible();
  await page.screenshot({ path: 'test-results/sources.png', fullPage: true });

  // The Web Serial flasher opens from the Devices card; close it.
  await page.getByRole('button', { name: /Flash an ESP32 over USB/i }).click();
  await expect(page.getByText('Flash your ESP32 over USB')).toBeVisible();
  await page.getByLabel('Close').click();
  await expect(page.getByText('Flash your ESP32 over USB')).toHaveCount(0);

  // Settings no longer carries the Store — it lives here.
  await navButton(page, 'settings').click();
  await expect(page.getByText('Add or remove parts of the app')).toHaveCount(0);

  // The tour: step 1 narrates, step 2 is gated on a source (skippable), then skip out.
  await page.locator('[data-tour="tour-launch"]').click();
  // The path modal opens first (this user never picked one); the tour waits on it.
  await page.getByRole('button', { name: 'Pure software' }).click();
  await expect(page.getByText('1 / 8')).toBeVisible();
  await page.getByRole('button', { name: /Next/ }).click();
  await expect(page.getByText('2 / 8')).toBeVisible();
  await page.screenshot({ path: 'test-results/tour-sources.png', fullPage: true });
  await page.getByRole('button', { name: 'Skip tour' }).click();
  await expect(page.getByText(/\/ 8$/)).toHaveCount(0);
});
