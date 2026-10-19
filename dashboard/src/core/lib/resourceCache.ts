// resourceCache — a module-level, path-keyed cache for the /api reads.
//
// WHY. App.tsx is a `useState<Tab>` switch with `{tab === 'x' && <XTab/>}`, so switching a tab
// UNMOUNTS the previous one and React garbage-collects its state. A sub-tabbed tab does the same one level
// down for its 7 sub-sections. Both fetch primitives held their data in component-local useState,
// so every tab switch threw the data away, showed "Loading…", and refetched from zero — a walk
// through a sub-nav re-requested the same list four times in a few seconds.
//
// Nothing else could catch those refetches: api/_lib/http.ts sets `private, no-store` on every
// response (deliberately — Vercel's CDN keys on URL, not Authorization, and serves from cache
// BEFORE the function runs, so an s-maxage would replay one admin's cross-tenant payload to any
// caller), which rules out the browser HTTP cache too. So the cache has to live here.
//
// This is deliberately NOT nff-dashboard's sharedResource.ts. That one exists to dedup concurrent
// Realtime channels; nff-admin has no realtime on tab data. This is the simpler cousin: cache that
// survives unmount + in-flight dedup + stale-while-revalidate.

import { useCallback, useSyncExternalStore } from 'react';

/** Sentinel a fetcher may resolve with to say "the server answered 304 — what you hold is
 *  current". Plain fetchers that always resolve data remain assignable unchanged. */
export const NOT_MODIFIED = Symbol('not-modified');

/** Cached value + request state. The object identity is STABLE and is only replaced when something
 *  actually changes — useSyncExternalStore's getSnapshot must never build a fresh object, or React
 *  re-renders forever. */
export interface ResourceSnapshot<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

interface Entry<T> {
  snapshot: ResourceSnapshot<T>;
  listeners: Set<() => void>;
  refs: number;
  inflight: Promise<void> | null;
  /** A refetch was asked for while one was already flying. The in-flight read may have hit the
   *  server before the caller's write landed, so we must run another one rather than dedupe it
   *  away — this is what makes `refresh()` after a mutation actually observe the mutation. */
  queued: boolean;
  seq: number;
  applied: number;
  fetchedAt: number;
  lastUsedAt: number;
  /** ETag of the last 200 for this key (apiGetCached stores it; a later fetch sends it as
   *  If-None-Match). Survives invalidation — a 304 only ever asserts "identical to what you
   *  hold", which is always safe. */
  etag: string | null;
  fetcher: () => Promise<T | typeof NOT_MODIFIED>;
}

const DEFAULT_STALE_MS = 30_000;
// Cached entries outlive their last subscriber — that is the entire point (a tab switch unmounts
// its component). Bound the memory with an LRU over the entries nobody is watching.
const MAX_IDLE_ENTRIES = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const entries = new Map<string, Entry<any>>();

const INERT: ResourceSnapshot<never> = { data: null, error: null, loading: true };
const NOOP = () => {};

function setSnapshot<T>(e: Entry<T>, next: ResourceSnapshot<T>) {
  e.snapshot = next;
  for (const l of e.listeners) l();
  schedulePersist();
}

function ensureEntry<T>(key: string, fetcher: () => Promise<T>): Entry<T> {
  let e = entries.get(key) as Entry<T> | undefined;
  if (!e) {
    e = {
      snapshot: { data: null, error: null, loading: true },
      listeners: new Set(),
      refs: 0,
      inflight: null,
      queued: false,
      seq: 0,
      applied: 0,
      fetchedAt: 0,
      lastUsedAt: Date.now(),
      etag: null,
      fetcher,
    };
    entries.set(key, e);
  } else {
    // The key IS the request path, so every caller's fetcher for a key is equivalent. Keep the
    // freshest closure.
    e.fetcher = fetcher;
  }
  return e;
}

function runFetch<T>(e: Entry<T>): Promise<void> {
  const seq = ++e.seq;
  const p = (async () => {
    try {
      const data = await e.fetcher();
      if (seq >= e.applied) {
        e.applied = seq;
        if (data === NOT_MODIFIED) {
          if (e.snapshot.data === null) {
            // An etag with no data to back it (shouldn't happen) — drop it and fetch for real.
            e.etag = null;
            e.queued = true;
          } else {
            e.fetchedAt = Date.now();
            // Only notify if the snapshot state actually changes — an unchanged poll tick
            // must not re-render every consumer.
            if (e.snapshot.loading || e.snapshot.error) {
              setSnapshot(e, { data: e.snapshot.data, error: null, loading: false });
            }
          }
        } else {
          e.fetchedAt = Date.now();
          setSnapshot(e, { data, error: null, loading: false });
        }
      }
    } catch (err) {
      if (seq >= e.applied) {
        e.applied = seq;
        e.fetchedAt = Date.now();
        // Keep any cached data on error — a failed revalidate must not blank a populated tab.
        setSnapshot(e, {
          data: e.snapshot.data,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        });
      }
    } finally {
      e.inflight = null;
      if (e.queued) { e.queued = false; void runFetch(e); }
    }
  })();
  e.inflight = p;
  return p;
}

