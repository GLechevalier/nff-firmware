// babynffDemoGit — the break demo's "someone shipped a bad commit" beat, derived client-side.
//
// The button says "break a device and watch it self-heal", so the break has to be something that
// HAPPENED TO the fleet, not a bug that was always there. api/_selfheal.ts really does replace the
// device's firmware source (nff-ota /internal/firmware/register-source) with the buggy sketch — but
// it writes no pipeline_runs, no deployments and no ota_jobs, so nothing in the UI shows the change
// arriving. This module supplies that: the commit, the merged PR, the rollout.
//
// Nothing here is a database row, exactly like hooks/useDemoPullRequests + types/demoPr.ts (the
// pattern this follows). The bundled demo repo has no GitHub App installation, so there is no real
// commit to read; and writing real firmware_versions rows would contend for that table's GLOBAL
// version primary key. So these are pure functions over state the dashboard already streams.
//
// Everything is anchored to `brokeAt` — devices.demo_fault_since, migration 0080's durable marker,
// surfaced as useDemoBrokeAt(). That is what makes the commit and the PR survive a page reload, and
// survive the heal: healing the fleet doesn't un-merge the commit that broke it.
//
// Gate every caller on the virtual connection being present (connections.some(c => c.virtual)); a
// project with a real repo gets all of this from GitHub.

import type { GraphCommit } from '../hooks/useGitGraph';
import type { DemoPullRequest } from '../types/demoPr';
import type { Deployment } from '../add-ons/observability/types/ota';
import type { OtaJob } from '../add-ons/observability/data/mockOtaJobs';
import type { Device } from '../types/device';
import type { PipelineRun } from '../add-ons/github/types/github';
import { BABYNFF_BRANCH, BABYNFF_REPO } from './babynffRepo';
import { BABYNFF_MAIN_C_BUGGY, BABYNFF_MAIN_C_CLEAN, BABYNFF_MAIN_PATH } from './babynffFirmware';

// Stable fake shas. Short enough to read as a git sha in the UI, constant so React keys are stable.
export const BASE_COMMIT_SHA = '0f9e8d7';
export const BREAK_COMMIT_SHA = 'a1b2c3d';
export const FIX_COMMIT_SHA = 'c0ffee5';

// The production sha the build demo's merged feature lands as. Constant + fake, like the others —
// a build-demo feature (nff-feature/*) that reached `merged` folds into main as one commit here.
export const FEATURE_MERGE_SHA = 'fea70e5';

export const BREAK_BRANCH = 'feat/i2c-temperature-logging';
export const BREAK_TITLE = 'Add I2C temperature logging';
export const FIX_BRANCH = 'nff-fix/null-deref-guard';
export const FIX_TITLE = 'Guard the NULL sensor read in loop()';

/** The break PR's React key / id, standing in for the runId a real fix PR carries. */
export const BREAK_PR_RUN_ID = 'babynff-break';

/** Ids for the derived rollout, so OtaTab can recognise its own synthetic rows. */
export const BREAK_DEPLOYMENT_ID = 'babynff-break-deploy';
export const HEAL_DEPLOYMENT_ID = 'babynff-heal-deploy';

/** Stable ids for the derived pipeline runs (GithubTab's "Deploys" panel). */
export const BREAK_DEPLOY_RUN_ID = 'babynff-break-run';
export const FIX_DEPLOY_RUN_ID = 'babynff-fix-run';

/** True for a deployment this module synthesised — OtaTab must never try to abort those. */
export function isDemoDeploymentId(id: string): boolean {
  return id === BREAK_DEPLOYMENT_ID || id === HEAL_DEPLOYMENT_ID;
}

