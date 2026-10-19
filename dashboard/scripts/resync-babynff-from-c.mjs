// Regenerate babynffFirmware.ts HEAD/APP_MAIN fragments from the canonical clean_l2.c.
// Split points mirror the existing fragment seams exactly; TASK_HEAD/TASK_TAIL must remain
// byte-identical to clean_l2.c's app_task (asserted below).
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'D:/IntraMap/Carto/R_D/MCPIOT/nff_cli_mcp';
const C_PATH = `${ROOT}/nff-mock/qemu/l2/example-espidf/clean_l2.c`;
const TS_PATH = `${ROOT}/nff-dashboard/src/data/babynffFirmware.ts`;

const c = readFileSync(C_PATH, 'utf8');

const taskIdx = c.indexOf('\nstatic void app_task(void *arg)');
if (taskIdx < 0) throw new Error('app_task anchor not found');
const consoleIdx = c.indexOf('\n// ── Wired serial console');
if (consoleIdx < 0 || consoleIdx < taskIdx) throw new Error('console section anchor not found/misordered');

const headC = c.slice(0, taskIdx);           // file start .. wifi_connect closing brace
const taskC = c.slice(taskIdx, consoleIdx);  // \nstatic void app_task ... }\n
const appMainC = c.slice(consoleIdx);        // \n// ── Wired serial console ... end (console + CA + app_main)

// Template-literal escaping: backslash FIRST (C escape sequences like "\n" / '\0' must survive
// as literal backslash+char), then backticks, then ${ interpolation starts.
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const ts = readFileSync(TS_PATH, 'utf8');

// Verify the untouched middle: TASK_HEAD + TASK_TAIL must equal taskC byte-for-byte.
const thStart = ts.indexOf('const TASK_HEAD = `') + 'const TASK_HEAD = `'.length;
const thEnd = ts.indexOf('`;', thStart);
const ttStart = ts.indexOf('const TASK_TAIL = `') + 'const TASK_TAIL = `'.length;
const ttEnd = ts.indexOf('`;', ttStart);
const taskTs = ts.slice(thStart, thEnd) + ts.slice(ttStart, ttEnd);
if (taskTs !== taskC) {
  throw new Error(`TASK fragments no longer match clean_l2.c app_task (ts ${taskTs.length}B vs c ${taskC.length}B) — seam moved, aborting`);
}

// Splice the two regenerated fragments.
const hStart = ts.indexOf('const HEAD = `') + 'const HEAD = `'.length;
const hEnd = ts.indexOf('`;', hStart);
const out1 = ts.slice(0, hStart) + esc(headC) + ts.slice(hEnd);

const amAnchor = 'const APP_MAIN = `';
const amStart = out1.indexOf(amAnchor) + amAnchor.length;
const amEnd = out1.indexOf('`;', amStart);
const out2 = out1.slice(0, amStart) + esc(appMainC) + out1.slice(amEnd);

writeFileSync(TS_PATH, out2);
console.log(`ok: HEAD ${headC.length}B, TASK (unchanged) ${taskC.length}B, APP_MAIN ${appMainC.length}B`);
