// Shared server-side helper: drive the held-firmware SELF-HEALING pipeline for a demo mock.
// Used by both the Vercel function (api/demo/selfheal.ts, prod) and the Vite dev middleware
// (vite.config.ts, `npm run dev`). Secrets stay server-side — never in the browser bundle.
//
// What "self-heal" means here (the loop e2e/test_code_fix_device.py proves, no GitHub):
//   crash-loop scenario  -> INSTANT crash: register the buggy source WITHOUT building it
//                           (nff-ota /internal/firmware/register-source) so get_firmware_source
//                           returns a real bug, and inject a PRERECORDED crash for the device
//                           (controller /mocks/inject-crash -> fleet /internal/inject-crash) so the
//                           dashboard incident + the agent's fleet_get_crash fire in ~1-2s. Then
//                           trigger the agent, which reads the source (get_firmware_source), fixes
//                           the bug (submit_firmware_fix), and ships a REAL recompile+OTA — the only
//                           slow step left — after which the device recovers.
//   reboot scenario      -> inject a transient crash via nff-fleet (the device self-heals next boot).
//
// The buggy L2 image is no longer compiled+booted to PRODUCE the crash (the minutes-long wait we
// removed): the crash is injected from nff-mock's scenario catalog, decoupled from the device's
// actual (healthy) firmware. build_id = sha256(source) still makes every edit a distinct image so
// the agent's fix is a real, non-no-op OTA.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { crashViaFleet, isTimeoutError } from './_fleet.js';
import { injectCrashViaController } from './_mock.js';
// The guided demo's BROKEN sketch — the one the break commit lands on the bundled demo repo the
// user browses in the Code tab. (The repo serves the CLEAN twin until this seeds.)
// `.js` extension is mandatory on relative imports here or Vercel prod dies ERR_MODULE_NOT_FOUND.
import { BABYNFF_MAIN_C_BUGGY } from '../src/data/babynffFirmware.js';

// Scenario classification — mirrors nff-mock/.../scenarios.py recovers_on (and src/lib/crashScenarios.ts).
const OTA_SCENARIOS = new Set([
  'null_deref', 'stack_overflow', 'heap_leak',
  'divide_by_zero', 'unaligned_access', 'assert_failed',
]);
const REBOOT_SCENARIOS = new Set(['watchdog', 'transient_load']);
export function isKnownScenario(s: unknown): s is string {
  return typeof s === 'string' && (OTA_SCENARIOS.has(s) || REBOOT_SCENARIOS.has(s));
}

// Per-scenario buggy `.ino` source the mock holds. Each is shaped so nff-ota's compile.py
// detect_fault returns the matching scenario, and the smallest natural fix removes the match.
// Kept tiny on purpose — the seed doesn't build a real binary, it's regex-analyzed.
const BUGGY_SOURCES: Record<string, string> = {
  // pointer from a call, dereferenced with no NULL guard (compile.py::_detect_null_deref).
  null_deref: `#include "nff.h"

Reading* read_sensor();   // returns NULL while the I2C bus is busy
void publish(int celsius);

void loop() {
  Reading* r = read_sensor();
  publish(r->celsius);    // BUG(null_deref): r may be NULL - dereferenced with no guard
  delay(1000);
}
`,
  // a function that calls itself with no base-case 'if' (compile.py::_detect_stack_overflow).
  stack_overflow: `#include "nff.h"

void publish(int total);

// BUG(stack_overflow): no base case - recurses until the task stack blows.
int sum_depth(int n) {
  return n + sum_depth(n + 1);
}

void loop() {
  int total = sum_depth(0);
  publish(total);
  delay(1000);
}
`,
  // allocation inside a loop with no free/delete anywhere (compile.py::_detect_heap_leak).
  heap_leak: `#include "nff.h"

void publish(const char* msg);

void loop() {
  for (int i = 0; i < 8; i++) {
    char* buf = (char*)malloc(64);   // BUG(heap_leak): never released
    snprintf(buf, 64, "sample-%d", i);
    publish(buf);
  }
  delay(1000);
}
`,
  // a division by a variable with no zero-guard (compile.py::_detect_divide_by_zero).
  divide_by_zero: `#include "nff.h"

int sample_count();      // returns 0 when the sensor produced no samples this window
int sum_readings();
void publish(int avg);

void loop() {
  int count = sample_count();
  int avg = sum_readings() / count;   // BUG(divide_by_zero): count may be 0 - no guard
  publish(avg);
  delay(1000);
}
`,
  // a wide-int cast of a byte pointer at an offset (compile.py::_detect_unaligned_access).
  unaligned_access: `#include "nff.h"

const uint8_t* frame_bytes();
void publish(uint32_t value);

void loop() {
  const uint8_t* buf = frame_bytes();
  uint32_t value = *(uint32_t*)(buf + 1);   // BUG(unaligned_access): u32 read at +1 offset
  publish(value);
  delay(1000);
}
`,
  // a shipped abort() that always fires (compile.py::_detect_assert_failed).
  assert_failed: `#include "nff.h"

void* relay_handle();    // returns NULL while the relay driver is unconfigured

void loop() {
  void* h = relay_handle();
  if (!h) {
    abort();   // BUG(assert_failed): aborts instead of degrading when the handle is missing
  }
  delay(1000);
}
`,
};

