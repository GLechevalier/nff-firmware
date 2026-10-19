#!/usr/bin/env node
// Rebuild the browser-flasher "golden" onboarding image from the nff SDK.
//
// WHY THIS EXISTS: the golden image (public/firmware/nff-onboard/*.bin) is a pre-compiled ESP32
// binary with the whole nff SDK linked in (see useEspFlasher.ts + arduino_onboard.ino). Vercel
// serves those bins as static assets but CANNOT build them — there is no arduino-cli / ESP32
// toolchain in the Vercel build. So the bins must be rebuilt BEFORE they are committed, whenever
// the SDK source changes. The pre-push hook (.githooks/pre-push) calls this; you can also run it
// by hand: `npm run build:firmware`.
//
// It fingerprints the SDK inputs (nff-sdk-c/src, include, examples/arduino_onboard) and only
// rebuilds when they differ from scripts/golden-firmware.fingerprint — so an ordinary dashboard
// push, where the SDK is untouched, is an instant no-op.
//
// Modes:
//   (default)      rebuild unconditionally
//   --if-changed   rebuild only if the SDK fingerprint differs (else exit 0, no-op)
//   --check        print stale/up-to-date and exit 1/0 WITHOUT building (used by the hook fast-path)
//
// Requires on PATH: arduino-cli (+ the esp32:esp32 core installed) and python (for
// nff-sdk-c/tools/sync_arduino_lib.py, which flattens the repo into the Arduino library).

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync, writeFileSync, copyFileSync, readdirSync, statSync, existsSync,
} from 'node:fs';
import { join, resolve, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DASH_ROOT = resolve(HERE, '..');
const SDK_ROOT = resolve(DASH_ROOT, '..', 'nff-sdk-c');
const FINGERPRINT_FILE = join(HERE, 'golden-firmware.fingerprint');

const FQBN = 'esp32:esp32:esp32';
const BUILD_SUBDIR = 'esp32.esp32.esp32'; // arduino-cli --export-binaries dir (FQBN with dots)

// Golden image variants: the WiFi onboarding image and the wired-first (USB/PPPoS) image.
// Each maps an SDK example sketch to a public/firmware output dir + manifest.
// boot_app0.bin is a toolchain constant (ships with the esp32 core, independent of the SDK) so it
// is intentionally NOT rebuilt — both manifests reference the committed copy under nff-onboard/.
const VARIANTS = [
  { example: 'arduino_onboard', outName: 'nff-onboard' },
  { example: 'arduino_onboard_wired', outName: 'nff-onboard-wired' },
].map((v) => ({
  ...v,
  sketchDir: join(SDK_ROOT, 'examples', v.example),
  outDir: join(DASH_ROOT, 'public', 'firmware', v.outName),
  manifest: join(DASH_ROOT, 'public', 'firmware', v.outName, 'manifest.json'),
  segments: [
    { built: `${v.example}.ino.bin`, out: 'app.bin' },
    { built: `${v.example}.ino.bootloader.bin`, out: 'bootloader.bin' },
    { built: `${v.example}.ino.partitions.bin`, out: 'partitions.bin' },
  ],
}));

// ── SDK fingerprint ──────────────────────────────────────────────────────────
const FP_ROOTS = [join(SDK_ROOT, 'src'), join(SDK_ROOT, 'include'), ...VARIANTS.map((v) => v.sketchDir)];
const FP_EXTS = new Set(['.c', '.h', '.cpp', '.ino']);
const FP_SKIP_DIRS = new Set(['build']); // never fingerprint compiler output

function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!FP_SKIP_DIRS.has(name)) walk(p, acc);
    } else if (FP_EXTS.has(extname(name))) {
      acc.push(p);
    }
  }
  return acc;
}

