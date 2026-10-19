// Consolidated personal-account serverless function (prod). Vercel's Hobby plan caps a deployment
// at 12 Serverless Functions, so the account actions (export, delete) are folded into this single
// function dispatched on ?action=…. The pretty sub-paths /api/account/<action> are mapped here by
// explicit rewrites in vercel.json that run BEFORE the SPA catch-all — a plain function file (not a
// dynamic [action] route), because dynamic API routes are matched AFTER user rewrites and would be
// swallowed by /(.*) -> /. Local `npm run dev` is served by the equivalent Vite middleware in
// vite.config.ts.
//
// Both actions identify the caller from the Authorization bearer token and nothing else.
//
//   GET  /api/account/export      -> { ok, data } — everything RLS lets this user read
//   POST /api/account/delete      -> { ok } | 409 { ok:false, error, blocking_projects[] }
//
// The CLI auth surface is pooled here too (same function-cap reason; the VPS diagnosis
// service that used to serve /api/auth/* is no longer in prod DNS). vercel.json rewrites
// /api/auth/<action> to ?action=auth-<action>; contract matches nff/tools/auth.py.
//
//   POST /api/auth/login   {email, password} -> {access_token, refresh_token, token_type, expires_in}
//   POST /api/auth/refresh {refresh_token}   -> same shape
//   POST /api/auth/logout  (Bearer)          -> 204

import { exportUserData, deleteUserAccount } from './_account.js';
import { authLogin, authRefresh, authLogout } from './_auth.js';
import { brainSync } from './_brain.js';

export default async function handler(req: any, res: any) {
  const action = String(req.query?.action ?? '');
  const method = req.method;
  const authorization = req.headers?.authorization;

  switch (action) {
    case 'export': {
      if (method !== 'GET') return methodNotAllowed(res);
      const r = await exportUserData(authorization);
      if (!r.ok) return res.status(r.status).json(r);
      return res.status(200).json(r.data);
    }
    case 'delete': {
      if (method !== 'POST') return methodNotAllowed(res);
      const r = await deleteUserAccount(authorization);
      return res.status(r.status).json(r);
    }
    case 'auth-login': {
      if (method !== 'POST') return methodNotAllowed(res);
      const body = req.body ?? {};
      const r = await authLogin(body.email, body.password);
      if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
      return res.status(200).json(r.data);
    }
    case 'auth-refresh': {
      if (method !== 'POST') return methodNotAllowed(res);
      const body = req.body ?? {};
      const r = await authRefresh(body.refresh_token);
      if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
      return res.status(200).json(r.data);
    }
    case 'auth-logout': {
      if (method !== 'POST') return methodNotAllowed(res);
      const r = await authLogout(authorization);
      return res.status(r.status).end();
    }
    // Per-user brain sync for the nff-brain CLI/Chrome/VS Code clients. Like
    // auth-login above, these carry an opaque credential instead of a bearer —
    // here an x-brain-sync-token, resolved against brain_sync_tokens (0141).
    // A sync token is a personal-account artifact (minted on auth.uid() by
    // mint_brain_sync_token), which is why it lives in this dispatcher rather
    // than spending nff-app's last free Serverless Function slot.
    //
    // The token reaches exactly these two actions and no others: vercel.json
    // maps only the two literal sources /api/brain/ingest and /api/brain/ping.
    case 'brain-ingest': {
      if (method !== 'POST') return methodNotAllowed(res);
      const r = await brainSync(req.headers?.['x-brain-sync-token'], false, req.body ?? {});
      return res.status(r.status).json(r.body);
    }
    case 'brain-ping': {
      if (method !== 'GET') return methodNotAllowed(res);
      const r = await brainSync(req.headers?.['x-brain-sync-token'], true, {});
      return res.status(r.status).json(r.body);
    }
    default:
      res.status(404).json({ ok: false, error: `unknown account action: ${action}` });
      return;
  }
}

function methodNotAllowed(res: any) {
  res.status(405).json({ ok: false, error: 'method not allowed' });
}
