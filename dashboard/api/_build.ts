// Shared server-side helper: kick off the "develop a feature" DEMO — an autonomous,
// prechosen firmware feature build. Used by both the Vercel function (api/demo.ts, prod)
// and the Vite dev middleware (vite.config.ts, `npm run dev`). Secrets stay server-side.
//
// The pattern mirrors the self-heal demo (api/_selfheal.ts): a service-role Supabase client
// (a) clears the per-project OTA rate limit so the build's rollout isn't throttled, then
// (b) INSERTs a single engineered `agent_messages` row (role='user') into the caller's
// builder chat session. The agent-worker picks it up over Realtime — there is NO HTTP call
// to the worker. Because the session is kind='builder', the worker runs the feature-build
// persona (interview.ts); its AUTONOMOUS MODE clause + these explicit instructions make it
// plan → build → deploy → validate the feature on an nff-mock canary with no interview and
// no approval gate. The engineered instructions are hidden behind USER_QUESTION_MARKER, so
// the chat shows only the short line after it (useAgentMessages strips the preamble).
//
// The feature is deliberately PRECHOSEN and fixed ("Low-battery alert") — this is a demo, not
// a user-driven interview. `.js` extension is mandatory on relative imports or Vercel prod
// dies ERR_MODULE_NOT_FOUND.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { USER_QUESTION_MARKER } from '../src/utils/chat.js';
import { BABYNFF_MAIN_C_CLEAN, BABYNFF_MAIN_PATH } from '../src/data/babynffFirmware.js';

// The bundled babynff demo repo. Held as a literal rather than imported from src/data/babynffRepo.ts
// on purpose: babynffRepo.ts type-imports the dashboard's React hooks (useRepoTree), and importing it
// here would drag that jsx graph into the Node-side api/vite.config tsconfig (tsconfig.node.json).
// babynffFirmware.ts above is a leaf (no imports), so it's safe. Keep this in sync with BABYNFF_REPO
// (src/data/babynffRepo.ts) and BABYNFF_DEMO_REPO (nff-builder/nff_builder/config.py).
const BABYNFF_REPO = 'babynff/babynff-repo';

export interface BuildFeatureCfg {
  supabaseUrl?: string; // VITE_SUPABASE_URL
  serviceRoleKey?: string; // SUPABASE_SERVICE_ROLE_KEY
}

export interface BuildFeatureResult {
  ok: boolean;
  status: number; // HTTP status to return to the client
  session_id?: string; // the builder session the agent narrates + plans in
  feature_title?: string; // the prechosen feature that was kicked off
  error?: string;
}

// The single, prechosen demo feature. It drives the narrative the user watches fill in — the
// Builder tab's live plan, the branch + firmware diff on the Code tab, then the canary rollout.
const FEATURE_TITLE = 'Low-battery alert';

// The branch the demo build cuts on the babynff repo (readable, stable — not the id-derived
// default). Surfaces in the Code-tab git graph once create_feature_branch records it.
const FEATURE_BRANCH = 'nff-feature/low-battery-alert';

// The release semver the merge PR is titled with. open_feature_pr uses the title verbatim as the
// squash-merge subject; for the virtual demo repo (babynff_mock) it's cosmetic, but keep it a
// plausible next release so the beat reads right.
const FEATURE_RELEASE = '1.1.0';

function resolveSupabase(cfg: BuildFeatureCfg): SupabaseClient | { error: string } {
  const supabaseUrl = cfg.supabaseUrl ?? process.env.VITE_SUPABASE_URL ?? '';
  const serviceRoleKey = cfg.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl) return { error: 'VITE_SUPABASE_URL is not configured' };
  if (!serviceRoleKey) return { error: 'SUPABASE_SERVICE_ROLE_KEY is not configured' };
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Clear the per-project OTA rate limit (migration 0054) so the demo build's OTA rollout isn't
// paused. Best-effort, but not silent (supabase-js reports failures on `error`, not by throwing).
async function clearRateLimit(supabase: SupabaseClient, projectId: string): Promise<void> {
  const { error } = await supabase
    .from('projects').update({ ota_rate_limit_seconds: 0 }).eq('id', projectId);
  if (error) console.warn(`[build] clearRateLimit failed for ${projectId}: ${error.message}`);
}

