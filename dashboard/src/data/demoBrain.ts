// The demo mode's canned company brain (lib/demoMode.ts): a small ESP32 fleet
// company on which every piece is already wired — fleet, firmware, crash
// diagnosis, the self-heal loop, OTA policy. Served by useProjectBrain in
// place of the workspace's real rows, then run through the SAME deriveMasters
// + linkEdges path, so the hub and tab/tool masters derive exactly as they do
// for a real brain.
//
// Shape = rowToNode's output (core/overview/lib/brainOverlay.ts). Positions are
// explicit and deterministic (the graph is rebuilt every 15 s poll; a random
// layout would jitter), and WELL OUTSIDE the derived master rings (tabs at
// 260, tools at 420 — brainMasters.ts): the merge is overlap-triggered on
// screen-space SQUARES with a zoom-scaled slack, so at a diagonal a memory
// even 200 units past the tool ring is swallowed into a master's blob and
// never drawn. ≥ 900 clears it at the fit zoom for any angle.
// The island is wired to the hub and its tab/tool masters (edges below) — the
// demo's point is that everything is already connected.
// No node may be a hub candidate (findHubId tiers: a
// 'core' row with origin 'supabase' or 'seed' and no source_ref) — the derived
// workspace hub must stay the centre, so everything here is origin 'agent'.

import { COLOR_BY_CATEGORY, type BrainEdge, type Category } from '@nff-brain/core/types';
import type { AdminBrainNode } from '../core/overview/hooks/useBrainGraph';
import { WORKSPACE_HUB_ID } from '../core/overview/lib/brainMasters';

const HUB = { x: 400, y: 300 };
const AT = '2026-09-01T09:00:00.000Z';

// [id, category, title, content, radius]. The angle is the row's index on a
// full turn, so no two memories share a bearing: two nodes on adjacent rings
// at the same angle sit ~100 units apart and merge into one blob.
type Row = readonly [string, Category, string, string, number];

const ROWS: readonly Row[] = [
  ['demo-company', 'core', 'Acme Sensors — 10 ESP32 field gateways on nff',
    'Acme Sensors runs a fleet of ten ESP32 field gateways (temperature, humidity, vibration) reporting over MQTT. Firmware ships from GitHub through nff-ota; incidents are diagnosed and fixed by the agent.', 900],
  ['demo-fleet', 'analysis', 'Fleet: 8 sim + 2 QEMU ESP32 gateways online',
    'Eight Level-1 simulated gateways plus two Level-2 QEMU devices that boot the real flash image. Only the L2s can be crash-looped by a code fault and genuinely recover through a code fix + OTA.', 960],
  ['demo-firmware', 'analysis', 'Firmware main.c — sensor loop + MQTT heartbeat',
    'main.c reads the sensor bus every 500 ms, parses the frame, and publishes a heartbeat with firmware version and uptime. Built with ESP-IDF; the build id (SHA-256 of the ELF) is the join key for symbol resolution.', 960],
  ['demo-crash-class', 'analysis', 'Crash class: LoadProhibited = null deref in sensor parse',
    'A LoadProhibited exception at parse_frame() means the sensor buffer pointer was NULL on the first read after boot. Reproduces on every boot — a crash loop, not a transient.', 960],
  ['demo-build', 'analysis', 'ESP-IDF build: warm ccache finishes < 60 s',
    'With the nff-l2-builddir and nff-l2-ccache volumes warm, a fix build completes in under a minute. Cold builds can take several minutes before the device even crashes.', 960],
  ['demo-ota-group', 'analysis', 'OTA group demo-selfheal-<device> targets one gateway',
    'Each self-heal cycle enrols the broken device in its own OTA group so the fix rollout hits exactly that device and nothing else.', 960],
  ['demo-diagnosis', 'analysis', 'Diagnosis reads the backtrace + RTC log via fleet_get_crash',
    'The panic dump carries a backtrace and the last RTC log lines before the crash. Resolved against the ELF by build id, it names the function, file and line of the faulting frame.', 960],
  ['demo-rule-downgrade', 'rules', 'Never downgrade: a fix must carry a higher semver',
    'nff-ota rejects any firmware at or below the version the device runs. A failed build records no revision, so a resubmit at the same semver still passes.', 960],
  ['demo-rule-build', 'rules', 'A fix must build before it ships',
    'submit_firmware_fix only enqueues; the compile happens afterward on firmware_fix_jobs. A story that sails on to "healthy" without a green build is a lie.', 960],
  ['demo-rule-canary', 'rules', 'Canary one device before the fleet',
    'Every rollout targets one canary gateway first; the fleet follows only after it heartbeats healthy on the new version.', 1060],
  ['demo-selfheal', 'strategy', 'Self-heal loop: crash → diagnose → fix → OTA → verify',
    'On a fresh panic: resolve the crash, read the firmware source, apply a minimal fix, submit it with the next semver, poll the build, and confirm the device heartbeats above the buggy version.', 900],
  ['demo-poll', 'strategy', 'Poll get_firmware_fix_status(wait_seconds=60) — never sleep',
    'The fix status call blocks server-side for up to 90 s. Call it repeatedly with wait_seconds=60 instead of sleeping; the agent has no timer of its own.', 1060],
  ['demo-backtrace-first', 'strategy', 'Diagnose from the backtrace before reading code',
    'The resolved frame names the function and line; start the fix there. Reading the whole source first burns minutes the device spends crash-looping.', 1060],
  ['demo-fix-pr', 'decision', 'Agent fixes land on nff-fix/* branches as PRs',
    'Every agent fix is a branch + PR titled with the next release semver, so a squash-merge re-triggers the build pipeline.', 1060],
  ['demo-auto-merge', 'decision', 'Auto-merge a fix PR on a green build',
    'pr_auto_merge is on for this workspace: a fix whose build passes merges itself; a red build waits for a human.', 1060],
  ['demo-rate-limit', 'decision', 'OTA rate limit cleared for demo cycles',
    'Seed-OTA then fix-OTA hit the same device within minutes; the per-project rate limit is set to 0 so the fix rollout is never paused mid-demo.', 1060],
  ['demo-pref-mono', 'preference', 'Dashboards stay monospace, black on paper',
    'Every panel is plain monospace with 1 px ink borders — no colour except the health dots.', 1060],
  ['demo-pref-popup', 'preference', 'One incident popup at a time',
    'A new crash replaces the previous popup for the same device instead of stacking; at most three toasts are visible.', 1060],
  ['demo-task-canary', 'task', 'Ship v5.2.0 to the canary gateway',
    'Roll the sensor-parse fix to one gateway, watch it heartbeat healthy for 10 minutes, then open the fleet rollout.', 1060],
  ['demo-task-review', 'task', 'Review the agent’s fix PR',
    'Read the diff on nff-fix/5.2.0: the NULL guard in parse_frame() and the added unit test.', 1140],
  ['demo-task-watchdog', 'task', 'Add a task watchdog to the sensor loop',
    'A hung sensor read should reboot the gateway instead of freezing the heartbeat; wire esp_task_wdt around the loop.', 1140],
];

