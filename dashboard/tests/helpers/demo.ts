import { expect, type Page } from '@playwright/test';

// Shared page helpers for the dashboard e2e specs. Selectors are the stable ones confirmed
// during exploration: nav/sub-tab buttons carry data-tour="nav-*"/"subtab-*"; status dots are
// StatusBadge <span title="online|warning|error|offline">; the demo panels are scoped by their
// header text; the always-mounted FleetIncidentModal shows "Fleet incident" / "Fleet recovered".

export const APP_SHELL = 'IoT Monitor';

// Reboot scenarios self-heal on next boot (cheap); OTA scenarios need a real agent code-fix + OTA.
export const REBOOT_SCENARIO = 'watchdog';
export const OTA_SCENARIO = 'null_deref';

export async function gotoDashboard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByText(APP_SHELL)).toBeVisible({ timeout: 30_000 });
}

export function navButton(page: Page, group: string) {
  return page.locator(`[data-tour="nav-${group}"]`);
}

export async function openTab(page: Page, group: string): Promise<void> {
  await navButton(page, group).click();
}

// The Overview DEMO badge only renders inside a demo project — the gate for every demo control.
export async function assertInDemoProject(page: Page): Promise<void> {
  await openTab(page, 'overview');
  await expect(page.getByText('DEMO', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
}

// ── the "▸ Mock fleet" spawn panel (DemoSpawnPanel) ──────────────────────────────────
// The inputs carry implicit accessible names from their wrapping <label> ("spawn devices",
// "crash of N online"), so target by role+name page-wide — no fragile ancestor scoping, and no
// collision with the chaos panel's own number input.
export async function spawnMocksViaUI(page: Page, count: number): Promise<void> {
  await openTab(page, 'overview');
  await page.getByRole('spinbutton', { name: /spawn/i }).fill(String(count));
  await page.getByRole('button', { name: /Spawn \(\d+\)/ }).click();
  // Server accepted the spawn; the mocks then connect asynchronously.
  await expect(page.getByText(/booting/i)).toBeVisible({ timeout: 30_000 });
}

// ── the Dashboard device table ───────────────────────────────────────────────────────
export async function waitForMockRow(page: Page, timeout = 90_000): Promise<void> {
  await openTab(page, 'dashboard');
  await expect(page.getByText(/mock-/).first()).toBeVisible({ timeout });
}

export async function waitForOnlineDevice(page: Page, timeout = 120_000): Promise<void> {
  await openTab(page, 'dashboard');
  await expect(page.locator('[title="online"]').first()).toBeVisible({ timeout });
}

// Ensure at least one online mock exists (spawn one if the fleet is empty), so the
// break-and-self-heal controls have a target.
export async function ensureOnlineMock(page: Page): Promise<void> {
  await openTab(page, 'dashboard');
  if (await page.locator('[title="online"]').count() > 0) return;
  await spawnMocksViaUI(page, 1);
  await waitForOnlineDevice(page, 120_000);
}

// ── the "⚡ Demo — break & self-heal" panel (DemoChaosPanel) ──────────────────────────
// Trigger the break+self-heal cascade for `count` devices with the given scenario id.
// Requires an online mock (see ensureOnlineMock) — otherwise the panel hides its controls.
export async function breakAndSelfHeal(page: Page, scenario: string, count = 1): Promise<void> {
  await openTab(page, 'overview');
  await expect(page.getByText('No mock devices online')).toHaveCount(0);
  await page.getByRole('combobox', { name: /scenario/i }).selectOption(scenario);
  await page.getByRole('spinbutton', { name: /crash/i }).fill(String(count));
  await page.getByRole('button', { name: /Break \+ self-heal/ }).click();
}

// The break cascade posts per device then sets a status line ending in "self-healing" /
// "fixing the code". Confirms the crash + agent hand-off actually fired.
export async function expectHealKickedOff(page: Page): Promise<void> {
  await expect(page.getByText(/fixing the code|self-healing/i)).toBeVisible({ timeout: 30_000 });
}

// ── the global FleetIncidentModal (always mounted, any tab) ───────────────────────────
export async function waitForIncident(page: Page, timeout = 45_000): Promise<void> {
  await expect(page.getByText(/Fleet incident/)).toBeVisible({ timeout });
}

export async function waitForRecovered(page: Page, timeout = 120_000): Promise<void> {
  await expect(page.getByText(/Fleet recovered/)).toBeVisible({ timeout });
}