function computeFingerprint() {
  const files = [];
  for (const root of FP_ROOTS) if (existsSync(root)) walk(root, files);
  files.sort();
  const h = createHash('sha256');
  h.update(`fqbn=${FQBN}\0`); // toolchain target is part of the identity
  for (const f of files) {
    h.update(relative(SDK_ROOT, f).replace(/\\/g, '/'));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

// ── shell helpers ────────────────────────────────────────────────────────────
const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
function run(cmd, args) {
  const line = [cmd, ...args.map(q)].join(' ');
  console.log(`  $ ${line}`);
  execSync(line, { stdio: 'inherit' }); // shell so Windows resolves arduino-cli.exe / python.exe
}
function have(probe) {
  // `probe` is a full command whose success proves the tool is installed (arduino-cli uses the
  // `version` subcommand, not a --version flag).
  try { execSync(probe, { stdio: 'ignore' }); return true; } catch { return false; }
}
function fail(msg) { console.error(`\nbuild-firmware: ${msg}\n`); process.exit(1); }

// ── main ─────────────────────────────────────────────────────────────────────
const flags = new Set(process.argv.slice(2));
const current = computeFingerprint();
const stored = existsSync(FINGERPRINT_FILE) ? readFileSync(FINGERPRINT_FILE, 'utf8').trim() : '';
const changed = current !== stored;

if (flags.has('--check')) {
  console.log(changed
    ? `stale: nff SDK changed (${stored.slice(0, 12) || 'none'} -> ${current.slice(0, 12)})`
    : 'up-to-date: golden image matches the current nff SDK');
  process.exit(changed ? 1 : 0);
}

if (flags.has('--if-changed') && !changed) {
  console.log('build-firmware: golden image up-to-date (nff SDK unchanged) — skipping rebuild');
  process.exit(0);
}

console.log('build-firmware: rebuilding the golden onboard images from the nff SDK...');
for (const v of VARIANTS) {
  if (!existsSync(v.sketchDir)) fail(`nff-sdk-c example not found at ${v.sketchDir} (expected as a sibling of nff-dashboard)`);
}
if (!have('arduino-cli version')) fail('arduino-cli not found on PATH. Install it + the esp32 core, or set SKIP_FIRMWARE_BUILD=1.');
const py = have('python --version') ? 'python' : have('python3 --version') ? 'python3' : null;
if (!py) fail('python not found on PATH (needed for sync_arduino_lib.py).');

// 1) Push the current SDK into the arduino-cli library dir so `#include <nff.h>` resolves to it.
run(py, [join(SDK_ROOT, 'tools', 'sync_arduino_lib.py'), '--quiet']);

for (const v of VARIANTS) {
  // 2) Compile the sketch (build_opt.h supplies -DNFF_BOOTSTRAP_ENABLED=1).
  run('arduino-cli', ['compile', '--fqbn', FQBN, '--export-binaries', v.sketchDir]);

  // 3) Copy the freshly-built segments over the shipped ones.
  const buildDir = join(v.sketchDir, 'build', BUILD_SUBDIR);
  for (const seg of v.segments) {
    const src = join(buildDir, seg.built);
    if (!existsSync(src)) fail(`expected build output missing: ${src}`);
    copyFileSync(src, join(v.outDir, seg.out));
    console.log(`  copied ${seg.built} -> ${v.outName}/${seg.out} (${statSync(join(v.outDir, seg.out)).size} bytes)`);
  }

  // 4) Refresh parts[].size in the manifest (the flasher trusts these for progress + validation).
  const manifest = JSON.parse(readFileSync(v.manifest, 'utf8'));
  for (const part of manifest.parts) {
    const base = part.path.split('/').pop();
    const local = join(DASH_ROOT, 'public', part.path.split('/').slice(0, -1).join('/'), base);
    if (existsSync(local)) part.size = statSync(local).size;
  }
  writeFileSync(v.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
}

// 5) Record the SDK fingerprint the images were built from.
writeFileSync(FINGERPRINT_FILE, `${current}\n`);

console.log(`build-firmware: done. Golden images rebuilt for SDK fingerprint ${current.slice(0, 12)}.`);
