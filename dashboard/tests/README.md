# Dashboard e2e (Playwright)

Browser-level click-through tests that drive the **real** dashboard — sign in, click through
tabs, spawn mock devices, break the fleet and watch it self-heal. Runs fully locally against the
**dev** Supabase.

## One-time setup

```bash
cd nff-dashboard
npm install
npx playwright install chromium
cp .env.example .env.local.dev      # then fill TEST_USER_EMAIL / TEST_USER_PASSWORD
npm run test:seed-user              # creates a CONFIRMED, isolated dev test user
```

`test:seed-user` uses the service-role key from `.env.local.dev` to create the user
pre-confirmed. The `on_auth_user_created` trigger gives it its **own** personal + demo projects,
so its clicks never touch a real tenant (RLS enforces this), and it auto-lands in the demo
project every demo control needs.

## The four user journeys → three test tiers

The specs cover the four core journeys, tiered by the backing stack they need. Heavy tiers
**auto-skip** (not fail) when their local services aren't up, so a plain run is always green.

| Tier | Playwright project | Journey(s) | Needs running | Cost |
|---|---|---|---|---|
| **A** | `dashboard` | 1. see & click through all tabs | SPA + remote dev Supabase only | instant, free |
| **B** | `live` | 2. spawn mocks · 3/4. crash+bug *kick-off* | + docker fleet, mock ctl `:3004`, nff-ota `:3002` | ~1 min, **no tokens** |
| **C** | `live-heal` | 3/4. full *recovery* (device returns online) | + nff-agent-worker `:8090` | 1–5 min, **spends agent tokens** |

Tier B/C need the local stack — bring it up first with **`npm run dev` at the repo root**
(docker fleet + mock controller + nff-ota + nff-agent-worker + dashboard). If it's down, those
tiers report *skipped*.

## Run

```bash
npm run test:e2e            # Tier A (all tabs) + the demo smoke test. Tier B/C auto-skip if stack down.
npm run test:e2e:headed     # watch the browser click through it
npm run test:e2e:ui         # Playwright UI mode (time-travel debugging)
npm run test:e2e:demo       # only the no-login demo.html smoke test (no user/backend)

# with the full local stack up (npm run dev at repo root):
npm run test:e2e:live       # Tier B — spawn + crash/bug kick-off (no tokens)
npm run test:e2e:heal       # Tier C — full recovery (RUN_HEAL=1; spends agent tokens)

npx playwright show-report  # open the HTML report after a run
```

The `webServer` in `playwright.config.ts` boots `npm run dev` (just the SPA) if nothing is on
`:5173`, or **reuses** a full stack you already have running.

## Layout

- `auth.setup.ts` — signs in once, saves the session to `.auth/user.json`, suppresses the
  first-run onboarding tour (its overlay intercepts clicks).
- `all-tabs.spec.ts` — **Scenario 1** (Tier A): clicks every nav group + sub-tab, asserts each
  activates and renders; screenshots each into `test-results/tabs/`.
- `live/spawn-mocks.spec.ts` — **Scenario 2** (Tier B): spawn mocks, wait for them online.
- `live/crash-selfheal.spec.ts` — **Scenario 3** (Tier B kick-off + Tier C `@heal` recovery):
  break a mock with a reboot scenario, assert the incident fires, then that it recovers.
- `live/self-heal-code.spec.ts` — **Scenario 4** (Tier B kick-off + Tier C `@heal` recovery):
  the held-code self-heal — seed a REAL bug (`null_deref`), the agent fixes the actual source and
  OTA-recovers the device. **No git push.**
- `demo.spec.ts` — the public `demo.html` embed; no auth, no backend, always green.
- `helpers/stack.ts` — port probes + `requireStack`/`requireHealOptIn` (the auto-skip + token guard).
- `helpers/demo.ts` — shared page actions (nav, spawn, break-and-self-heal, wait-for-recovered).

Credentials live in `.env.local.dev` (gitignored) alongside the dev config — one env file per environment, no separate test file. `.auth/` and `test-results/` are gitignored.

## Scenario 4, the literal version (Track 2 — NOT a browser test)

Scenario 4's clickable form above proves the agent fixing **real code** it holds. The literal
"a user edits firmware source in an editor and `git push`es → CI build → fix PR → merge → OTA →
device recovers" story is **not** browser-drivable (no dashboard tab edits+pushes source). It is
the flagship GitHub loop, exercised only by the **Python e2e harness**:

```bash
cd ../e2e
python run_nightly.py          # or: pytest test_push_ota_device.py
```

Prerequisites (see `../e2e/README.md`): the full `docker compose -f docker-compose.dev.yml up`
stack, the `nff-fetch`/`nff-build` sandbox images, a **GitHub App** on `GLechevalier/test-nff`
with **Contents R/W + Pull requests R/W + Checks**, a **cloudflare tunnel** delivering webhooks to
`nff-github :3003`, a local clone with push access, and `projects.pr_auto_merge` for the
unattended variant. It runs ~7 min and is **not CI-runnable**. `npm run test:track2` just prints
this pointer.
