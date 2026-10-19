// Consolidated nff-github serverless function (prod). Vercel's Hobby plan caps a deployment
// at 12 Serverless Functions, so the per-action github routes (connect, disconnect, repo-tree,
// repo-file, repo-branches, health) are folded into this single function dispatched on
// ?action=…. The pretty sub-paths /api/github/<action> are mapped here by explicit rewrites in
// vercel.json that run BEFORE the SPA catch-all — a plain function file (not a dynamic
// [action] route), because dynamic API routes are matched AFTER user rewrites and would be
// swallowed by /(.*) -> /. Client URLs are unchanged, and local `npm run dev` is still served
// by the equivalent Vite middleware in vite.config.ts.
//
//   POST /api/github/connect       { repo_full_name, device_group_id, project_id, ... } -> { ok, connection | error }
//   POST /api/github/disconnect    { repo_full_name }                                   -> { ok, connection | error }
//   GET  /api/github/repo-tree     ?repo_full_name=owner/repo&ref=<optional>            -> { ok, ref, sha, entries[] | error }
//   GET  /api/github/repo-file     ?repo_full_name=owner/repo&path=…&ref=<optional>     -> { ok, path, content, sha | error }
//   GET  /api/github/repo-branches ?repo_full_name=owner/repo                           -> { ok, default_branch, branches[] | error }
//   GET  /api/github/health                                                             -> { ok, reachable, status, error? }
//   POST /api/github/delete-feature-branch { feature_id } + Authorization: Bearer <jwt> -> { ok, branch_name, deleted | error }
//   GET  /api/github/install-url        ?project_id= + Authorization: Bearer <jwt>         -> { ok, url | error }
//   GET  /api/github/installed          ?installation_id=&setup_action=&state=  (GitHub App Setup URL) -> 302
//   GET  /api/github/installation-repos ?project_id= + Authorization: Bearer <jwt>         -> { ok, repos[] | error }

import {
  connectRepoViaGithub,
  deleteFeatureBranchViaGithub,
  disconnectRepoViaGithub,
  setDeployPolicyViaGithub,
  fetchRepoTreeViaGithub,
  fetchRepoFileViaGithub,
  fetchRepoBranchesViaGithub,
  pingGithubTunnel,
  githubInstallUrlFor,
  githubInstalled,
  installationReposViaGithub,
} from '../src/add-ons/github/api/github.js';

export default async function handler(req: any, res: any) {
  const action = String(req.query?.action ?? '');
  const method = req.method;

  switch (action) {
    case 'connect': {
      if (method !== 'POST') return methodNotAllowed(res);
      const body = parseBody(req);
      const r = await connectRepoViaGithub(body);
      return res.status(r.status).json(r);
    }
    case 'disconnect': {
      if (method !== 'POST') return methodNotAllowed(res);
      const body = parseBody(req);
      const r = await disconnectRepoViaGithub(body);
      return res.status(r.status).json(r);
    }
    case 'set-deploy-policy': {
      if (method !== 'POST') return methodNotAllowed(res);
      const body = parseBody(req);
      const r = await setDeployPolicyViaGithub(body);
      return res.status(r.status).json(r);
    }
    case 'repo-tree': {
      if (method !== 'GET') return methodNotAllowed(res);
      const q = req.query ?? {};
      const r = await fetchRepoTreeViaGithub({ repo_full_name: q.repo_full_name, ref: q.ref });
      // A repo tree at a given ref barely moves, and the Code tab refetches it on every mount.
      cacheable(res, r.ok, 60, 300);
      return res.status(r.status).json(r);
    }
    case 'repo-file': {
      if (method !== 'GET') return methodNotAllowed(res);
      const q = req.query ?? {};
      const r = await fetchRepoFileViaGithub({ repo_full_name: q.repo_full_name, path: q.path, ref: q.ref });
      // Same as the tree: file content at a ref is near-immutable; every click on the file
      // browser is a fresh call otherwise.
      cacheable(res, r.ok, 60, 300);
      return res.status(r.status).json(r);
    }
    case 'repo-branches': {
      if (method !== 'GET') return methodNotAllowed(res);
      const q = req.query ?? {};
      const r = await fetchRepoBranchesViaGithub({ repo_full_name: q.repo_full_name });
      // Branches DO move when the agent opens a fix PR, so keep this the shortest of the three —
      // swr still serves instantly while the edge refreshes underneath.
      cacheable(res, r.ok, 30, 120);
      return res.status(r.status).json(r);
    }
    case 'delete-feature-branch': {
      // Destructive, so unlike the cached reads above this one is authenticated:
      // the helper resolves the feature under the caller's JWT before deleting.
      if (method !== 'POST') return methodNotAllowed(res);
      const body = parseBody(req);
      const r = await deleteFeatureBranchViaGithub(req.headers?.authorization, {
        feature_id: body.feature_id,
      });
      return res.status(r.status).json(r);
    }
    // ── GitHub App install flow (user-scoped: never edge-cached) ──
    case 'install-url': {
      if (method !== 'GET') return methodNotAllowed(res);
      const r = await githubInstallUrlFor(req.headers?.authorization, { project_id: req.query?.project_id });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(r.status).json(r);
    }
    case 'installed': {
      // GitHub App Setup URL callback: bind the installation to the project in the signed state,
      // then send the user back to the GitHub tab (or the admin console for the platform project).
      if (method !== 'GET') return methodNotAllowed(res);
      const q = req.query ?? {};
      const r = await githubInstalled({ installation_id: q.installation_id, state: q.state, setup_action: q.setup_action });
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = 302;
      res.setHeader('Location', r.redirect);
      res.end();
      return;
    }
    case 'installation-repos': {
      if (method !== 'GET') return methodNotAllowed(res);
      const r = await installationReposViaGithub(req.headers?.authorization, { project_id: req.query?.project_id });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(r.status).json(r);
    }
    case 'health': {
      if (method !== 'GET') {
        res.status(405).json({ ok: false, reachable: false, error: 'method not allowed' });
        return;
      }
      const r = await pingGithubTunnel();
      // useGithubTunnel polls this every 15s from EVERY open tab, and the answer (is the tunnel
      // carrying traffic?) is global — identical for all users. 10s at the edge collapses that
      // whole fan-in to one origin probe per 10s without making the red-dot noticeably laggier.
      cacheable(res, r.ok, 10, 30);
      return res.status(r.status).json(r);
    }
    default:
      res.status(404).json({ ok: false, error: `unknown github action: ${action}` });
      return;
  }
}

function methodNotAllowed(res: any) {
  res.status(405).json({ ok: false, error: 'method not allowed' });
}

// Mark a read-only GET cacheable at Vercel's edge. `public` is only sound here because these
// responses carry NO user-specific data: they are keyed entirely by the query string (which the
// CDN includes in the cache key), and the handlers take no Authorization header — the repo reads
// are authorized on the nff-github side by "is this repo connected", not by who is asking. An
// error is never cached: a 502 from a briefly-down tunnel must not be pinned at the edge.
// `max-age=0` keeps the caching in the SHARED edge cache only: without it a `public` response
// with no explicit freshness is eligible for heuristic caching in the browser, which would pin
// a stale tree/health in one tab with no way to bust it.
function cacheable(res: any, ok: boolean, sMaxAge: number, swr: number) {
  if (!ok) {
    res.setHeader('Cache-Control', 'no-store');
    return;
  }
  res.setHeader(
    'Cache-Control',
    `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`,
  );
}

function parseBody(req: any): Record<string, unknown> {
  const b = req.body;
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { return {}; }
  }
  return b ?? {};
}