/** Mount path: join an in-flight fetch, serve fresh cache, or revalidate a stale one.
 *  The in-flight join is also what absorbs StrictMode's double-mount in dev. */
function ensureFresh<T>(e: Entry<T>, staleMs: number): Promise<void> {
  if (e.inflight) return e.inflight;
  if (e.fetchedAt !== 0 && Date.now() - e.fetchedAt < staleMs) return Promise.resolve();
  return runFetch(e);
}

/** Guarantee a fetch that STARTS after this call, and resolve when it settles. This is what
 *  `refresh()` uses, so awaiting it right after a write really observes that write. */
function forceFetch<T>(e: Entry<T>): Promise<void> {
  if (!e.inflight) return runFetch(e);
  e.queued = true;
  return e.inflight.then(() => e.inflight ?? Promise.resolve());
}

function evictIdle() {
  const idle = [...entries.entries()].filter(([, e]) => e.refs === 0);
  if (idle.length <= MAX_IDLE_ENTRIES) return;
  idle
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
    .slice(0, idle.length - MAX_IDLE_ENTRIES)
    .forEach(([k]) => entries.delete(k));
}

// ─── module-level API ───────────────────────────────────────────────────────────────────────

/**
 * Drop every cached entry whose key starts with `prefix`, so the next read refetches.
 *
 * This is how a write stays honest: user-mutated rows must read back immediately after a write,
 * so a client cache evicts by prefix rather than by exact key.
 */
export function invalidatePrefix(prefix: string): void {
  for (const [k, e] of entries) {
    if (!k.startsWith(prefix)) continue;
    // Mark stale rather than delete, so a mounted view keeps rendering its rows while the fresh
    // ones land instead of flashing back to "Loading…".
    e.fetchedAt = 0;
    if (e.refs > 0) void forceFetch(e);
    else entries.delete(k);
  }
}

/** Drop everything — the "no user" case of setResourceCacheUser. */
export function resetResourceCache(): void {
  setResourceCacheUser(null);
}

/** The stored ETag for a key, if any — apiGetCached reads this to send If-None-Match. */
export function peekEtag(key: string): string | null {
  return entries.get(key)?.etag ?? null;
}

/** Record the ETag a 200 carried (no-op if the entry vanished meanwhile). */
export function storeEtag(key: string, etag: string | null): void {
  const e = entries.get(key);
  if (e) {
    e.etag = etag;
    schedulePersist();
  }
}

// ─── sessionStorage persistence ────────────────────────────────────────────────────────────
//
// Best-effort, per-tab, per-user: /api entries (data + etag) are mirrored into sessionStorage so
// a reload paints every tab instantly from last-known data, then revalidates — typically answered
// by a 304, so a reload costs ~a handful of empty conditional responses. Only `/api/` keys are
// eligible: they came from resp.json() and JSON-round-trip exactly, while `sb:*` supabase entries
// carry Date objects and stay memory-only. Errors are never persisted.

// Keyed by BUILD: the payload shape of any /api route can change with a deploy, and a hydrated
// entry paints BEFORE it revalidates — so a reload of a tab that cached last week's summary
// would render this week's dashboard against it (`data.toMessage.length` on an object without the
// field, 2026-09-08 prod crash). In prod import.meta.url is this chunk's hashed asset URL, which
// rotates on every build; in dev it is the source path (stable, fine).
const BUILD_ID = (import.meta.url.split('/').pop() ?? 'dev').replace(/\.[^.]+$/, '');
const STORAGE_ROOT = 'nff-admin.rc.';
const STORAGE_PREFIX = `${STORAGE_ROOT}v1.${BUILD_ID}.`;
const PERSIST_CAP_CHARS = 2_000_000; // ~4MB UTF-16, inside the usual 5MB quota
const PERSIST_DEBOUNCE_MS = 1_000;

let currentUserId: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const hasStorage = () => typeof sessionStorage !== 'undefined';

interface PersistedEntry {
  k: string;
  d: unknown;
  e: string | null;
  t: number;
}

