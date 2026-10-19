import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { pingViaFleet, crashViaFleet } from './api/_fleet'
import { uploadFirmware } from './api/_firmware'
import { spawnMocks, listMocks, deleteMock, seedFleet, markPresence } from './api/_mock'
import { selfHeal, poolPresencePing } from './api/_selfheal'
import { buildFeature } from './api/_build'
import { connectRepoViaGithub, deleteFeatureBranchViaGithub, disconnectRepoViaGithub, setDeployPolicyViaGithub, fetchRepoTreeViaGithub, fetchRepoBranchesViaGithub, fetchRepoFileViaGithub, pingGithubTunnel, githubInstallUrlFor, githubInstalled, installationReposViaGithub } from './src/add-ons/github/api/github'
import { provisionBatch } from './api/_provision'
import { compileFlash } from './api/_compile-flash'
import { mintLinkToken } from './api/_link-token'
import { exportUserData, deleteUserAccount } from './api/_account'
import { deployFirmware, deploymentStatus, listDeployments, listDevices } from './api/_ota'
import { authLogin, authRefresh, authLogout } from './api/_auth'
import { brainSync } from './api/_brain'
import { createClient } from '@supabase/supabase-js'

// Parse a positive-integer env var, falling back to a default (used for the demo seed targets).
function intOr(v: string | undefined, dflt: number): number {
  const n = parseInt(v ?? '', 10)
  return Number.isInteger(n) && n > 0 ? n : dflt
}

