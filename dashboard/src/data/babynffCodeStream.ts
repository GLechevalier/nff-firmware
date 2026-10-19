// babynffCodeStream — reconcile the break-demo's code stream with the bundled demo repo.
//
// The demo heals through nff-ota's `submit_firmware_fix`, not GitHub. That path gives the worker
// nothing to attribute the run to:
//
//   • the code-stream row opens with `repoFullName = null` (nff-agent-worker/src/codeStream.ts
//     calls ensureStarted() with no repo; only a PR url ever sets one), and
//   • the drafted sketch is pathless, so the worker files it under the synthetic `firmware.ino`
//     (nff-agent-worker/src/engine/format.ts FIRMWARE_PATH).
//
// Neither matches the bundled repo the Code tab is browsing (`babynff/babynff-repo`, serving the
// same firmware as `main/main.c`), so without this adapter the demo's edit is filtered out of the
// tab entirely: no diff, and the auto-follow lands on a path that isn't in the tree.
//
// The worker stays generic — it has no idea a virtual repo exists. The mapping lives here, is
// applied only when the virtual connection is present, and is shared with useDemoPullRequests so
// both derive the fix from the same rows the same way.

import { BABYNFF_MAIN_PATH } from './babynffFirmware';
import type { CodeFile } from '../types/code';

/** The path submit_firmware_fix's full-sketch blob is surfaced under (format.ts FIRMWARE_PATH). */
export const FIX_FILE = 'firmware.ino';

// The seed marker api/_selfheal.ts prepends to make each build_id unique. The agent keeps "the rest
// intact", so it survives into the fix — strip it from both sides rather than show it as a change.
export const SEED_MARKER = /^\/\/ nff-seed .*\n/;

// The guided demo only ever breaks with the `null_deref` scenario (lib/selfHealDemo.ts
// HEAL_SCENARIO), whose seeded source IS the sketch the demo repo serves once broken. The other five
// scenarios (reachable from DemoChaosPanel) seed a different l2Sketch() body, and treating one of
// those as `main/main.c` would render the drift between two sketches rather than a fix — so we
// recognise our own sketch and leave anything else alone.
//
// Both markers appear in the seeded (buggy) sketch and survive any minimal null-guard fix, and
// neither appears in an l2Sketch() body: those include "nff_l2_net.h" rather than "credentials.h",
// and none of them declares read_sensor().
const BASE_MARKERS = ['read_sensor', 'credentials.h'];

/** Our own demo sketch (seed marker already stripped), rather than another scenario's body. */
export function isDemoSketch(source: string): boolean {
  return BASE_MARKERS.every(m => source.includes(m));
}

/**
 * The fixed sketch the agent drafted this run, seed marker stripped — or null when the run drafted
 * no firmware, or drafted a sketch that isn't the demo's.
 */
export function demoFixSource(files: CodeFile[]): string | null {
  const f = files.find(x => x.path === FIX_FILE);
  if (!f) return null;
  const src = f.content.replace(SEED_MARKER, '');
  return isDemoSketch(src) ? src : null;
}

/**
 * Re-path the demo's pathless `firmware.ino` onto the file the bundled repo actually serves, so the
 * Code tab can mark it edited and diff it. Both sides lose the seed marker: it is prepended by the
 * seeder and survives into the fix, so leaving it in would only ever diff as noise.
 *
 * Every other file passes through untouched — a run against a real repo carries real paths.
 */
export function adoptDemoFiles(files: CodeFile[]): CodeFile[] {
  return files.map(f => {
    if (f.path !== FIX_FILE) return f;
    const content = f.content.replace(SEED_MARKER, '');
    if (!isDemoSketch(content)) return f;
    return {
      path: BABYNFF_MAIN_PATH,
      content,
      before: f.before == null ? f.before : f.before.replace(SEED_MARKER, ''),
    };
  });
}