function persistNow(): void {
  if (!currentUserId || !hasStorage()) return;
  const key = STORAGE_PREFIX + currentUserId;
  try {
    const eligible = [...entries.entries()]
      .filter(([k, e]) => k.startsWith('/api/') && e.snapshot.data !== null && e.snapshot.error === null)
      .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt);
    const items: string[] = [];
    let total = 0;
    for (const [k, e] of eligible) {
      let s: string;
      try {
        s = JSON.stringify({ k, d: e.snapshot.data, e: e.etag, t: e.lastUsedAt } satisfies PersistedEntry);
      } catch {
        continue; // non-serializable payload — skip it
      }
      if (total + s.length > PERSIST_CAP_CHARS) break; // oldest-used entries drop first
      total += s.length;
      items.push(s);
    }
    try {
      sessionStorage.setItem(key, '[' + items.join(',') + ']');
    } catch {
      // Quota — retry once with half the entries, then give up silently.
      try {
        sessionStorage.setItem(key, '[' + items.slice(0, Math.floor(items.length / 2)).join(',') + ']');
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

function schedulePersist(): void {
  if (!currentUserId || !hasStorage() || persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, PERSIST_DEBOUNCE_MS);
}

function hydrate(storageKey: string): void {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return;
    const items = JSON.parse(raw) as PersistedEntry[];
    if (!Array.isArray(items)) throw new Error('bad shape');
    for (const it of items) {
      if (typeof it?.k !== 'string' || it.d == null || entries.has(it.k)) continue;
      entries.set(it.k, {
        snapshot: { data: it.d, error: null, loading: false },
        listeners: new Set(),
        refs: 0,
        inflight: null,
        queued: false,
        seq: 0,
        applied: 0,
        // 0 = stale: the first subscriber revalidates immediately (ensureEntry swaps in the real
        // fetcher before ensureFresh can ever run this placeholder).
        fetchedAt: 0,
        lastUsedAt: typeof it.t === 'number' ? it.t : Date.now(),
        etag: typeof it.e === 'string' ? it.e : null,
        fetcher: () => Promise.reject(new Error('hydrated entry fetched before a consumer mounted')),
      });
    }
  } catch {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Point the cache (and its sessionStorage mirror) at a user. Call whenever auth resolves or
 * changes; same-user calls are no-ops. Clears the previous user's entries AND storage keys, so
 * signing in as a different admin in the same tab can never paint the previous admin's data.
 */
export function setResourceCacheUser(userId: string | null): void {
  if (userId === currentUserId) return;
  currentUserId = userId;
  entries.clear();
  if (!hasStorage()) return;
  try {
    const keep = userId ? STORAGE_PREFIX + userId : null;
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(STORAGE_ROOT) && k !== keep) sessionStorage.removeItem(k); // older builds' mirrors too
    }
  } catch {
    /* ignore */
  }
  if (userId) hydrate(STORAGE_PREFIX + userId);
}

// A debounced persist may be pending when the tab goes away — flush it.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistNow();
  });
}

/**
 * Edit a cached snapshot in place — for optimistic/targeted updates after a write, instead of
 * refetching the whole list. Deliberately does NOT touch fetchedAt: a local edit is not a
 * revalidation, so the normal staleness clock keeps running.
 */
export function mutateResource<T>(key: string, fn: (cur: T | null) => T | null): void {
  const e = entries.get(key) as Entry<T> | undefined;
  if (!e) return;
  setSnapshot(e, { data: fn(e.snapshot.data), error: e.snapshot.error, loading: false });
}

// ─── the hook ───────────────────────────────────────────────────────────────────────────────

/**
 * Subscribe to a cached resource. `key` is the request path (it already encodes the params, e.g.
 * `/api/users?days=30`), so it fully identifies the data.
 *
 * Returns the same `{ data, error, loading, refresh }` shape the old hooks did.
 */
export function useResource<T>(
  key: string,
  fetcher: () => Promise<T | typeof NOT_MODIFIED>,
  opts?: { staleMs?: number },
): ResourceSnapshot<T> & { refresh: () => Promise<void>; refreshIfStale: (maxAgeMs: number) => Promise<void> } {
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;

  // Idempotent, no I/O: getSnapshot runs during render, before subscribe, and needs an entry.
  ensureEntry(key, fetcher);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const e = entries.get(key);
      if (!e) return NOOP;
      e.listeners.add(onStoreChange);
      e.refs += 1;
      e.lastUsedAt = Date.now();
      void ensureFresh(e, staleMs);
      return () => {
        e.listeners.delete(onStoreChange);
        e.refs = Math.max(0, e.refs - 1);
        e.lastUsedAt = Date.now();
        // Data is DELIBERATELY kept when the last subscriber leaves — that is what makes coming
        // back to a tab instant.
        if (e.refs === 0) evictIdle();
      };
    },
    [key, staleMs],
  );

  // MUST return the stored object as-is. Never derive or allocate here.
  const getSnapshot = useCallback(
    (): ResourceSnapshot<T> => (entries.get(key)?.snapshot ?? INERT) as ResourceSnapshot<T>,
    [key],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback(async () => {
    const e = entries.get(key);
    if (e) await forceFetch(e);
  }, [key]);

  /** Poll-tick primitive: join in-flight, no-op if the entry is younger than maxAgeMs, else
   *  fetch. N consumers of one path with independent timers collapse to ~1 fetch per interval. */
  const refreshIfStale = useCallback(async (maxAgeMs: number) => {
    const e = entries.get(key);
    if (e) await ensureFresh(e, maxAgeMs);
  }, [key]);

  return { ...snapshot, refresh, refreshIfStale };
}