const at = (radius: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return { x: Math.round(HUB.x + Math.cos(a) * radius), y: Math.round(HUB.y + Math.sin(a) * radius) };
};

export const DEMO_BRAIN_NODES: readonly AdminBrainNode[] = ROWS.map(([id, category, title, content, radius], i) => ({
  id,
  title,
  category,
  color: COLOR_BY_CATEGORY[category],
  ...at(radius, (i * 360) / ROWS.length - 90),
  size: category === 'core' ? 22 : category === 'strategy' ? 18 : 15,
  lastUpdated: AT,
  content,
  origin: 'agent',
  recallCount: 0,
  relatedIds: [],
  sourceRef: null,
}));

const link = (from: string, to: string, strength = 0.7): BrainEdge => ({ from, to, strength });

// Spokes into the derived graph: the hub (brainMasters' workspaceHub) and the
// tab/tool masters, by deriveMasters' ids (`tab-<rail id>`, `tool-<catalog id>`).
// linkEdges keeps them only once those nodes exist, i.e. after derivation.
export const DEMO_MASTER_IDS = [WORKSPACE_HUB_ID, 'tab-devices', 'tab-dev', 'tool-github'] as const;

export const DEMO_BRAIN_EDGES: readonly BrainEdge[] = [
  link('demo-company', WORKSPACE_HUB_ID, 0.9),
  link('demo-fleet', 'tab-devices', 0.9),
  link('demo-crash-class', 'tab-devices', 0.8),
  link('demo-firmware', 'tool-github', 0.9),
  link('demo-fix-pr', 'tool-github', 0.8),
  link('demo-ota-group', 'tab-dev', 0.8),
  link('demo-task-canary', 'tab-dev', 0.8),
  link('demo-task-review', 'tab-dev', 0.8),
  link('demo-task-watchdog', 'tab-dev', 0.8),
  link('demo-company', 'demo-fleet', 0.9),
  link('demo-company', 'demo-firmware', 0.9),
  link('demo-company', 'demo-selfheal', 0.9),
  link('demo-fleet', 'demo-ota-group'),
  link('demo-fleet', 'demo-rule-canary'),
  link('demo-firmware', 'demo-crash-class', 0.8),
  link('demo-firmware', 'demo-build'),
  link('demo-firmware', 'demo-fix-pr'),
  link('demo-crash-class', 'demo-diagnosis', 0.8),
  link('demo-crash-class', 'demo-selfheal', 0.8),
  link('demo-diagnosis', 'demo-backtrace-first', 0.8),
  link('demo-selfheal', 'demo-poll', 0.8),
  link('demo-selfheal', 'demo-backtrace-first'),
  link('demo-selfheal', 'demo-rule-build', 0.8),
  link('demo-selfheal', 'demo-ota-group'),
  link('demo-poll', 'demo-build'),
  link('demo-rule-build', 'demo-build'),
  link('demo-rule-downgrade', 'demo-fix-pr'),
  link('demo-rule-downgrade', 'demo-task-canary'),
  link('demo-rule-canary', 'demo-task-canary', 0.8),
  link('demo-fix-pr', 'demo-auto-merge', 0.8),
  link('demo-fix-pr', 'demo-task-review', 0.8),
  link('demo-auto-merge', 'demo-rule-build'),
  link('demo-rate-limit', 'demo-ota-group', 0.8),
  link('demo-rate-limit', 'demo-selfheal'),
  link('demo-pref-popup', 'demo-crash-class', 0.5),
  link('demo-pref-mono', 'demo-company', 0.4),
  link('demo-task-watchdog', 'demo-firmware'),
  link('demo-task-watchdog', 'demo-crash-class', 0.5),
  link('demo-task-canary', 'demo-ota-group'),
];