// The engineered instructions the worker's builder persona reads (before the marker); the short
// line after the marker is all the chat shows. Explicit + imperative so the agent runs the full
// build without interviewing or waiting for approval.
//
// The build runs against the bundled babynff demo repo (BABYNFF_REPO). That repo is a client-side
// fiction with no GitHub App, but nff-github recognises it and returns mocked GitHub responses
// (nff-github/nff_github/babynff_mock.py), so create_feature_branch / commit_feature_files flow through
// the real builder→nff-github pipeline: the branch is recorded on the feature (→ Code-tab git graph)
// and the firmware the agent authors streams live to the Code tab (the worker streams
// commit_feature_files' input regardless of the backend). We hand the agent the CURRENT main/main.c so
// it edits real source rather than inventing a file — the Code tab diffs its edit against the bundled
// clean version.
function buildInstructions(projectId: string, sessionId: string): string {
  const instructions =
    `AUTONOMOUS BUILD — no interview, no approval gate. Build this specific feature end-to-end on ` +
    `the connected demo repo **${BABYNFF_REPO}** and validate it on a SIMULATED nff-mock canary. ` +
    `This repo is wired for the build: run create_feature_branch and commit_feature_files against ` +
    `it exactly as written below (they are supported here — do NOT skip them).\n\n` +
    `FEATURE — **${FEATURE_TITLE}**:\n` +
    `- Sample the device battery level each telemetry cycle (ADC read + light smoothing).\n` +
    `- Add a \`battery_pct\` telemetry field reported alongside the existing fields.\n` +
    `- Emit an alert when the battery drops below 20%, with hysteresis so it doesn't chatter.\n\n` +
    `The CURRENT \`${BABYNFF_MAIN_PATH}\` is below — do NOT survey or read the repo, just edit THIS ` +
    `file to add the feature and commit the FULL edited file (keep the rest intact):\n\n` +
    '```c\n' + BABYNFF_MAIN_C_CLEAN + '\n```\n\n' +
    `Do this now, narrating each step; do NOT ask me any questions and do NOT wait for an ` +
    `"Approved" message:\n` +
    `1. \`plan_feature(project_id='${projectId}', session_id='${sessionId}', title='${FEATURE_TITLE}', ` +
    `description=..., sub_features=[...], user_stories=[...], steps=[...])\` — persist the full plan.\n` +
    `2. \`create_feature_branch(feature_id=..., repo_full_name='${BABYNFF_REPO}', ` +
    `branch_name='${FEATURE_BRANCH}')\` → the feature moves to branch_created.\n` +
    `3. \`commit_feature_files(feature_id=..., changes=[{path:'${BABYNFF_MAIN_PATH}', content:<full edited file>}])\` ` +
    `— write the firmware you authored onto the branch; it streams live to the Code tab.\n` +
    `4. \`ensure_mock_device(project_id='${projectId}')\` → {device_id, device_group_id}.\n` +
    `5. \`set_feature_canary(feature_id=..., tier='simulated', device_ids=[device_id])\`.\n` +
    `6. \`build_and_deploy_feature(feature_id=..., device_group_id=...)\` → {deployment_id}; the ` +
    `feature moves to validating.\n` +
    `7. \`await_feature_validation(feature_id=..., deployment_id=...)\` until it is validated. ` +
    `Once the canary reports GREEN, say so, then ship it — do NOT stop at validated:\n` +
    `8. \`open_feature_pr(feature_id=..., title='${FEATURE_RELEASE}', body=...)\` → opens the PR from ` +
    `'${FEATURE_BRANCH}' into main; the feature moves to pr_opened and the PR shows on the Code tab.\n` +
    `9. \`set_feature_status(feature_id=..., status='merged')\` → merge the branch into main. (This ` +
    `demo repo has no GitHub App, so complete the merge yourself — it's what "Allow nff to merge ` +
    `PRs" would do automatically for a real repo.) Narrate "canary green → opening PR → merging to ` +
    `main", then report the feature is merged. Be honest if anything fails (e.g. mock offline).`;
  return `${instructions}${USER_QUESTION_MARKER}Build a low-battery alert feature for my devices and validate it on a canary.`;
}

// ── orchestrator ──────────────────────────────────────────────────────────────────────
export async function buildFeature(
  projectId: unknown,
  sessionId: unknown,
  cfg: BuildFeatureCfg = {},
): Promise<BuildFeatureResult> {
  if (typeof projectId !== 'string' || !projectId) {
    return { ok: false, status: 400, error: 'project_id is required' };
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    return { ok: false, status: 400, error: 'session_id is required' };
  }
  const supabase = resolveSupabase(cfg);
  if ('error' in supabase) return { ok: false, status: 500, error: supabase.error };

  await clearRateLimit(supabase, projectId);

  const { error } = await supabase.from('agent_messages').insert({
    id: randomUUID(),
    role: 'user',
    content: buildInstructions(projectId, sessionId),
    ts: new Date().toISOString(),
    project_id: projectId,
    session_id: sessionId,
  });
  if (error) return { ok: false, status: 500, error: `failed to trigger build: ${error.message}` };

  return { ok: true, status: 200, session_id: sessionId, feature_title: FEATURE_TITLE };
}