const L2_DEVICE_TYPE = 'nff-qemu-esp32';

// ─── Timeout budget ─────────────────────────────────────────────────────────
// Both nff-ota calls on this path are deliberately CHEAP: ensure-mock-target writes a group row,
// and register-source records a revision + regex-analyzes the sketch — neither BUILDS anything
// (the real ESP-IDF compile happens later, asynchronously, in nff-ota's fix_worker). They still
// cross the Cloudflare tunnel to the self-hosted box, so 15s. selfheal makes at most two of these
// plus a 10s controller inject-crash, which fits inside api/demo.ts's maxDuration 60.
const OTA_TIMEOUT_MS = 15_000;

// The REAL-compilable Level-2 (nff-qemu-esp32) twins of BUGGY_SOURCES. An L1 seed is a fictional
// pseudo-.ino the regex analyzer only READS; an L2 seed is GENUINELY compiled by nff-github
// (build_arduino_shim.sh) and booted in qemu-system-xtensa, so it must be a valid arduino-esp32
// sketch — setup()/loop(), the nff SDK scaffolding, and the openeth-shim network bring-up. Seeding
// the L1 pseudo-.ino onto an L2 device is what made the real compile fail rc=2 (undefined `Reading`
// type, no setup(), undefined helpers). Each L2 twin holds the SAME one bug in buildable form; the
// smallest fix removes the crash. null_deref does NOT use this arduino scaffold — it seeds the shared
// BABYNFF_MAIN_C_BUGGY verbatim (a native ESP-IDF app, itself a copy of e2e/fixtures/buggy_l2.c,
// proven live). nff-github's compile route sniffs app_main vs setup()/loop() and builds each on the
// matching recipe (build_espidf.sh vs build_arduino_shim.sh).
//
// These five still load their identity explicitly (nff_l2_load_config_from_nvs). Now that the shim
// carries an NFF_CONFIG/nff_init override they COULD drop to the real-ESP32 shape the demo sketch
// uses — but they are never browsed, and every edit here risks tripping compile.py's
// _detect_divide_by_zero (any "/" or "%" whose divisor is an identifier). Left as they are.
function l2Sketch(body: { helpers?: string; trigger: string }): string {
  return `#include <WiFi.h>
#include <nff.h>
#include "nff_l2_net.h"

static nff_config_t g_cfg;
${body.helpers ?? ''}
void setup() {
  Serial.begin(9600);
  WiFi.begin("nff-l2", "openeth");          // WiFi.* is redefined to the openeth shim
  while (WiFi.status() != WL_CONNECTED) { delay(200); }
  nff_l2_set_clock_from_nvs();               // sane clock before any TLS (QEMU has no RTC)
  if (nff_l2_load_config_from_nvs(&g_cfg) != 0) { Serial.println("[nff-l2] no NVS identity"); return; }
  if (nff_init(&g_cfg) != NFF_OK) { Serial.println("[nff-l2] nff_init failed"); return; }
  nff_connect();                             // publishes any pending coredump from the prior panic
  nff_log("buggy_l2 started, fw=%s", g_cfg.fw_version);
}

void loop() {
  nff_loop();                                // keep MQTT/OTA/heartbeat serviced
  // Only crash once CONNECTED + settled, so the SDK has published the heartbeat AND flushed the
  // prior boot's crash report (crash-loop count climbs reliably instead of racing the QEMU handshake).
  static unsigned long connected_at = 0;
  if (nff_get_state() == NFF_STATE_CONNECTED) {
    if (connected_at == 0) connected_at = millis();
    if (millis() - connected_at > 5000) {
${body.trigger}
    }
  }
  delay(500);
}
`;
}

