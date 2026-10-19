#!/usr/bin/env node
// Keep the on-disk demo firmware byte-identical to the constants in src/data/babynffFirmware.ts.
//
// WHY THIS EXISTS: three things must be the same firmware, or the guided demo lies to the user.
//
//   • src/data/babynffFirmware.ts  — what the Code tab serves and what api/_selfheal.ts seeds.
//   • nff-mock/qemu/l2/example-espidf/clean_l2.c — what scripts/dev.mjs boots the QEMU L2 devices
//     with. If it drifts, the Code tab shows code the fleet isn't running.
//   • e2e/fixtures/buggy_l2.c — what test_code_fix_device_l2*.py seed. If it drifts, the e2e proves
//     a loop the product never runs.
//
// The .c files are DERIVED. Edit babynffFirmware.ts, then run `npm run demo:firmware`.
// Drift is otherwise silent: every consumer keeps working, just on a different firmware.
//
// Modes:
//   (default)  rewrite both .c files from the constants
//   --check    exit 1 (and print the drift) if either file is stale, WITHOUT writing

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DASH_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(DASH_ROOT, '..');
const SOURCE = join(DASH_ROOT, 'src', 'data', 'babynffFirmware.ts');

// babynffFirmware.ts is deliberately import-free and carries no type annotations, so it is already
// valid ESM. Import it as a data: URL rather than adding a TS toolchain to this script.
const src = readFileSync(SOURCE, 'utf8');
const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`);

const TARGETS = [
  {
    path: join(REPO_ROOT, 'nff-mock', 'qemu', 'l2', 'example-espidf', 'clean_l2.c'),
    content: mod.BABYNFF_MAIN_C_CLEAN,
  },
  {
    path: join(REPO_ROOT, 'e2e', 'fixtures', 'buggy_l2.c'),
    content: mod.BABYNFF_MAIN_C_BUGGY,
  },
];

const check = process.argv.includes('--check');
let stale = 0;

for (const { path, content } of TARGETS) {
  const rel = path.slice(REPO_ROOT.length + 1);
  let current = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    /* missing counts as stale */
  }
  if (current === content) {
    if (!check) console.log(`up-to-date  ${rel}`);
    continue;
  }
  stale++;
  if (check) {
    console.error(`STALE       ${rel}`);
  } else {
    writeFileSync(path, content);
    console.log(`wrote       ${rel}`);
  }
}

if (check && stale) {
  console.error(`\n${stale} sketch(es) drifted from src/data/babynffFirmware.ts.`);
  console.error('Run: npm run demo:firmware');
  process.exit(1);
}
if (check) console.log('up-to-date  demo sketches match babynffFirmware.ts');
