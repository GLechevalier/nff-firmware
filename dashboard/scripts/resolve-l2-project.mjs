#!/usr/bin/env node
// =============================================================================
// resolve-l2-project.mjs — resolve a dashboard user's project UUID on the DEV
// Supabase, so the root dev orchestrator (scripts/dev.mjs) knows where to spawn
// its two L2 mock devices.
//
//   node scripts/resolve-l2-project.mjs <email> [--personal]
//
// Project UUIDs are random (gen_random_uuid()) and provisioned per-user by the
// on_auth_user_created trigger, so they must be looked up at runtime. Uses the
// service_role key from .env.local.dev (bypasses RLS), exactly like
// seed-test-user.mjs. By default it returns the user's DEMO project
// (is_demo=true) — the one the dashboard opens on and the demo fleet seeds —
// which is where the L2s should land so they're visible immediately. Pass
// --personal for the isolated (is_demo=false) project instead.
//
// CONTRACT: on success prints ONLY the bare project UUID to STDOUT (nothing
// else) and exits 0. All diagnostics go to STDERR. On any failure it prints a
// reason to STDERR and exits non-zero with empty stdout, so the caller treats
// it as "unresolved" and skips the L2 spawn.
// =============================================================================

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

function fail(msg) { process.stderr.write(`resolve-l2-project: ${msg}\n`); process.exit(2); }

const args = process.argv.slice(2);
const personal = args.includes('--personal');
const email = (args.find((a) => !a.startsWith('--')) || process.env.NFF_DEV_L2_USER_EMAIL || '').trim();

const dev = loadEnvFile(path.join(ROOT, '.env.local.dev'));
const url = dev.VITE_SUPABASE_URL;
const serviceKey = dev.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) fail('VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local.dev.');
if (!email) fail('no email given (argv[2] or NFF_DEV_L2_USER_EMAIL).');

const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function userIdByEmail(target) {
  for (let page = 1; page <= 40; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail(`listUsers failed: ${error.message}`);
    const hit = data.users.find((u) => (u.email || '').toLowerCase() === target.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 200) return null; // last page
  }
  return null;
}

const userId = await userIdByEmail(email);
if (!userId) fail(`no user found for "${email}" on ${url} — sign into the dashboard once to create it.`);

// owner_id is set on BOTH the personal and demo projects at provisioning, so we can filter
// projects directly (no project_members join needed). Demo is the default target.
let query = supabase.from('projects').select('id, is_demo, created_at').eq('owner_id', userId);
query = personal
  ? query.eq('is_demo', false).order('created_at', { ascending: true })
  : query.eq('is_demo', true);
const { data: proj, error } = await query.limit(1).maybeSingle();
if (error) fail(`projects query failed: ${error.message}`);
if (!proj) fail(`user ${email} has no ${personal ? 'personal' : 'demo'} project yet — open the dashboard once.`);

process.stderr.write(`resolve-l2-project: ${email} → ${personal ? 'personal' : 'demo'} project ${proj.id}\n`);
process.stdout.write(String(proj.id)); // bare UUID, no newline — the only stdout output
process.exit(0);
