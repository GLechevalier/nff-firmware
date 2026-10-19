import { supabase } from './supabase';
import { invalidatePrefix, peekEtag, storeEtag, NOT_MODIFIED } from './resourceCache';

// When another app hosts this UI (nff-dashboard) it proxies our /api under a
// prefix (e.g. /admin-api) so requests reach the admin deployment without
// CORS. Standalone: unset → ''. Cache/ETag keys stay on the unprefixed path.
const BASE = (import.meta.env.VITE_ADMIN_API_BASE as string | undefined) ?? '';

// The workspace this client acts on, for the per-workspace add-on routes. Set by
// nff-app (AuthGate.tsx) from useCurrentProject(); left null for
// standalone nff-admin, which has no notion of "current project" — the server
// then defaults to its own vendor workspace (api/_lib/auth.ts's
// requireProjectMember), unchanged from today's single-tenant behavior.
let apiProjectId: string | null = null;

export function setApiProjectId(id: string | null): void {
  apiProjectId = id;
}

/**
 * The workspace this client is acting on, for the few places that need it
 * OUTSIDE a React tree (nff-app's brain source fetches a portal snapshot from a
 * plain function, not a hook). Null under standalone nff-admin, which has no
 * notion of a current project.
 */
export function getApiProjectId(): string | null {
  return apiProjectId;
}

function projectHeader(): Record<string, string> {
  return apiProjectId ? { 'X-Project-Id': apiProjectId } : {};
}

/** The cache prefix a write invalidates: its own path, query string dropped. */
function invalidationPrefix(path: string): string {
  return path.split('?')[0];
}

/** Authenticated fetch against this app's /api functions. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('not signed in');

  const resp = await fetch(BASE + path, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
      ...projectHeader(),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `request failed (${resp.status})`);
  }
  // The /api functions only exist under `vercel dev` (npm run dev:full). Under a
  // plain `vite` dev server (npm run dev) the route resolves to the transpiled TS
  // source instead, so guard against a non-JSON 200 with a clear message rather
  // than a cryptic "Unexpected token 'i'" from resp.json().
  const contentType = resp.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(
      `${path} did not return JSON — the API functions aren't running. ` +
        'Start the app with `npm run dev:full` (vercel dev), not `npm run dev`.',
    );
  }
  return resp.json() as Promise<T>;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

/**
 * Conditional GET for resourceCache fetchers: sends If-None-Match when the cache holds an etag
 * for `path` (the cache key IS the request path), resolves NOT_MODIFIED on a 304, and records the
 * fresh etag on a 200. Raw apiGet call sites never send a validator and never see a 304.
 */
export async function apiGetCached<T>(path: string): Promise<T | typeof NOT_MODIFIED> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('not signed in');

  const etag = peekEtag(path);
  const resp = await fetch(BASE + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...projectHeader(),
      ...(etag ? { 'If-None-Match': etag } : {}),
    },
  });
  // Before the !ok check — fetch surfaces the 304 to JS (no-store keeps the browser
  // cache from swallowing it) and resp.ok is false for 304.
  if (resp.status === 304) return NOT_MODIFIED;
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `request failed (${resp.status})`);
  }
  const contentType = resp.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(
      `${path} did not return JSON — the API functions aren't running. ` +
        'Start the app with `npm run dev:full` (vercel dev), not `npm run dev`.',
    );
  }
  storeEtag(path, resp.headers.get('ETag'));
  return resp.json() as Promise<T>;
}

/** Run a mutation, then drop the cached reads it could have invalidated. */
async function mutating<T>(path: string, init: RequestInit): Promise<T> {
  const result = await request<T>(path, init);
  invalidatePrefix(invalidationPrefix(path));
  return result;
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return mutating<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return mutating<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

/** DELETE takes an optional body — a bulk delete passes `{ ids }`. */
export function apiDelete<T>(path: string, body?: unknown): Promise<T> {
  return mutating<T>(path, {
    method: 'DELETE',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