// Dev-only: serve POST /api/devices/ping during `npm run dev` (Vite doesn't run the
// Vercel api/ functions). Mirrors api/devices/ping.ts using the same shared helper, so
// the dashboard's Ping button works locally exactly as it will in prod. Fleet creds are
// read from the (non-VITE_) env so they never reach the browser bundle.
function devApi(env: Record<string, string>): Plugin {
  return {
    name: 'nff-dev-api',
    configureServer(server) {
      server.middlewares.use('/api/devices/ping', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const r = await pingViaFleet(parsed.device_id, parsed.project_id, {
          fleetUrl: env.NFF_FLEET_URL,
          fleetSecret: env.NFF_FLEET_SECRET,
        })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/auth.ts: CLI login / token refresh / logout proxied to Supabase
      // GoTrue with the anon key. Consumed by nff/tools/auth.py (direct_login, refresh_tokens).
      server.middlewares.use('/api/auth', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const action = (req.url ?? '').split('?')[0].replace(/^\//, '')
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const cfg = { supabaseUrl: env.VITE_SUPABASE_URL, anonKey: env.VITE_SUPABASE_ANON_KEY }
        let r
        if (action === 'login') r = await authLogin(parsed.email, parsed.password, cfg)
        else if (action === 'refresh') r = await authRefresh(parsed.refresh_token, cfg)
        else if (action === 'logout') r = await authLogout(req.headers['authorization'], cfg)
        else r = { ok: false, status: 404, error: `unknown auth action: ${action}` }
        res.statusCode = r.status
        if (r.status === 204) { res.end(); return }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r.ok ? r.data : { ok: false, error: r.error }))
      })

      // Dev mirror of api/account.ts's brain-ingest / brain-ping actions, which
      // vercel.json exposes as /api/brain/{ingest,ping}. The nff-brain CLI and
      // extensions authenticate with an opaque x-brain-sync-token (resolved
      // against brain_sync_tokens, migration 0141) rather than a Supabase JWT,
      // so this is the one brain route that needs a server at all — every other
      // brain call in nff-app goes straight to Supabase under RLS.
      server.middlewares.use('/api/brain', async (req, res) => {
        const path = (req.url ?? '').split('?')[0].replace(/^\//, '')
        const ping = path === 'ping'
        if ((ping && req.method !== 'GET') || (path === 'ingest' && req.method !== 'POST')) {
          res.statusCode = 405
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        if (!ping && path !== 'ingest') {
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: `unknown brain action: ${path}` }))
          return
        }
        let parsed: Record<string, unknown> = {}
        if (!ping) {
          let raw = ''
          for await (const chunk of req) raw += chunk
          try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        }
        // loadEnv() values never reach process.env, so pass the client in
        // explicitly (same seam the auth mirror above uses for AuthCfg).
        const db = createClient(env.VITE_SUPABASE_URL ?? '', env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
          auth: { persistSession: false, autoRefreshToken: false },
        })
        const r = await brainSync(req.headers['x-brain-sync-token'], ping, parsed, db)
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r.body))
      })

      // Dev mirror of api/devices/crash.ts: inject a crash scenario on a mock device.
      server.middlewares.use('/api/devices/crash', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const r = await crashViaFleet(parsed.device_id, parsed.project_id, parsed.scenario, {
          fleetUrl: env.NFF_FLEET_URL,
          fleetSecret: env.NFF_FLEET_SECRET,
        })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/provision.ts: mint a batch bootstrap credential for the signed-in
      // user's project (browser flasher onboarding). Membership is enforced via the user's
      // Supabase JWT; the fleet secret comes from the (non-VITE_) env, server-side only.
      server.middlewares.use('/api/provision', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const r = await provisionBatch(req.headers['authorization'], parsed.project_id, {
          supabaseUrl: env.VITE_SUPABASE_URL,
          anonKey: env.VITE_SUPABASE_ANON_KEY,
          fleetUrl: env.NFF_FLEET_URL,
          fleetSecret: env.NFF_FLEET_SECRET,
        })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/link-token.ts: mint a short-lived WS URL for nff-fleet's /link bridge
      // (wired USB/PPPoS onboarding). Membership via the user's JWT; fleet secret server-side.
      server.middlewares.use('/api/link-token', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const r = await mintLinkToken(req.headers['authorization'], parsed.project_id, parsed.dst, {
          supabaseUrl: env.VITE_SUPABASE_URL,
          anonKey: env.VITE_SUPABASE_ANON_KEY,
          fleetWsUrl: env.NFF_FLEET_WS_URL,
          fleetSecret: env.NFF_FLEET_SECRET,
          httpMirror: env.NFF_LINK_HTTP_MIRROR,
        })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/compile-flash.ts: compile the signed-in user's connected repo (prod-branch
      // HEAD) into a full USB-flashable segment set, enrollment injected, and stream it back. The
      // Code-tab "Flash (build & enroll)" button calls this. Membership via the user's JWT; the
      // nff-github internal secret stays server-side.
      server.middlewares.use('/api/compile-flash', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const r = await compileFlash(req.headers['authorization'], parsed, {
          supabaseUrl: env.VITE_SUPABASE_URL,
          anonKey: env.VITE_SUPABASE_ANON_KEY,
          githubUrl: env.NFF_GITHUB_INTERNAL_URL,
          githubSecret: env.NFF_GITHUB_INTERNAL_SECRET,
        })
        if (!r.ok) {
          res.statusCode = r.status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(r))
          return
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/x-ndjson')
        const reader = r.upstream.body?.getReader()
        if (!reader) { res.end(); return }
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) res.write(Buffer.from(value))
          }
        } catch { /* client disconnect / upstream abort */ } finally { res.end() }
      })

      // Dev mirror of api/demo/spawn.ts: ask the nff-mock controller to spawn a small
      // fleet of live mock devices for the demo project. Controller creds come from the
      // (non-VITE_) env so the control secret never reaches the browser bundle.
      const mockCfg = { ctlUrl: env.NFF_MOCKCTL_URL, controlSecret: env.NFF_MOCKCTL_CONTROL_SECRET }
      server.middlewares.use('/api/demo/spawn', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const count = typeof parsed.count === 'number' ? parsed.count : undefined
        const namePrefix = typeof parsed.name_prefix === 'string' ? parsed.name_prefix : undefined
        const r = await spawnMocks(parsed.project_id, { count, namePrefix }, mockCfg)
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/demo/seed-fleet.ts: seed a new user's demo project to a fixed mock
      // fleet (8 Level-1 + 2 Level-2 by default), spawning only the per-level deficit. Fired
      // once on first login by useDemoFleetSeed. L2 is best-effort here — plain `npm run dev`
      // has no QEMU L2 image, so those spawns soft-fail and only the L1s appear (l2_note set).
      server.middlewares.use('/api/demo/seed-fleet', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        // l1_only = the recurring keep-alive top-up (L2 seeded once, then left to idle-release).
        // Local mode (no pool borrow — see /api/demo/selfheal below) breaks the project's OWN L2s,
        // so seed 2 here; with NFF_L2_SELFHEAL_USE_POOL=1 the pool supplies them and we seed none
        // (prod's api/demo.ts default).
        const ownL2 = env.NFF_L2_SELFHEAL_USE_POOL === '1' ? 0 : 2
        const target = {
          l1: intOr(env.NFF_DEMO_SEED_L1, 8),
          l2: parsed.l1_only === true ? 0 : intOr(env.NFF_DEMO_SEED_L2, ownL2),
        }
        const r = await seedFleet(parsed.project_id, target, mockCfg)
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of POST /api/demo/presence: keep-alive heartbeat marking the demo project
      // 'user online' so the controller never TTL-reaps its Level-1 mocks while the tab is open.
      server.middlewares.use('/api/demo/presence', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const [r] = await Promise.all([
          markPresence(parsed.project_id, mockCfg),
          poolPresencePing(parsed.project_id, {
            supabaseUrl: env.VITE_SUPABASE_URL,
            serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
          }),
        ])
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of GET /api/demo/mocks: list running mocks for a project (used to
      // label the WelcomeBanner button as "re-spawn / add more" when a fleet is up).
      server.middlewares.use('/api/demo/mocks', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const url = new URL(req.url ?? '', 'http://localhost')
        const r = await listMocks(url.searchParams.get('project_id'), mockCfg)
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of POST /api/demo/retire: tear down a single mock's container (+ cert +
      // device row) via the controller. Used when a mock is deleted from the rejected lane.
      server.middlewares.use('/api/demo/retire', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const deviceId = parsed.device_id
        if (typeof deviceId !== 'string' || !deviceId.startsWith('mock-')) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: "a 'mock-' device_id is required" }))
          return
        }
        const r = await deleteMock(deviceId, mockCfg)
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/demo/selfheal.ts: drive the held-firmware self-healing pipeline for a
      // mock — seed a real bug + trigger the agent (crash-loop scenarios) or inject a transient
      // crash (reboot scenarios). Reads nff-ota + fleet + service-role creds from the (non-VITE_)
      // env so no secret reaches the browser bundle.
      server.middlewares.use('/api/demo/selfheal', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const r = await selfHeal(parsed.device_id, parsed.project_id, parsed.scenario, parsed.request_key, {
          otaUrl: env.NFF_OTA_URL,
          fleetUrl: env.NFF_FLEET_URL,
          fleetSecret: env.NFF_FLEET_SECRET,
          supabaseUrl: env.VITE_SUPABASE_URL,
          serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
          // Local mode breaks the OWN L2s `npm run dev` spawned — don't borrow from the shared cloud
          // pool (which would queue you behind other users). Set NFF_L2_SELFHEAL_USE_POOL=1 to opt
          // back into pool borrowing locally (e.g. to test the lease path).
          usePool: env.NFF_L2_SELFHEAL_USE_POOL === '1',
        })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/demo.ts `case 'build'`: the develop-a-feature DEMO — autonomously plan +
      // build + validate ONE prechosen feature on a mock canary. Inserts an engineered
      // agent_messages row into the caller's builder session (service-role); the worker picks it
      // up over Realtime. Reads only the service-role creds from the (non-VITE_) env.
      server.middlewares.use('/api/demo/build', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const r = await buildFeature(parsed.project_id, parsed.session_id, {
          supabaseUrl: env.VITE_SUPABASE_URL,
          serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
        })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/github/connect.ts: connect a GitHub repo to a device group via
      // nff-github's /internal/connect-repo route. The internal secret stays server-side.
      server.middlewares.use('/api/github/connect', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const r = await connectRepoViaGithub(parsed, {
          githubUrl: env.NFF_GITHUB_INTERNAL_URL,
          githubSecret: env.NFF_GITHUB_INTERNAL_SECRET,
        })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/github/disconnect.ts: remove a repo connection via nff-github's
      // /internal/disconnect-repo route. The internal secret stays server-side.
      server.middlewares.use('/api/github/disconnect', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const r = await disconnectRepoViaGithub(parsed, {
          githubUrl: env.NFF_GITHUB_INTERNAL_URL,
          githubSecret: env.NFF_GITHUB_INTERNAL_SECRET,
        })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/github?action=set-deploy-policy: connector card's auto/manual toggle.
      server.middlewares.use('/api/github/set-deploy-policy', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const r = await setDeployPolicyViaGithub(parsed, {
          githubUrl: env.NFF_GITHUB_INTERNAL_URL,
          githubSecret: env.NFF_GITHUB_INTERNAL_SECRET,
        })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/github?action=delete-feature-branch: Builder-tab feature cancel.
      // Authenticated — the helper resolves the feature under the caller's JWT (RLS) and
      // only then asks nff-github to delete its nff-feature/* branch.
      server.middlewares.use('/api/github/delete-feature-branch', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let parsed: Record<string, unknown> = {}
        try { parsed = raw ? JSON.parse(raw) : {} } catch { /* ignore */ }
        const r = await deleteFeatureBranchViaGithub(req.headers['authorization'], parsed, {
          githubUrl: env.NFF_GITHUB_INTERNAL_URL,
          githubSecret: env.NFF_GITHUB_INTERNAL_SECRET,
          supabaseUrl: env.VITE_SUPABASE_URL,
          anonKey: env.VITE_SUPABASE_ANON_KEY,
        })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirrors of api/github.ts install-url / installed / installation-repos: the GitHub App
      // install flow. The dev App's Setup URL must point at http://localhost:5173/api/github/installed.
      const installCfg = {
        githubUrl: env.NFF_GITHUB_INTERNAL_URL,
        githubSecret: env.NFF_GITHUB_INTERNAL_SECRET,
        supabaseUrl: env.VITE_SUPABASE_URL,
        anonKey: env.VITE_SUPABASE_ANON_KEY,
        appSlug: env.NFF_GITHUB_APP_SLUG,
        adminOrigin: env.NFF_ADMIN_ORIGIN ?? 'http://localhost:3055',
      }
      server.middlewares.use('/api/github/install-url', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ ok: false, error: 'method not allowed' })); return }
        const url = new URL(req.url ?? '', 'http://localhost')
        const r = await githubInstallUrlFor(req.headers['authorization'], { project_id: url.searchParams.get('project_id') }, installCfg)
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(r))
      })
      server.middlewares.use('/api/github/installed', async (req, res) => {
        const url = new URL(req.url ?? '', 'http://localhost')
        const r = await githubInstalled({
          installation_id: url.searchParams.get('installation_id'),
          state: url.searchParams.get('state'),
          setup_action: url.searchParams.get('setup_action'),
        }, installCfg)
        res.statusCode = 302
        res.setHeader('Location', r.redirect)
        res.end()
      })
      server.middlewares.use('/api/github/installation-repos', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ ok: false, error: 'method not allowed' })); return }
        const url = new URL(req.url ?? '', 'http://localhost')
        const r = await installationReposViaGithub(req.headers['authorization'], { project_id: url.searchParams.get('project_id') }, installCfg)
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/github/health.ts: probe nff-github through the public tunnel
      // (NFF_GITHUB_INTERNAL_URL) so the Management graph shows it green only when online
      // AND reachable, not merely heartbeating.
      server.middlewares.use('/api/github/health', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, reachable: false, error: 'method not allowed' }))
          return
        }
        const r = await pingGithubTunnel({
          githubUrl: env.NFF_GITHUB_INTERNAL_URL,
          githubSecret: env.NFF_GITHUB_INTERNAL_SECRET,
        })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/github/repo-tree.ts: read a connected repo's full file tree via
      // nff-github's /internal/repo-tree route. The internal secret stays server-side.
      server.middlewares.use('/api/github/repo-tree', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const url = new URL(req.url ?? '', 'http://localhost')
        const r = await fetchRepoTreeViaGithub({
          repo_full_name: url.searchParams.get('repo_full_name'),
          ref: url.searchParams.get('ref'),
        }, {
          githubUrl: env.NFF_GITHUB_INTERNAL_URL,
          githubSecret: env.NFF_GITHUB_INTERNAL_SECRET,
        })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/github/repo-branches.ts: list a connected repo's real GitHub
      // branches for the Code-tab git graph (when the project opts into "all branches").
      server.middlewares.use('/api/github/repo-branches', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const url = new URL(req.url ?? '', 'http://localhost')
        const r = await fetchRepoBranchesViaGithub({
          repo_full_name: url.searchParams.get('repo_full_name'),
        }, {
          githubUrl: env.NFF_GITHUB_INTERNAL_URL,
          githubSecret: env.NFF_GITHUB_INTERNAL_SECRET,
        })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/github/repo-file.ts: lazy single-file read for the Code tab.
      server.middlewares.use('/api/github/repo-file', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const url = new URL(req.url ?? '', 'http://localhost')
        const r = await fetchRepoFileViaGithub({
          repo_full_name: url.searchParams.get('repo_full_name'),
          path: url.searchParams.get('path'),
          ref: url.searchParams.get('ref'),
        }, {
          githubUrl: env.NFF_GITHUB_INTERNAL_URL,
          githubSecret: env.NFF_GITHUB_INTERNAL_SECRET,
        })
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirror of api/firmware/upload.ts: store an uploaded artifact + upsert its
      // firmware_versions row via the service-role key (server-side only).
      server.middlewares.use('/api/firmware/upload', async (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        if (req.method !== 'POST') {
          send(405, { ok: false, error: 'method not allowed' })
          return
        }
        // Parse the query off the request URL (the middleware path is stripped from req.url).
        const url = new URL(req.url ?? '', 'http://localhost')
        const deviceTypes = (url.searchParams.get('device_types') ?? '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
        // Collect the raw binary body — string concat would corrupt the bytes.
        const chunks: Buffer[] = []
        try {
          for await (const chunk of req) chunks.push(Buffer.from(chunk))
        } catch (e) {
          send(400, { ok: false, error: `could not read body: ${(e as Error)?.message ?? e}` })
          return
        }
        const r = await uploadFirmware(Buffer.concat(chunks), {
          version: url.searchParams.get('version'),
          projectId: url.searchParams.get('project_id'),
          name: url.searchParams.get('name'),
          deviceTypes,
        }, {
          supabaseUrl: env.VITE_SUPABASE_URL,
          serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
        })
        send(r.status, r)
      })

      // Dev mirrors of api/account.ts. In prod both are one function dispatched on ?action=;
      // here each action needs its own middleware path, because Vite strips the mounted path
      // from req.url and there is no query string to dispatch on.
      const accountCfg = {
        supabaseUrl: env.VITE_SUPABASE_URL,
        anonKey: env.VITE_SUPABASE_ANON_KEY,
        serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      }

      server.middlewares.use('/api/account/export', async (req, res) => {
        if (req.method !== 'GET') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const r = await exportUserData(req.headers['authorization'], accountCfg)
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r.ok ? r.data : r))
      })

      server.middlewares.use('/api/account/delete', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
          return
        }
        const r = await deleteUserAccount(req.headers['authorization'], accountCfg)
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(r))
      })

      // Dev mirrors of api/ota/*.ts — the user-facing OTA surface the core CLI's `nff ota` calls.
      // Reads run under the caller's JWT (RLS); deploy forwards to nff-ota with the server secret.
      const otaCfg = {
        supabaseUrl: env.VITE_SUPABASE_URL,
        anonKey: env.VITE_SUPABASE_ANON_KEY,
        otaUrl: env.NFF_OTA_URL,
        fleetSecret: env.NFF_FLEET_SECRET,
      }
      const sendJson = (res: any, status: number, body: unknown) => {
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(body))
      }

      server.middlewares.use('/api/ota/deploy', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        // The mounted path is stripped from req.url, so the query string is all that remains.
        const url = new URL(req.url ?? '', 'http://localhost')
        const deviceTypes = (url.searchParams.get('device_types') ?? '').split(',').map(s => s.trim()).filter(Boolean)
        const num = (v: string | null) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined)
        // Collect the raw binary body — string concat would corrupt the bytes.
        const chunks: Buffer[] = []
        try {
          for await (const chunk of req) chunks.push(Buffer.from(chunk))
        } catch (e) {
          sendJson(res, 400, { ok: false, error: `could not read body: ${(e as Error)?.message ?? e}` }); return
        }
        const r = await deployFirmware(req.headers['authorization'], Buffer.concat(chunks), {
          version: url.searchParams.get('version'),
          group: url.searchParams.get('group'),
          project: url.searchParams.get('project'),
          name: url.searchParams.get('name'),
          deviceTypes,
          maxInFlight: num(url.searchParams.get('max_in_flight')),
          retries: num(url.searchParams.get('retries')),
        }, otaCfg)
        sendJson(res, r.status, r.ok ? { ok: true, ...(r.data as object) } : r)
      })

      server.middlewares.use('/api/ota/status', async (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        const url = new URL(req.url ?? '', 'http://localhost')
        const depId = url.searchParams.get('deployment_id')
        const r = await deploymentStatus(req.headers['authorization'], depId || null, otaCfg)
        sendJson(res, r.status, r.ok ? { ok: true, ...(r.data as object) } : r)
      })

      server.middlewares.use('/api/ota/deployments', async (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        const r = await listDeployments(req.headers['authorization'], otaCfg)
        sendJson(res, r.status, r.ok ? { ok: true, ...(r.data as object) } : r)
      })

      server.middlewares.use('/api/ota/devices', async (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        const r = await listDevices(req.headers['authorization'], otaCfg)
        sendJson(res, r.status, r.ok ? { ok: true, data: r.data } : r)
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // '' prefix loads ALL vars (incl. non-VITE_ server-side ones) into `env` for the
  // dev middleware; Vite still only injects VITE_-prefixed vars into the client bundle.
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss(), devApi(env)],
    // The admin UI's status strip reads the build version (src/add-ons/OverviewTab).
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? 'dev'),
    },
    server: {
      // The GitHub add-on's Python service lives under src/ (src/add-ons/github/service);
      // its .nff-build clones/builds must not churn the dev watcher.
      // Same for the agent worker (src/core/agent/service): its node_modules and
      // fastembed/feature-repo caches are hundreds of MB of churn.
      // And .nff-brain: the local brain's activity/model files are rewritten on every
      // agent turn; not gitignored, so Tailwind's scanner picks them up and each write
      // full-reloaded the page — which reset the self-heal demo's client-side story.
      watch: { ignored: ['**/src/add-ons/github/service/**', '**/src/core/agent/service/**', '**/.nff-brain/**'] },
      // Mirrors vercel.json's /admin-api rewrite (which points at prod admin) but for
      // local dev: the embedded admin's src/core/lib/api.ts calls read
      // VITE_ADMIN_API_BASE (set to /admin-api in .env.local.dev) and need `npm run
      // dev:full` running in ../nff-admin for this to resolve.
      proxy: {
        '/admin-api': {
          target: env.VITE_ADMIN_API_BASE_TARGET || 'http://localhost:3055',
          changeOrigin: true,
          // BASE + path already contains /api/... (see api.ts) — strip only /admin-api.
          rewrite: (path) => path.replace(/^\/admin-api/, ''),
        },
      },
    },
    build: {
      rollupOptions: {
        // Three entry points: the real app (index.html); the public no-login demo
        // embedded on the marketing site (demo.html, scripted/local); and the public
        // no-login floor (floor.html), which reads the fixed floor project LIVE over
        // Supabase Realtime (anon key + public-read RLS) but is otherwise read-only.
        input: {
          main: 'index.html',
          demo: 'demo.html',
          floor: 'floor.html',
        },
      },
    },
  }
})
