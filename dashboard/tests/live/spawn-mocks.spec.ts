import { test, expect } from '@playwright/test';
import { requireStack, LIVE_PORTS } from '../helpers/stack';
import {
  gotoDashboard,
  assertInDemoProject,
  spawnMocksViaUI,
  waitForMockRow,
  waitForOnlineDevice,
} from '../helpers/demo';

// SCENARIO 2 — "spawn mock devices to try nff in demo mode".
// Tier B (`live`): needs the mock controller + docker fleet + nff-ota up. Auto-skips otherwise.
// No agent, no token spend.

test.describe('spawn mock devices (demo mode)', () => {
  test.beforeAll(async () => {
    await requireStack(LIVE_PORTS, 'scenario 2 (spawn mocks)');
  });

  test.beforeEach(async ({ page }) => {
    await gotoDashboard(page);
    // Every demo control is gated on being in a demo project.
    await assertInDemoProject(page);
  });

  test('spawning brings virtual devices online', async ({ page }) => {
    await spawnMocksViaUI(page, 2);

    // The controller mints certs + connects each mock over mTLS/MQTT, which surfaces real
    // `devices` rows via realtime. They appear in the device table, then flip to online.
    await waitForMockRow(page, 90_000);
    await waitForOnlineDevice(page, 120_000);

    await expect(page.locator('[title="online"]').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/live/spawned-fleet.png', fullPage: true });
  });
});
