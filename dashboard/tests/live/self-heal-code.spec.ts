import { expect, test } from '@playwright/test';
import { requireStack, requireHealOptIn, HEAL_PORTS } from '../helpers/stack';
import {
  gotoDashboard,
  assertInDemoProject,
  ensureOnlineMock,
  breakAndSelfHeal,
  waitForIncident,
  waitForRecovered,
  openTab,
  OTA_SCENARIO,
} from '../helpers/demo';

// SCENARIO 4 — "insert a bug in the code and watch it self-heal" (browser-drivable essence).
// Uses an OTA/code-fix scenario (null_deref): /api/demo/selfheal seeds a REAL buggy .ino into the
// mock's held firmware (nff-ota compile.py detects the fault; build_id = sha256(source)), the mock
// crash-loops on genuine code, and the agent reads the source, edits out the bug
// (submit_firmware_fix), OTA-ships it, and the device recovers — no git push.
// (The literal "edit source + git push" Track-2 story is the Python e2e harness; see tests/README.md.)
//
// This scenario is Tier C only: seeding a code-fix bug inherently triggers a real agent run (the
// selfheal endpoint inserts the agent hand-off), so there is no token-free "kick-off" variant —
// it always spends tokens. Hence it runs only under RUN_HEAL=1 (`npm run test:e2e:heal`).

test.describe('insert bug -> self-heal (held code) — full recovery @heal', () => {
  test.beforeAll(async () => {
    await requireStack(HEAL_PORTS, 'scenario 4 recovery');
    requireHealOptIn();
  });

  // The agent must diagnose, edit real source, and OTA-recover — allow several minutes.
  test('the agent fixes the real code and the device recovers @heal', async ({ page }) => {
    test.setTimeout(360_000);
    await gotoDashboard(page);
    await assertInDemoProject(page);
    await ensureOnlineMock(page);

    await breakAndSelfHeal(page, OTA_SCENARIO, 1);
    await waitForIncident(page, 60_000);

    await waitForRecovered(page, 300_000);
    await page.screenshot({ path: 'test-results/live/selfheal-code-recovered.png', fullPage: true });

    // The fix surfaces as a demo pull request in the GitHub tab (useDemoPullRequests derives it
    // from the agent's code-stream row). It is not a GitHub PR — the bundled demo repo has no App
    // installation — so it is DEMO-badged and carries a diff instead of a link.
    await openTab(page, 'github');
    await expect(page.getByText('Pull requests', { exact: true })).toBeVisible({ timeout: 15_000 });
    const pr = page.getByText(/Guard the NULL sensor read/).first();
    await expect(pr).toBeVisible({ timeout: 15_000 });

    // Opening it shows the agent's actual change: the added NULL guard.
    await pr.click();
    await expect(page.getByText('Pull request detail')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/if \(r == NULL\)|if \(r\)|if \(r != nullptr\)/).first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: 'test-results/live/selfheal-demo-pr.png', fullPage: true });
  });
});
