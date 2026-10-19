#!/usr/bin/env node
// =============================================================================
// seed-test-user.mjs — create (idempotently) a CONFIRMED e2e test user on the
// DEV Supabase, so Playwright can sign in through the real login form.
//
//   npm run test:seed-user
//
// Uses the service_role key from .env.local.dev (server-side only) to create the
// user pre-confirmed (email_confirm: true), so no inbox round-trip is needed. The
// on_auth_user_created trigger (migration 05) provisions this user its OWN personal
// + demo projects, so the account is a fully isolated tenant — RLS keeps its clicks
// off every real project. Credentials come from .env.local.dev (see .env.example).
//
// Re-running is safe: if the user already exists we just reset its password + confirm
// it so it always matches .env.local.dev.
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

function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(2); }

const dev = loadEnvFile(path.join(ROOT, '.env.local.dev'));

const url = dev.VITE_SUPABASE_URL;
const serviceKey = dev.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.TEST_USER_EMAIL || dev.TEST_USER_EMAIL;
const password = process.env.TEST_USER_PASSWORD || dev.TEST_USER_PASSWORD;

if (!url || !serviceKey) fail('VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local.dev.');
if (!email || !password) fail('TEST_USER_EMAIL / TEST_USER_PASSWORD missing — add them to .env.local.dev (see .env.example).');
if (!/supabase\.co/.test(url)) fail(`Refusing to run: ${url} does not look like the dev Supabase.`);

const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

async function findUserByEmail(target) {
  for (let page = 1; page <= 40; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) fail(`listUsers failed: ${error.message}`);
    const hit = data.users.find((u) => (u.email || '').toLowerCase() === target.toLowerCase());
    if (hit) return hit;
    if (data.users.length < 200) return null; // last page
  }
  return null;
}

console.log(`\nSeeding e2e test user "${email}" on ${url} …`);

const { data: created, error: createErr } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});

if (!createErr) {
  console.log(`✓ created + confirmed (${created.user.id}). Its personal/demo projects were auto-provisioned.\n`);
  process.exit(0);
}

if (!/already|registered|exists/i.test(createErr.message)) fail(`createUser failed: ${createErr.message}`);

// Already exists — reset its password + ensure it's confirmed so it matches .env.local.dev.
const existing = await findUserByEmail(email);
if (!existing) fail(`createUser said the user exists, but it wasn't found via listUsers: ${createErr.message}`);

const { error: updErr } = await supabase.auth.admin.updateUserById(existing.id, {
  password,
  email_confirm: true,
});
if (updErr) fail(`updateUserById failed: ${updErr.message}`);

console.log(`✓ user already existed (${existing.id}) — reset password + confirmed.\n`);
process.exit(0);
