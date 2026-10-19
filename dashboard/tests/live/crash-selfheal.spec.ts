import { test } from '@playwright/test';
import { requireStack, LIVE_PORTS } from '../helpers/stack';
import {
  gotoDashboard,
  assertInDemoProject,
  ensureOnlineMock,
  breakAndSelfHeal,
  expectHealKickedOff,
  REBOOT_SCENARIO,
} from '../helpers/demo';

// SCENARIO 3 — "see a crash -> self-heal demo" (kick-off, Tier B `live`).
// Clicks the Overview "⚡ Demo — break & self-heal" control with a REBOOT scenario (self-heals
// next boot — no agent, no tokens) and asserts the pipeline engaged. The full agent-driven
// recovery (device returns online after a real code fix) is the token-spending @heal test in
// self-heal-code.spec.ts.

test.describe('crash -> self-heal — kick-off', () => {
  test.beforeAll(async () => {
    await requireStack(LIVE_PORTS, 'scenario 3 kick-off');
  });

  test('breaking a mock engages the self-heal pipeline', async ({ page }) => {
    await gotoDashboard(page);
    await assertInDemoProject(page);
    await ensureOnlineMock(page);

    await breakAndSelfHeal(page, REBOOT_SCENARIO, 1);

    // The cascade posts /api/demo/selfheal per device (fleet delivers a real crash to the live
    // mock) then sets its "…the agent is fixing…" status — a deterministic, token-free proof
    // that the user-facing break+self-heal flow works end to end.
    await expectHealKickedOff(page);
    await page.screenshot({ path: 'test-results/live/crash-kickoff.png', fullPage: true });
  });
});