const BUGGY_SOURCES_L2: Record<string, string> = {
  // NOT an l2Sketch() twin: null_deref is the GUIDED demo's scenario, so it seeds the exact firmware
  // the break commit lands on the bundled demo repo as main/main.c. The demo PRs
  // (useDemoPullRequests) diff clean→this (the break) and this→the agent's fix — an l2Sketch()
  // near-copy here would make both diffs show the drift between two sketches instead of the feature
  // that broke the fleet and the one-line guard that healed it.
  null_deref: BABYNFF_MAIN_C_BUGGY,
  stack_overflow: l2Sketch({
    helpers: `
// BUG(stack_overflow): no base case — recurses until the task stack blows (watchpoint panic).
static int sum_depth(int n) __attribute__((noinline));
static int sum_depth(int n) { return n + sum_depth(n + 1); }
`,
    trigger: `      int total = sum_depth(0);
      Serial.printf("sum=%d\\n", total);`,
  }),
  heap_leak: l2Sketch({
    trigger: `      for (int i = 0; i < 8; i++) {
        char *buf = (char *)malloc(64);   // BUG(heap_leak): never freed — heap exhausts, alloc fails
        snprintf(buf, 64, "sample-%d", i);
        Serial.println(buf);
      }`,
  }),
  divide_by_zero: l2Sketch({
    helpers: `
static int g_sum = 4200;
// Sample counter that reports 0 this window (volatile stops the optimizer folding the divide).
static int sample_count() __attribute__((noinline));
static int sample_count() { volatile int n = 0; return n; }
`,
    trigger: `      int count = sample_count();
      int avg = g_sum / count;   // BUG(divide_by_zero): count is 0 — no guard
      Serial.printf("avg=%d\\n", avg);`,
  }),
  unaligned_access: l2Sketch({
    helpers: `
static uint8_t g_frame[8] = {0, 1, 2, 3, 4, 5, 6, 7};
`,
    trigger: `      uint32_t v = *(uint32_t *)(g_frame + 1);   // BUG(unaligned_access): u32 read at +1 offset
      Serial.printf("v=%u\\n", (unsigned)v);`,
  }),
  assert_failed: l2Sketch({
    helpers: `
// Relay driver left unconfigured: the handle is always NULL here (deterministic).
static void *relay_handle() __attribute__((noinline));
static void *relay_handle() { volatile bool configured = false; return configured ? (void *)1 : (void *)0; }
`,
    trigger: `      void *h = relay_handle();
      if (!h) {
        abort();   // BUG(assert_failed): aborts instead of degrading when the handle is missing
      }`,
  }),
};

// Human-readable hint for the repair prompt (mirrors nff-ota repair.py / e2e code_fix_prompt).
const FIX_HINTS: Record<string, string> = {
  null_deref: 'a NULL pointer dereference (a pointer used without a NULL check)',
  stack_overflow: 'unbounded recursion (a function that calls itself with no base case)',
  heap_leak: 'a heap leak (an allocation in a loop that is never freed)',
  divide_by_zero: 'an integer divide-by-zero (a division by a value that can be zero, with no guard)',
  unaligned_access: 'an unaligned memory access (a wide-integer read of a byte pointer at an odd offset)',
  assert_failed: 'an abort()/failed assertion (a guaranteed-fail abort instead of graceful handling)',
};

// The marker src/utils/chat.ts uses to hide an engineered preamble from the chat transcript.
// Everything BEFORE it is the agent's instructions; the short line AFTER it is what the user sees.
const USER_QUESTION_MARKER = '\n\nUser question: ';

const SEED_FLOOR: [number, number, number] = [5, 0, 0];

export interface SelfHealCfg {
  otaUrl?: string; // NFF_OTA_URL (default http://localhost:3002)
  fleetUrl?: string; // NFF_FLEET_URL (reboot path)
  fleetSecret?: string; // NFF_FLEET_SECRET (== nff-ota OTA_FLEET_SECRET; X-Fleet-Secret for both)
  supabaseUrl?: string; // VITE_SUPABASE_URL
  serviceRoleKey?: string; // SUPABASE_SERVICE_ROLE_KEY
  // Whether to BORROW a device from the shared L2 pool (migration 0075). Defaults true (prod: demo
  // users share 2 pool L2s). Set false in LOCAL mode (`npm run dev`), where the dev stack spawns the
  // user's OWN 2 L2 QEMU devices into their own project — breaking those directly is correct, and
  // borrowing would wrongly queue the local user behind the busy shared cloud pool. See
  // project_dev_l2_autodeploy.
  usePool?: boolean;
}

export interface SelfHealResult {
  ok: boolean;
  status: number; // HTTP status to return to the client
  mode?: 'seed' | 'reboot';
  version?: string; // the seeded buggy version (seed mode)
  device_id?: string; // the device actually broken (the borrowed pool L2 id, or the fallback) — seed mode
  fault_remaining?: boolean; // nff-ota's honest "did the bug survive the seed compile?"
  session_id?: string; // the "Self-heal demo" chat session the agent narrates in (seed mode)
  lease_state?: 'active' | 'queued'; // set when the compile cycle borrowed a pool L2 (invisible to the user)
  position?: number; // FIFO queue position when lease_state === 'queued' (no device free yet)
  request_key?: string; // echoes the caller's per-break idempotency key so the client matches the realtime grant
  error?: string;
}

