import { useMemo } from 'react';
import { useCodeStream } from './useCodeStream';
import { useGithubConnections } from '../add-ons/github/hooks/useGithubConnections';
import { useDemoBrokeAt, useDemoBrokenNow } from '../context/DeviceHealthContext';
import { BABYNFF_MAIN_C_BUGGY, BABYNFF_MAIN_PATH } from '../data/babynffFirmware';
import { BABYNFF_BRANCH, BABYNFF_REPO } from '../data/babynffRepo';
import { FIX_BRANCH, FIX_TITLE, babynffBreakPr } from '../data/babynffDemoGit';
import { SEED_MARKER, demoFixSource } from '../data/babynffCodeStream';
import type { CodeFile } from '../types/code';
import type { DemoPullRequest } from '../types/demoPr';

// Derive the break-demo's "pull requests" from what actually happened.
//
// There are two, and they tell the whole story:
//
//   #1 the BREAK — clean → buggy. Merged. A plausible little feature (reading an I2C temperature
//      sensor) whose author forgot the read fails while the bus is busy. Not a code-stream row: the
//      break is something the demo DID, anchored to devices.demo_fault_since (migration 0080), so it
//      survives a reload and outlives the heal. See data/babynffDemoGit.ts.
//
//   #2+ the FIX — buggy → whatever the agent wrote. The demo heals through nff-ota's
//      submit_firmware_fix, not GitHub (the bundled demo repo has no App installation, so
//      open_fix_pr can't run against it). But the fix IS captured: the worker surfaces
//      submit_firmware_fix(source=…) as a drafted file named `firmware.ino`
//      (nff-agent-worker/src/engine/format.ts) and persists it to agent_code_streams.files in the
//      CALLER's project. Diffing that against the sketch that was seeded reconstructs exactly the
//      change the agent made — no fabrication, no new table, and it survives a reload because the
//      row is durable. See types/demoPr.ts.
//
// `demoFixSource` (data/babynffCodeStream.ts) pulls the agent's fixed sketch out of a run's files:
// it knows the synthetic path the pathless blob lands under, strips the seed marker, and rejects a
// run that drafted some OTHER scenario's sketch. The Code tab adopts the same rows through the same
// module, so the PR and the diff can never disagree about what the agent wrote.

/**
 * The demo PRs for the current project, oldest first (so `number` is stable as runs accumulate).
 * Empty unless the bundled demo repo is present — a project with a real connected repo gets its
 * PRs from GitHub, and the virtual connection vanishes the moment one is connected.
 */
export function useDemoPullRequests(): DemoPullRequest[] {
  const { history, live } = useCodeStream();
  const { connections } = useGithubConnections();
  // The durable break markers (devices.demo_fault_*), not the client-only in-memory ones: a reload
  // mid-heal must still show the break PR and leave the fix PR open.
  //   • brokeAt   — when the break fired; null until it has. Never clears.
  //   • brokenNow — the fix hasn't landed yet, so the newest fix PR is still open.
  const brokeAt = useDemoBrokeAt();
  const brokenNow = useDemoBrokenNow();

  const hasDemoRepo = connections.some(c => c.virtual);

  const base = BABYNFF_MAIN_C_BUGGY.replace(SEED_MARKER, '');

  return useMemo(() => {
    if (!hasDemoRepo) return [];

    // Live wins over history for the same run (it carries the freshest files), mirroring CodeTab.
    const byRun = new Map<string, { files: CodeFile[]; when: Date }>();
    for (const h of history) byRun.set(h.id, { files: h.files, when: h.createdAt });
    for (const s of live) byRun.set(s.runId, { files: s.files, when: s.startedAt });

    const fixes = [...byRun.entries()]
      .map(([runId, run]) => ({ runId, run, head: demoFixSource(run.files) }))
      // A code-stream row opens as soon as the agent READS the crashing sketch
      // (codeStream.ts's REPO_TOOL matches firmware_source), so gate on the fix file existing —
      // not on the run existing — or a PR appears before one was written.
      .filter((x): x is typeof x & { head: string } => x.head !== null)
      .sort((a, b) => a.run.when.getTime() - b.run.when.getTime());

    // #1 is the break, when there has been one. The fixes number from #2.
    const prs: DemoPullRequest[] = brokeAt ? [babynffBreakPr(brokeAt)] : [];

    for (const [i, x] of fixes.entries()) {
      prs.push({
        number: i + 2,
        runId: x.runId,
        title: FIX_TITLE,
        repoFullName: BABYNFF_REPO,
        headBranch: FIX_BRANCH,
        baseBranch: BABYNFF_BRANCH,
        path: BABYNFF_MAIN_PATH,
        base,
        head: x.head,
        openedAt: x.run.when,
        // Only the newest run can still be in flight; older ones healed long ago.
        status: brokenNow && i === fixes.length - 1 ? 'open' : 'merged',
      });
    }

    return prs;
  }, [hasDemoRepo, history, live, brokeAt, brokenNow, base]);
}