// Local semver helpers, kept in-module so this file stays import-free (it is also pulled into
// the Vercel node runtime via api/_selfheal.ts). Mirrors DeviceHealthContext / api/_selfheal.
function parseSemver(v: string | null | undefined): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec((v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}
function semverGt(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = parseSemver(a), y = parseSemver(b);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}
/** The next patch above a version — the fix's target when the device hasn't reported it yet. */
function bumpPatch(v: string | null | undefined): string {
  const [maj, min, pat] = parseSemver(v);
  return `${maj}.${min}.${pat + 1}`;
}

// The repo's first commit. Fixed in the past so it always sorts below the break, and so it doesn't
// move on re-render (a fresh Date() would churn every memo downstream).
const BASE_COMMIT_AT = new Date('2026-01-01T00:00:00Z');

/** The firmware semver the break "rolled out". Cosmetic — nothing gates on it. */
const BREAK_VERSION = '1.1.0';

/**
 * The production commit spine for the bundled demo repo, newest first.
 *
 * The break commit stays `failed` forever: its rollout genuinely did succeed, and then the fleet
 * crash-looped on it. That is the commit's verdict, and the fix is a separate commit on top — the
 * same shape a real incident leaves in a repo's history.
 */
export function babynffDemoCommits(opts: {
  brokeAt: Date | null;
  brokenNow: boolean;
  /** The agent's fix runs (oldest first) — one commit each, from useCodeStream. */
  fixes: { runId: string; when: Date }[];
}): GraphCommit[] {
  const { brokeAt, brokenNow, fixes } = opts;

  const commits: GraphCommit[] = [
    { id: BASE_COMMIT_SHA, sha: BASE_COMMIT_SHA, message: 'Initial firmware: SOS blink + nff', status: 'succeeded', prNumber: null, when: BASE_COMMIT_AT },
  ];

  if (brokeAt) {
    commits.push({
      id: BREAK_COMMIT_SHA, sha: BREAK_COMMIT_SHA, message: BREAK_TITLE,
      status: 'failed', prNumber: 1, when: brokeAt,
    });
  }

  // One commit per fix run. The newest is still deploying while the device hasn't adopted it.
  fixes.forEach((f, i) => {
    const newest = i === fixes.length - 1;
    commits.push({
      id: `${FIX_COMMIT_SHA}-${f.runId}`,
      sha: FIX_COMMIT_SHA,
      message: FIX_TITLE,
      status: newest && brokenNow ? 'deploying' : 'succeeded',
      prNumber: i + 2,          // the break PR is #1
      when: f.when,
    });
  });

  return commits.reverse();     // newest first, the order CommitGraph renders
}

/**
 * The "Develop a feature" build demo's merge, as a production commit — the branch folding into main.
 *
 * The build demo cuts an `nff-feature/*` branch, validates it on a canary, then (once green) opens a
 * PR and merges. While the feature is still open (branch_created … pr_opened) it shows as a branch
 * CARD in the graph; the moment it reaches `merged` the card drops out (OPEN_FEATURE excludes it)
 * and it belongs on main instead. This turns each such merged feature into one `succeeded` commit on
 * the production spine, so the fold is a single crisp transition. Derived, never a DB row — the demo
 * repo is virtual (no GitHub App, no pipeline_runs), same as everything else in this module.
 *
 * `features` is the dashboard's live builder_features for the babynff repo (from useBuilderFeatures).
 */
export function babynffFeatureCommits(
  features: { id: string; title: string; status: string; prNumber: number | null; updatedAt: Date | null; createdAt: Date | null }[],
): GraphCommit[] {
  return features
    .filter(f => f.status === 'merged')
    .map(f => ({
      id: `${FEATURE_MERGE_SHA}-${f.id}`,   // unique per feature; the sha itself is a stable fake
      sha: FEATURE_MERGE_SHA,
      message: f.title,
      status: 'succeeded' as const,
      prNumber: f.prNumber,
      when: f.updatedAt ?? f.createdAt ?? BASE_COMMIT_AT,
    }));
}

/**
 * The break, as a merged pull request. `base` → `head` is clean → buggy, so GithubTab's DemoPrDetail
 * renders the diff that IS the feature that broke the fleet — the artifact that explains the crash.
 *
 * Always 'merged': it is on main, which is why the devices are running it.
 */
export function babynffBreakPr(brokeAt: Date): DemoPullRequest {
  return {
    number: 1,
    runId: BREAK_PR_RUN_ID,
    title: BREAK_TITLE,
    repoFullName: BABYNFF_REPO,
    headBranch: BREAK_BRANCH,
    baseBranch: BABYNFF_BRANCH,
    path: BABYNFF_MAIN_PATH,
    base: BABYNFF_MAIN_C_CLEAN,
    head: BABYNFF_MAIN_C_BUGGY,
    openedAt: brokeAt,
    status: 'merged',
  };
}

/**
 * The rollout that carried the break to the fleet: one finished deployment plus a committed OTA job
 * per demo device, so OtaTab's Deployments and OTA Jobs panels both show the change arriving.
 *
 * 'finished' rather than an in-flight status on purpose: DeploymentRow only offers Abort on a
 * scheduled/active deployment, and there is nothing here to abort.
 *
 * Returns null before the first break.
 */
export function babynffBreakRollout(brokeAt: Date | null, devices: Device[]): {
  deployment: Deployment;
  jobs: OtaJob[];
} | null {
  if (!brokeAt) return null;

  // Only the devices the break could have targeted. `demoFaultSince` marks exactly those.
  const targets = devices.filter(d => d.demoFaultSince != null);
  if (targets.length === 0) return null;

  const deployment: Deployment = {
    id: BREAK_DEPLOYMENT_ID,
    name: BREAK_TITLE,
    targetVersion: BREAK_VERSION,
    deviceGroupId: 'L2 QEMU',
    status: 'finished',
    maxDevicesInFlight: targets.length,
    retries: 0,
    createdAt: brokeAt,
    startTime: brokeAt,
    haltedReason: null,
  };

  const jobs: OtaJob[] = targets.map(d => ({
    id: `${BREAK_DEPLOYMENT_ID}:${d.id}`,
    deviceId: d.id,
    deviceName: d.name,
    fromVersion: d.currentFirmwareVersion ?? d.firmwareVersion,
    targetVersion: d.demoFaultAbove ?? BREAK_VERSION,
    status: 'committed',        // the image installed fine — the bug is in the code, not the update
    progress: 100,
    startedAt: brokeAt,
    completedAt: brokeAt,
    deploymentId: BREAK_DEPLOYMENT_ID,
    failureReason: null,
  }));

  return { deployment, jobs };
}

/**
 * The rollout that carried the AGENT'S FIX to the fleet — the deploy at the end of the story.
 *
 * The demo heals through nff-ota's submit_firmware_fix, which writes no deployments row, so like
 * the break this is derived, never persisted. It appears the moment the agent has shipped a fix
 * (fixWhen = the newest fix run's time, from useDemoPullRequests) and stays `active` — progress
 * bar filling — until every broken device reports firmware strictly above the seeded fault, at
 * which point it flips to `finished`. That "strictly above demoFaultAbove" test is the same honest
 * recovery signal DeviceHealthContext uses for the health dot, so this deploy can never claim the
 * fleet healed before it actually did.
 *
 * createdAt is fixWhen, which is after brokeAt, so this sorts ABOVE the break in the Deployments
 * panel. Returns null before the agent has shipped a fix, or before any device was broken.
 */
export function babynffHealRollout(brokeAt: Date | null, fixWhen: Date | null, devices: Device[]): {
  deployment: Deployment;
  jobs: OtaJob[];
} | null {
  if (!brokeAt || !fixWhen) return null;

  // Same targets the break hit: exactly the devices carrying a durable fault marker.
  const targets = devices.filter(d => d.demoFaultSince != null);
  if (targets.length === 0) return null;

  // A device has adopted the fix once its running firmware climbs strictly above the seeded
  // buggy semver (demoFaultAbove). Same test as DeviceHealthContext's heal signal.
  const running = (d: Device) => d.currentFirmwareVersion ?? d.firmwareVersion;
  const recovered = (d: Device) => semverGt(running(d), d.demoFaultAbove);

  const jobs: OtaJob[] = targets.map(d => {
    const ok = recovered(d);
    return {
      id: `${HEAL_DEPLOYMENT_ID}:${d.id}`,
      deviceId: d.id,
      deviceName: d.name,
      fromVersion: d.demoFaultAbove ?? d.firmwareVersion,
      targetVersion: ok ? running(d) : bumpPatch(d.demoFaultAbove),
      // 'success' counts toward DONE_STATUSES (the panel's progress bar); 'downloading' does not,
      // so the bar fills device-by-device as the fix lands.
      status: ok ? 'success' : 'downloading',
      progress: ok ? 100 : 60,
      startedAt: fixWhen,
      completedAt: ok ? fixWhen : undefined,
      deploymentId: HEAL_DEPLOYMENT_ID,
      failureReason: null,
    };
  });

  const allRecovered = targets.every(recovered);
  // Deployment target: the greatest recovered version, else the next patch above the fault.
  const target = targets
    .map(d => (recovered(d) ? running(d) : bumpPatch(d.demoFaultAbove)))
    .reduce((best, v) => (semverGt(v, best) ? v : best), bumpPatch(targets[0].demoFaultAbove));

  const deployment: Deployment = {
    id: HEAL_DEPLOYMENT_ID,
    name: FIX_TITLE,
    targetVersion: target,
    deviceGroupId: 'L2 QEMU',
    status: allRecovered ? 'finished' : 'active',
    maxDevicesInFlight: targets.length,
    retries: 0,
    createdAt: fixWhen,
    startTime: fixWhen,
    haltedReason: null,
  };

  return { deployment, jobs };
}

// The honest reason the break's deploy is stamped `failed`: the image itself shipped fine, then the
// fleet crash-looped on the new build. Same story babynffBreakRollout tells with a 'committed' OTA
// job (the update installed) beside a broken device (the code is wrong).
const BREAK_DEPLOY_ERROR =
  'Build succeeded and rolled out to the fleet, then every device crash-looped on the new firmware — ' +
  'the I2C temperature read in loop() dereferences a NULL sample while the bus is busy.';

/**
 * The break-and-heal demo as it appears in GithubTab's "Deploys" panel: one pipeline run for the
 * commit that broke the fleet, and one for each fix the agent shipped — the deploy at the end of the
 * story. Like everything else in this module these are derived, never DB rows (the bundled demo repo
 * has no GitHub App, and api/_selfheal.ts / submit_firmware_fix write no pipeline_runs), so this
 * mirrors babynffDemoCommits exactly: same cardinality, same statuses, same anchors. The two must
 * agree because a viewer sees both the commit spine and the Deploys list.
 *
 *   • the break run stays `failed` forever — its rollout genuinely landed, the fleet just can't run
 *     it (BREAK_DEPLOY_ERROR), and it links to the derived break rollout in the OTA tab.
 *   • one fix run per agent fix; the newest is still `deploying` until the fleet reports recovery
 *     (brokenNow), then `succeeded`. Each links to the derived heal rollout.
 *
 * Returns oldest-first; the caller merges with real runs and sorts newest-first for display.
 */
export function babynffDemoPipelineRuns(opts: {
  brokeAt: Date | null;
  brokenNow: boolean;
  connectionId: string;
  /** The agent's fix runs (oldest first) — one deploy each, from useDemoPullRequests. */
  fixes: { runId: string; when: Date }[];
}): PipelineRun[] {
  const { brokeAt, brokenNow, connectionId, fixes } = opts;
  const runs: PipelineRun[] = [];

  if (brokeAt) {
    runs.push({
      id: BREAK_DEPLOY_RUN_ID,
      connectionId,
      commitSha: BREAK_COMMIT_SHA,
      commitMessage: BREAK_TITLE,
      trigger: 'pr_merge',
      status: 'failed',
      firmwareVersion: BREAK_VERSION,
      deploymentId: BREAK_DEPLOYMENT_ID,
      prNumber: 1,
      error: BREAK_DEPLOY_ERROR,
      logs: null,
      createdAt: brokeAt,
      updatedAt: brokeAt,
    });
  }

  fixes.forEach((f, i) => {
    const newest = i === fixes.length - 1;
    runs.push({
      id: `${FIX_DEPLOY_RUN_ID}-${f.runId}`,
      connectionId,
      commitSha: FIX_COMMIT_SHA,
      commitMessage: FIX_TITLE,
      trigger: 'pr_merge',
      // The newest fix is still rolling out while the fleet hasn't recovered; older fixes healed.
      status: newest && brokenNow ? 'deploying' : 'succeeded',
      firmwareVersion: null,
      deploymentId: HEAL_DEPLOYMENT_ID,
      prNumber: i + 2,          // the break is PR/deploy #1
      error: null,
      logs: null,
      createdAt: f.when,
      updatedAt: f.when,
    });
  });

  return runs;
}
