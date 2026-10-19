import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load nff-app/.env.local.dev (gitignored) into process.env so specs can read the
// dev test-user credentials. Kept dependency-free (no dotenv) — same tiny parser the
// root dev.mjs orchestrator uses. Values already in the environment win.
const DIR = path.dirname(fileURLToPath(import.meta.url));
function loadEnvFile(p: string) {
  if (!fs.existsSync(p)) return;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile(path.join(DIR, '.env.local.dev'));

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';

export default defineConfig({
  testDir: './tests',
  // One retry locally smooths over the occasional Supabase auth round-trip hiccup.
  retries: process.env.CI ? 2 : 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    // Capture a trace + screenshot when something fails so you can see the last frame.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    // 1) Sign in once against the DEV Supabase and cache the session to .auth/user.json.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },

    // 2) Tier A — the real dashboard, signed in, SPA + remote Supabase only. Fast, deterministic.
    //    Scenario 1: click through every tab & sub-tab.
    {
      name: 'dashboard',
      testMatch: /all-tabs\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: '.auth/user.json' },
    },

    // 3) The public, no-login demo embed (demo.html) — needs no auth and no backend,
    //    so it stays green even if the dev stack / Supabase is down.
    {
      name: 'public',
      testMatch: /demo\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },

    // 4) Tier B — `live`: scenarios 2/3/4 kick-off. Needs the local stack (mock ctl + fleet +
    //    ota); each suite AUTO-SKIPS when its ports are down, so a plain run just reports skips.
    //    No agent, no token spend. Excludes the token-spending @heal recovery tests.
    {
      name: 'live',
      testMatch: 'live/**/*.spec.ts',
      grepInvert: /@heal/,
      dependencies: ['setup'],
      timeout: 180_000,
      retries: 0,
      use: { ...devices['Desktop Chrome'], storageState: '.auth/user.json' },
    },

    // 5) Tier C — `live-heal`: the full-recovery assertions (scenarios 3/4). Adds the agent
    //    worker and SPENDS TOKENS, so it also requires RUN_HEAL=1 (see requireHealOptIn).
    //    Run via `npm run test:e2e:heal`.
    {
      name: 'live-heal',
      testMatch: 'live/**/*.spec.ts',
      grep: /@heal/,
      dependencies: ['setup'],
      timeout: 360_000,
      retries: 0,
      use: { ...devices['Desktop Chrome'], storageState: '.auth/user.json' },
    },
  ],

  // Boot the dashboard's own Vite dev server if it isn't already up. If you already have
  // the full stack running (`npm run dev` at the repo root), this reuses it — otherwise it
  // starts just the SPA, which is enough for login + Supabase-backed tabs.
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});