// The constant L2 borrow-pool project (migration 0075). The 2 shared QEMU devices live here;
// a compile/OTA self-heal transparently leases one and runs the whole cycle in this project
// (OTA is device-anchored — nff-ota reads project_id from the devices row — so targeting a
// pool device keeps seed→compile→deploy→crash in-tenant). Mirror of the migration literal.
const L2_POOL_PROJECT_ID = 'b2b2b2b2-0000-4000-8000-000000000002';

// Title of the dedicated chat session the demo's agent runs narrate in. The dashboard's
// FleetIncidentModal "Agent →" button opens it so the user watches the agent diagnose +
// fix in an actual conversation (the agent always speaks its 💭 reasoning) rather than the
// session-global Console.
const DEMO_SESSION_TITLE = 'Self-heal demo';

// ── semver helpers ──────────────────────────────────────────────────────────────────
function parseSemver(v: unknown): [number, number, number] | null {
  const m = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(typeof v === 'string' ? v : '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function gt(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
}

// ── config resolution ───────────────────────────────────────────────────────────────
function resolveOta(cfg: SelfHealCfg): { otaUrl: string; fleetSecret: string } | { error: string } {
  const otaUrl = (cfg.otaUrl ?? process.env.NFF_OTA_URL ?? 'http://localhost:3002').replace(/\/+$/, '');
  const fleetSecret = cfg.fleetSecret ?? process.env.NFF_FLEET_SECRET ?? '';
  if (!fleetSecret) return { error: 'NFF_FLEET_SECRET is not configured' };
  return { otaUrl, fleetSecret };
}

function resolveSupabase(cfg: SelfHealCfg): SupabaseClient | { error: string } {
  const supabaseUrl = cfg.supabaseUrl ?? process.env.VITE_SUPABASE_URL ?? '';
  const serviceRoleKey = cfg.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl) return { error: 'VITE_SUPABASE_URL is not configured' };
  if (!serviceRoleKey) return { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured' };
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Record that this demo project's owner has the demo open, in a Postgres-visible table
// (migration 0076) so the L2 fair-share cap can count concurrent users. Called on the same
// 60s tick as the controller presence ping. Best-effort: a missing service key / RPC is a
// no-op (the lease layer still works, it just can't see this user as "active").
export async function poolPresencePing(projectId: unknown, cfg: SelfHealCfg = {}): Promise<void> {
  if (typeof projectId !== 'string' || !projectId) return;
  const supabase = resolveSupabase(cfg);
  if ('error' in supabase) return;
  try {
    await supabase.rpc('l2_pool_presence_ping', { p_project: projectId });
  } catch {
    /* best-effort */
  }
}

async function callOta(
  path: string,
  body: Record<string, unknown>,
  ota: { otaUrl: string; fleetSecret: string },
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const resp = await fetch(`${ota.otaUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fleet-Secret': ota.fleetSecret },
    body: JSON.stringify(body),
    // Bounded: a hung nff-ota must not pin the function open until the platform kills it.
    signal: AbortSignal.timeout(OTA_TIMEOUT_MS),
  });
  let data: Record<string, unknown> | null = null;
  try { data = (await resp.json()) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: resp.status, data };
}

// Structured error for a thrown callOta — an abort is a 504 ("it's up but stuck"), anything
// else is a 502 ("we couldn't reach it"). Never let the abort escape selfHeal().
function otaFailure(e: unknown): SelfHealResult {
  if (isTimeoutError(e)) {
    return { ok: false, status: 504, error: `nff-ota timed out after ${OTA_TIMEOUT_MS / 1000}s` };
  }
  return { ok: false, status: 502, error: `nff-ota unreachable: ${(e as Error)?.message ?? e}` };
}

// ── steps ─────────────────────────────────────────────────────────────────────────
// ONE read of the device row that answers BOTH questions the seed needs about it:
//
//   version    — a seed version strictly above whatever the device runs now (the mock enforces
//                anti-downgrade on OTA adoption regardless of author='seed'), bumping the MINOR
//                so the agent's patch+1 fix has room and repeated crashes keep ascending (no
//                stale re-push).
//   deviceType — which family of buggy source to seed: a real-compilable L2 sketch vs the L1
//                regex pseudo-.ino. The pooled device is always L2, and a fallback to the
//                caller's own victim can be L2 too (pickVictim selects nff-qemu-esp32), so we
//                check device_type rather than merely whether a lease held.
//
// These used to be two round-trips (pickSeedVersion, then deviceTypeOf later) to the SAME row.
// The `mock_firmware_revisions` lookup is independent of the `devices` one, so it fans out.
//
// A failed/missing `devices` read is an { error } the caller MUST surface — never a silent
// default. supabase-js resolves a failed query as { data: null, error } instead of throwing, so
// the old `catch { return '' }` could not fire, and an errored lookup degraded to "not an L2" —
// which seeds the unbuildable L1 pseudo-.ino onto an L2 device and makes every later real
// compile fail rc=2. (The revisions read stays best-effort: it only raises the version floor.)
async function readSeedTarget(
  supabase: SupabaseClient,
  deviceId: string,
): Promise<{ version: string; deviceType: string } | { error: string }> {
  const [dev, revs] = await Promise.all([
    supabase
      .from('devices')
      .select('firmware_version, current_firmware_version, device_type')
      .eq('id', deviceId)
      .limit(1),
    supabase
      .from('mock_firmware_revisions')
      .select('version')
      .eq('device_id', deviceId),
  ]);
  if (dev.error) return { error: `could not read device_type for ${deviceId}: ${dev.error.message}` };
  if (!dev.data?.length) return { error: `device ${deviceId} not found` };

  let best = SEED_FLOOR;
  const candidates: unknown[] = [];
  for (const row of dev.data) candidates.push(row.firmware_version, row.current_firmware_version);
  for (const row of revs.data ?? []) candidates.push(row.version);
  for (const c of candidates) {
    const v = parseSemver(c);
    if (v && gt(v, best)) best = v;
  }
  return {
    version: `${best[0]}.${best[1] + 1}.0`,
    deviceType: ((dev.data[0].device_type as string | null) ?? '').trim(),
  };
}

// Transparently BORROW a Level-2 QEMU device from the shared pool for a compile/OTA cycle
// (migration 0075). Returns the lease outcome, or `null` when the pool isn't available in this
// environment (RPC absent, no pool project, no owner) so the caller falls back to the user's own
// L1 mock — keeping the demo working everywhere. The holder is the demo project's owner (each
// is_demo project is per-user), derived server-side so it can't be spoofed.
async function acquirePoolLease(
  supabase: SupabaseClient,
  projectId: string,
  requestKey: string,
): Promise<{ state: 'active' | 'queued'; deviceId?: string; position?: number; requestKey: string } | null> {
  try {
    const owner = await supabase.from('projects').select('owner_id').eq('id', projectId).limit(1);
    const holderUser = owner.data?.[0]?.owner_id as string | undefined;
    if (!holderUser) return null; // can't attribute a lease → fall back to the L1 device
    // p_request_key makes the borrow idempotent PER BREAK (not per user), so one user can hold
    // up to their fair-share cap of distinct concurrent leases (migration 0076), and a queued
    // retry for the same break returns its own lease rather than a second device.
    const { data, error } = await supabase.rpc('l2_lease_acquire_for', {
      p_holder_user: holderUser,
      p_holder_project: projectId,
      p_request_key: requestKey,
    });
    const row = data as { state?: string; device_id?: string; position?: number; request_key?: string } | null;
    if (error || !row || (row.state !== 'active' && row.state !== 'queued')) return null;
    return {
      state: row.state,
      deviceId: row.device_id ?? undefined,
      position: row.position,
      requestKey: row.request_key ?? requestKey,
    };
  } catch {
    return null; // pool not provisioned / RPC missing → fall back
  }
}

// Seed-OTA then fix-OTA hit the same device within minutes; clear the per-project OTA rate
// limit (migration 0054) so the fix rollout isn't paused mid-demo. Demo-only affordance.
async function clearRateLimit(supabase: SupabaseClient, projectId: string): Promise<void> {
  // Best-effort, but not silent: supabase-js reports failures on `error`, not by throwing.
  const { error } = await supabase
    .from('projects').update({ ota_rate_limit_seconds: 0 }).eq('id', projectId);
  if (error) console.warn(`[selfheal] clearRateLimit failed for ${projectId}: ${error.message}`);
}

// Find-or-create the dedicated "Self-heal demo" chat session for this project and return its
// id. The demo's agent runs are scoped to it (instead of the null "main chat") so their
// narration + 💭 reasoning surface in the Agent CHAT panel, which only ever renders a real
// chat-session UUID. The agent always speaks its reasoning as 💭 bubbles (no per-session toggle).
// Cascade requests are staggered ~700ms apart, so the first creates and the rest reuse.
async function resolveDemoSession(supabase: SupabaseClient, projectId: string): Promise<string> {
  const existing = await supabase
    .from('chat_sessions')
    .select('id')
    .eq('project_id', projectId)
    .eq('kind', 'chat')
    .eq('title', DEMO_SESSION_TITLE)
    .limit(1);
  const row = existing.data?.[0] as { id: string } | undefined;
  if (row) return row.id;
  const id = randomUUID();
  await supabase.from('chat_sessions').insert({
    id,
    project_id: projectId,
    kind: 'chat',
    title: DEMO_SESSION_TITLE,
  });
  return id;
}

// Insert the repair hand-off the worker picks up via Realtime (role='user'). Mirrors
// nff-github repair.py + e2e helpers.code_fix_prompt. The engineered instructions go BEFORE
// the marker (the worker reads the raw content); the short line after it is what chat shows.
// `sessionId` scopes the run to the demo chat session so the agent narrates there.
async function triggerAgentFix(
  supabase: SupabaseClient,
  deviceId: string,
  projectId: string,
  scenario: string,
  sessionId: string,
): Promise<void> {
  const hint = FIX_HINTS[scenario] ?? 'a firmware bug';
  const instructions =
    `Mock device **${deviceId}** is crash-looping on ${hint}. The firmware it runs holds the bug — ` +
    `fix the source and ship it.\n\n` +
    `1. Read it with \`get_firmware_source(device_id='${deviceId}')\`.\n` +
    `2. Make the smallest correct change to remove the bug, keeping the rest intact.\n` +
    `3. Ship it with \`submit_firmware_fix(device_id='${deviceId}', version=<NEXT SEMVER>, ` +
    `source=<the full fixed source>)\`. \`version\` MUST be a bare semver strictly greater than the ` +
    `version of the source you just read (that is the anti-downgrade floor, not the version the ` +
    `device currently reports).\n` +
    // submit_firmware_fix only ENQUEUES: it returns {job_id, status:'pending'} and the real ESP-IDF
    // compile runs afterwards in nff-ota's fix_worker. The compile error lands on the job row and
    // NOWHERE else, so an agent that stops at 'pending' reports success for a fix that never built.
    `4. \`submit_firmware_fix\` only ENQUEUES the build — it returns a \`job_id\` with ` +
    `\`status='pending'\`. Call \`get_firmware_fix_status(job_id=..., wait_seconds=60)\` repeatedly — ` +
    `it blocks server-side, so never sleep or set a timer yourself — until \`status\` is ` +
    `\`done\` or \`error\` (a real device build takes ~1-3 min). On \`error\`, read the \`error\` ` +
    `field, correct the source, and resubmit at a higher semver. Do NOT report success until you ` +
    `have seen \`status='done'\` with \`fault_remaining\` false.`;
  const content = `${instructions}${USER_QUESTION_MARKER}Diagnose and recover mock device ${deviceId}.`;
  await supabase.from('agent_messages').insert({
    id: randomUUID(),
    role: 'user',
    content,
    ts: new Date().toISOString(),
    project_id: projectId,
    session_id: sessionId,
  });
}

// ── orchestrator ────────────────────────────────────────────────────────────────────
export async function selfHeal(
  deviceId: unknown,
  projectId: unknown,
  scenario: unknown,
  requestKey: unknown,
  cfg: SelfHealCfg = {},
): Promise<SelfHealResult> {
  // device_id is OPTIONAL: for an L2 self-heal we BORROW a pool device (its id comes from the
  // lease), so the client no longer needs a pre-visible L2 to break. It's only used as a fallback
  // target (the reboot path, or an own L1 mock when the pool is unavailable).
  const fallbackDeviceId = typeof deviceId === 'string' && deviceId ? deviceId : null;
  if (typeof projectId !== 'string' || !projectId) {
    return { ok: false, status: 400, error: 'project_id is required' };
  }
  if (!isKnownScenario(scenario)) {
    return { ok: false, status: 400, error: `unknown scenario "${String(scenario)}"` };
  }

  // Reboot scenarios self-heal on the next boot — just inject the transient crash on a real device.
  if (REBOOT_SCENARIOS.has(scenario)) {
    if (!fallbackDeviceId) {
      return { ok: false, status: 400, error: 'device_id is required for a reboot scenario' };
    }
    const r = await crashViaFleet(fallbackDeviceId, projectId, scenario, {
      fleetUrl: cfg.fleetUrl,
      fleetSecret: cfg.fleetSecret,
    });
    return { ok: r.ok, status: r.status, mode: 'reboot', error: r.error };
  }

  // Crash-loop scenarios: seed a real bug, then trigger the agent to fix + OTA-recover it.
  const ota = resolveOta(cfg);
  if ('error' in ota) return { ok: false, status: 500, error: ota.error };
  const supabase = resolveSupabase(cfg);
  if ('error' in supabase) return { ok: false, status: 500, error: supabase.error };

  // BORROW a pool L2 for this compile cycle (invisible to the user). If both pool devices are
  // busy → queued (the client waits and retries on the realtime grant). If the pool isn't
  // available in this environment, `lease` is null and we fall back to the user's own L1 mock.
  // A stable per-break idempotency key: the client sends one per victim so a solo user can hold
  // both pool L2s at once (one lease per key) and a queued retry reuses its key. Fall back to a
  // fresh uuid when a caller doesn't supply one (each call = a distinct request).
  const reqKey = typeof requestKey === 'string' && requestKey ? requestKey : randomUUID();
  // Local mode (usePool === false): don't borrow — break the caller's own L2 (`fallbackDeviceId`,
  // spawned by `npm run dev` into their own project) directly, so a busy shared cloud pool can't
  // queue a local user who already has their own device to break.
  const lease = cfg.usePool === false ? null : await acquirePoolLease(supabase, projectId, reqKey);
  if (lease?.state === 'queued') {
    return {
      ok: true, status: 202, mode: 'seed', lease_state: 'queued',
      position: lease.position, request_key: lease.requestKey,
    };
  }
  // The OTA cycle runs against the leased pool device IN the pool project (its cert scope), else
  // the caller's own device in their own project. Narration always stays in the CALLER's project so
  // the borrower sees it through ordinary RLS (no overlay needed on agent_messages/chat_sessions).
  const otaDeviceId = lease?.deviceId ?? fallbackDeviceId;
  if (!otaDeviceId) {
    // Nothing to break. Two distinct causes — name the real one so the message isn't misleading:
    //  • Local mode (usePool === false): no online L2 mock was passed (`fallbackDeviceId` empty),
    //    i.e. `npm run dev` hasn't spawned/booted an L2 yet. The shared pool was never consulted.
    //  • Prod/pool mode: the shared pool is unavailable/unprovisioned.
    const error = cfg.usePool === false
      ? 'no L2 mock is online yet — the demo project seeds one on load (QEMU boots ~1 min); retry shortly'
      : 'no L2 device available — the shared pool is empty; try again in a moment';
    return { ok: false, status: 503, error };
  }
  const otaProjectId = lease ? L2_POOL_PROJECT_ID : projectId;

  // Independent writes/reads against Supabase — clearing the rate limit doesn't gate the device
  // read, so join them rather than paying both latencies in series.
  const [, seedTarget] = await Promise.all([
    clearRateLimit(supabase, otaProjectId),
    readSeedTarget(supabase, otaDeviceId),
  ]);
  // An unreadable/missing device is fatal (see readSeedTarget) — surface it BEFORE arming the
  // demo fault or enrolling an OTA target, so a bad id doesn't leave half a demo behind.
  if ('error' in seedTarget) return { ok: false, status: 500, error: seedTarget.error };
  const { version } = seedTarget;

  // Arm a DURABLE pseudo-fault on the device row so the durable plane genuinely shows it broken
  // (the agent's health-sensing reads devices.status). Anchored to the seeded buggy `version`:
  // migration 0080's upsert_device_heartbeat holds status='error' across the device's healthy
  // heartbeats until it adopts fw strictly greater than `version` (the agent's real fix OTA) or a
  // 40-min TTL elapses. Service-role client → bypasses RLS. Best-effort: the crash inject + buggy
  // source still drive the fix if this write fails.
  // Not silent: supabase-js resolves a rejected UPDATE as { error }, never throws — so an
  // unapplied migration 0080 (no demo_fault_above column) would reject the WHOLE update, leaving
  // status='error' unwritten too, and the old try/catch could not see it.
  {
    const { error } = await supabase
      .from('devices')
      .update({ status: 'error', demo_fault_above: version, demo_fault_since: new Date().toISOString() })
      .eq('id', otaDeviceId);
    if (error) {
      return {
        ok: false, status: 500,
        error: `could not arm the demo fault on ${otaDeviceId}: ${error.message}` +
          ' (is migration 0080_demo_persisted_fault applied?)',
      };
    }
  }

  // 1) Enroll the mock as an OTA target in its OWN group so the seed deploys to it alone.
  let target: { status: number; data: Record<string, unknown> | null };
  try {
    target = await callOta(
      '/internal/ensure-mock-target',
      { device_id: otaDeviceId, project_id: otaProjectId, group_name: `demo-selfheal-${otaDeviceId}` },
      ota,
    );
  } catch (e) {
    return otaFailure(e);
  }
  if (target.status < 200 || target.status >= 300) {
    return { ok: false, status: 502, error: (target.data?.error as string) ?? `ensure-mock-target returned ${target.status}` };
  }

  // 2) REGISTER the buggy source WITHOUT building it (was: seed → slow L2 compile+boot). This
  // records a mock_firmware_revisions row so get_firmware_source returns a real bug for the agent
  // to read+fix, but the device never adopts a buggy image — no minutes-long compile, no real
  // crash-loop. The crash is injected instead (step 2b).
  // build_id = sha256(source), and firmware_versions.build_id is globally UNIQUE — but the buggy
  // bodies are byte-identical across devices, so two devices on the same scenario (or any re-run)
  // would collide. Prepend a per-device+version marker comment to make each build_id unique.
  // compile.py strips comments before fault detection, so the bug is unchanged; the agent keeps
  // "the rest intact", so its fix inherits the marker and stays unique.
  // The agent's LATER fix (submit_firmware_fix) IS really compiled by nff-github on an L2, so the
  // registered source must still be a buildable sketch there — branch on device_type as before.
  const otaIsL2 = seedTarget.deviceType === L2_DEVICE_TYPE;
  // No cross-level fallback: an L2 seeded with the L1 pseudo-.ino cannot compile (no setup(),
  // undefined `Reading`), so the agent's fix would fail the real build minutes later with a
  // confusing gcc error. Fail here, naming the gap, instead of shipping an unbuildable seed.
  const bugBody = otaIsL2 ? BUGGY_SOURCES_L2[scenario] : BUGGY_SOURCES[scenario];
  if (!bugBody) {
    return {
      ok: false, status: 400,
      error: `scenario "${scenario}" has no ${otaIsL2 ? 'L2' : 'L1'} buggy source ` +
        `(device ${otaDeviceId} is ${seedTarget.deviceType || 'untyped'})`,
    };
  }
  const seededSource = `// nff-seed device=${otaDeviceId} version=${version}\n${bugBody}`;
  let seed: { status: number; data: Record<string, unknown> | null };
  try {
    seed = await callOta(
      '/internal/firmware/register-source',
      { device_id: otaDeviceId, project_id: otaProjectId, version, source: seededSource },
      ota,
    );
  } catch (e) {
    return otaFailure(e);
  }
  if (seed.status < 200 || seed.status >= 300) {
    return { ok: false, status: 502, error: (seed.data?.error as string) ?? `register-source returned ${seed.status}` };
  }
  // The build_id nff-ota hashed from the registered source — inject the crash with the SAME id so
  // the injected panic dump's "ELF file SHA256:" line matches get_firmware_source.
  //
  // A MISSING build_id is a hard failure, not a fallback. This used to degrade to '' so the crash
  // could still be injected, and that hid a prod outage for as long as it existed: the edge had no
  // allowlist entry for /internal/firmware/register-source, so the call fell through to IntraMap's
  // SPA, which answers 200 with HTML. The status check above passed, `data` parsed as null, the
  // build_id defaulted to '', and the demo cheerfully broke a device whose source was never
  // registered — leaving an incident no agent could fix and no crash that could resolve. Nothing
  // downstream can tell that apart from success, so it has to be caught HERE.
  const seededBuildId = typeof seed.data?.build_id === 'string' ? seed.data.build_id : '';
  if (!seededBuildId) {
    return {
      ok: false,
      status: 502,
      error:
        'register-source returned no build_id — the source was NOT recorded, so refusing to break ' +
        `device ${otaDeviceId} (it would be unfixable). Most likely the request never reached ` +
        'nff-ota: check that the edge allowlists POST /internal/firmware/register-source and ' +
        'that it answers JSON, not SPA HTML.',
    };
  }

  // 2b) INJECT the prerecorded crash NOW so the dashboard incident popup + the agent's
  // fleet_get_crash fire in ~1-2s, decoupled from the device's actual (healthy) firmware. Runs
  // against the pool device in the pool project so the crash_reports row is tenant-scoped like the
  // old seed path. Best-effort — never fail the demo on this (the agent fix path is independent).
  const inject = await injectCrashViaController({
    deviceId: otaDeviceId,
    projectId: otaProjectId,
    scenario,
    buildId: seededBuildId,
    fwVersion: version,
  }).catch((e) => ({ ok: false, status: 502, error: `${(e as Error)?.message ?? e}` }));
  if (!inject.ok) {
    // Non-fatal: the agent still runs and fixes; the incident popup just won't fire instantly.
    console.warn(`[selfheal] crash injection failed for ${otaDeviceId}: ${inject.error}`);
  }

  // 3) Hand the crash to the agent (Realtime), scoped to the dedicated demo chat session so its
  // narration + 💭 reasoning show in the Agent CHAT (not the session-global Console). The session +
  // message live in the CALLER's project (visible with no overlay); the agent's device-anchored
  // tools (get_firmware_source/submit_firmware_fix) still act on the pool device.
  const sessionId = await resolveDemoSession(supabase, projectId);
  await triggerAgentFix(supabase, otaDeviceId, projectId, scenario, sessionId);

  return {
    ok: true,
    status: 200,
    mode: 'seed',
    version,
    device_id: otaDeviceId,   // the device actually being broken (the borrowed pool L2, or the fallback)
    fault_remaining: Boolean(seed.data?.fault_remaining),
    session_id: sessionId,
    ...(lease ? { lease_state: 'active' as const } : {}),
  };
}
