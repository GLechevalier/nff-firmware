// sharedResource — one fetch and one Realtime subscription per logical resource, shared by every
// consumer that asks for it.
//
// Why this exists: App.tsx renders all ~19 tabs at once and hides the inactive ones with
// `display:none`, so every hook every tab uses is mounted for the app's whole lifetime. With each
// hook owning its own useEffect, the same resource was fetched once PER CALL SITE — useDevices was
// mounted 9 times, so one device list cost ~18 round-trips (9 of them the reconcile *write*) and
// ~20 websocket channels, and every heartbeat re-triggered all nine. DeviceHealthContext.tsx says
// as much in a comment; it fixed the problem in exactly one place.
//
// This generalizes the pattern useRepoTree.ts already hand-rolled (a module-level Map + an explicit
// invalidate), and adds refcounting so the Realtime channel is torn down when nobody is looking.
//
// Consumers keep their existing hook signatures — a hook becomes a thin wrapper that supplies a key,
// a fetcher, and (optionally) a subscribe, and derives whatever per-consumer view it used to derive.

import { useCallback, useDebugValue, useSyncExternalStore } from 'react';

/** Cached data + request state. The object identity is STABLE and only replaced when something
 *  actually changes — useSyncExternalStore's getSnapshot must never build a fresh object or React
 *  re-renders forever. */
export interface ResourceSnapshot<T> {
  data: T | undefined;
  loading: boolean;
  error: string | null;
}

/** Handed to `subscribe` so a Realtime handler can either coarsely refetch or granularly patch.
 *  Both shapes exist in this codebase and both must survive the migration:
 *    • coarse   — useDevices/useCrashReports debounce-refetch on any change
 *    • granular — useOtaJobs/useGithubConnections patch rows straight from the payload */
export interface SubscribeCtx<T> {
  /** Debounced refetch (coalesces heartbeat bursts). The debounce now lives on the shared entry, so
   *  it coalesces once for all consumers instead of once per call site. */
  refetch: () => void;
  /** Undebounced refetch. */
  refetchNow: () => void;
  /** Patch the cached value in place. `prev` is the current cached data (undefined before first load). */
  mutate: (updater: (prev: T | undefined) => T | undefined) => void;
}

export interface ResourceDef<T> {
  fetcher: () => Promise<T>;
  /** Set up Realtime (or any live source). Returns a teardown fn. Called once when the resource
   *  gains its first consumer, torn down GRACE_MS after it loses its last. */
  subscribe?: (ctx: SubscribeCtx<T>) => () => void;
  /** Debounce for ctx.refetch. Defaults to 200ms. */
  debounceMs?: number;
  /** How long cached data is served without a background revalidate. Defaults to 30s. */
  staleMs?: number;
}

interface Entry<T> {
  snapshot: ResourceSnapshot<T>;
  listeners: Set<() => void>;
  refs: number;
  inflight: Promise<void> | null;
  /** A refetch was requested while one was already flying — the in-flight read may have hit the DB
   *  before that change landed, so we must run another one after it settles rather than dedupe it
   *  away. Without this, a realtime event arriving mid-fetch is silently dropped, and
   *  `await reload()` right after a write can resolve on a fetch that started before the write. */
  queued: boolean;
  /** Monotonic fetch id + the highest one whose result was applied, so a slow earlier response
   *  can't overwrite a newer one. */
  seq: number;
  applied: number;
  teardown: (() => void) | null;
  reapTimer: ReturnType<typeof setTimeout> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  lastFetchedAt: number;
  lastUsedAt: number;
  def: ResourceDef<T>;
}

// Tearing the Realtime channel down the instant refcount hits 0 is not an option: StrictMode
// (main.tsx) mounts → unmounts → remounts every effect, so refs go 1→0→1 within a tick and we would
// churn a websocket subscription on every mount. The grace timer absorbs that, and also makes a
// quick tab flip free.
const GRACE_MS = 30_000;
const DEFAULT_DEBOUNCE_MS = 200;
const DEFAULT_STALE_MS = 30_000;

// Cached entries are kept after their last consumer unmounts — that is what makes remounting the
// Usage/Billing tabs (the only two tabs that DO unmount) paint instantly, and what makes switching
// back to a previously-visited project instant despite AuthGate remounting the whole app on switch.
// Bound the memory with an LRU over the idle entries.
const MAX_IDLE_ENTRIES = 50;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const entries = new Map<string, Entry<any>>();

const INERT: ResourceSnapshot<never> = { data: undefined, loading: true, error: null };
const NOOP = () => {};

function notify<T>(e: Entry<T>) {
  for (const l of e.listeners) l();
}

/** Replace the snapshot object (new identity) and wake subscribers. */
function setSnapshot<T>(e: Entry<T>, next: ResourceSnapshot<T>) {
  e.snapshot = next;
  notify(e);
}

function ensureEntry<T>(key: string, def: ResourceDef<T>): Entry<T> {
  let e = entries.get(key) as Entry<T> | undefined;
  if (!e) {
    e = {
      snapshot: { data: undefined, loading: true, error: null },
      listeners: new Set(),
      refs: 0,
      inflight: null,
      queued: false,
      seq: 0,
      applied: 0,
      teardown: null,
      reapTimer: null,
      debounceTimer: null,
      lastFetchedAt: 0,
      lastUsedAt: Date.now(),
      def,
    };
    entries.set(key, e);
  } else {
    // The key identifies the data, so every consumer's fetcher for that key is equivalent. Keep the
    // newest one so its closure sees the latest props/context rather than whichever component
    // happened to mount first.
    e.def = def;
  }
  return e;
}

function runFetch<T>(e: Entry<T>): Promise<void> {
  const seq = ++e.seq;
  const p = (async () => {
    try {
      const data = await e.def.fetcher();
      if (seq >= e.applied) {
        e.applied = seq;
        e.lastFetchedAt = Date.now();
        setSnapshot(e, { data, loading: false, error: null });
      }
    } catch (err) {
      if (seq >= e.applied) {
        e.applied = seq;
        e.lastFetchedAt = Date.now();
        // Keep any previously cached data on error — a failed revalidate should not blank the UI.
        setSnapshot(e, {
          data: e.snapshot.data,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
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

/** Activation path — joins an in-flight fetch rather than starting another. THE dedup: the 9
 *  useDevices instances mount in the same tick; the first starts the fetch, the other 8 join it. */
function ensureFresh<T>(e: Entry<T>): Promise<void> {
  if (e.inflight) return e.inflight;
  const staleMs = e.def.staleMs ?? DEFAULT_STALE_MS;
  if (e.lastFetchedAt !== 0 && Date.now() - e.lastFetchedAt < staleMs) return Promise.resolve();
  if (e.snapshot.data === undefined && !e.snapshot.loading) {
    setSnapshot(e, { ...e.snapshot, loading: true });
  }
  return runFetch(e);
}

/** Realtime / manual path — guarantee a fetch that STARTS after this call, so awaiting it really
 *  observes a write the caller just made. */
function forceFetch<T>(e: Entry<T>): Promise<void> {
  if (!e.inflight) return runFetch(e);
  // A fetch is flying, but it may have read the DB before this change landed. Queue a follow-up and
  // resolve only once THAT one settles (runFetch's `finally` kicks it before `p` resolves, so
  // e.inflight is already the follow-up by the time this `.then` runs).
  e.queued = true;
  return e.inflight.then(() => e.inflight ?? Promise.resolve());
}

function makeCtx<T>(key: string): SubscribeCtx<T> {
  const get = () => entries.get(key) as Entry<T> | undefined;
  return {
    refetch: () => {
      const e = get();
      if (!e) return;
      if (e.debounceTimer) clearTimeout(e.debounceTimer);
      e.debounceTimer = setTimeout(() => {
        e.debounceTimer = null;
        void forceFetch(e);
      }, e.def.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    },
    refetchNow: () => { const e = get(); if (e) void forceFetch(e); },
    mutate: updater => { mutateEntry(key, updater); },
  };
}

function evictIdle() {
  const idle = [...entries.entries()].filter(([, e]) => e.refs === 0 && !e.teardown);
  if (idle.length <= MAX_IDLE_ENTRIES) return;
  idle
    .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
    .slice(0, idle.length - MAX_IDLE_ENTRIES)
    .forEach(([k, e]) => {
      if (e.reapTimer) clearTimeout(e.reapTimer);
      if (e.debounceTimer) clearTimeout(e.debounceTimer);
      entries.delete(k);
    });
}

function scheduleReap(key: string) {
  const e = entries.get(key);
  if (!e || e.refs > 0 || e.reapTimer) return;
  e.reapTimer = setTimeout(() => {
    const cur = entries.get(key);
    if (!cur) return;
    cur.reapTimer = null;
    if (cur.refs > 0) return; // someone remounted inside the grace window
    // Drop the live subscription but KEEP the cached data, so a remount paints from cache.
    cur.teardown?.();
    cur.teardown = null;
    if (cur.debounceTimer) { clearTimeout(cur.debounceTimer); cur.debounceTimer = null; }
    evictIdle();
  }, GRACE_MS);
}

// ─── module-level API (usable outside React) ────────────────────────────────────────────────

const NO_ROLLBACK = () => {};

function mutateEntry<T>(key: string, updater: (prev: T | undefined) => T | undefined): () => void {
  const e = entries.get(key) as Entry<T> | undefined;
  if (!e) return NO_ROLLBACK;
  const prev = e.snapshot.data;
  const next = updater(prev);
  if (next === prev) return NO_ROLLBACK; // no identity change → no notify, no re-render
  setSnapshot(e, { ...e.snapshot, data: next });

  return () => {
    const cur = entries.get(key) as Entry<T> | undefined;
    if (!cur) return;
    // Only undo if OUR optimistic value is still the head of the cache. If a realtime refetch has
    // already landed on top of it, restoring the pre-mutation snapshot would resurrect stale rows —
    // revalidate instead. (The pre-migration code rolled back unconditionally and had this race.)
    if (cur.snapshot.data === next) setSnapshot(cur, { ...cur.snapshot, data: prev });
    else void forceFetch(cur);
  };
}

/** Optimistically patch a resource's cached value. Returns a rollback — the
 *  optimistic-update-then-rollback shape the device mutations already use. */
export function mutate<T>(key: string, updater: (prev: T | undefined) => T | undefined): () => void {
  return mutateEntry(key, updater);
}

/** Read the currently cached value without subscribing. For a fetcher that must fold new data into
 *  state the realtime layer owns (useCodeStream's live broadcast sessions would otherwise be wiped
 *  by a revalidate). */
export function peek<T>(key: string): T | undefined {
  return (entries.get(key) as Entry<T> | undefined)?.snapshot.data;
}

/** Force a refetch that starts after this call, and resolve when it settles. Safe to `await` right
 *  after a write: it will observe that write. */
export function refetch(key: string): Promise<void> {
  const e = entries.get(key);
  return e ? forceFetch(e) : Promise.resolve();
}

/** Mark stale; refetch immediately if anyone is watching. */
export function invalidate(key: string): void {
  const e = entries.get(key);
  if (!e) return;
  e.lastFetchedAt = 0;
  if (e.refs > 0) void forceFetch(e);
}

/** Side-caches that must be dropped alongside the store (e.g. the reconcile throttle). */
const resetHooks: Array<() => void> = [];
export function onSharedResourceReset(fn: () => void): void { resetHooks.push(fn); }

/**
 * Drop EVERYTHING. Must run on sign-out / user change.
 *
 * This store is module state: it outlives the React tree. AuthGate unmounts App on sign-out, but the
 * module is never re-evaluated — so without this, a second user signing in *in the same tab* would
 * render the first user's cached fleet, crashes and repos for a beat before revalidation. RLS does
 * not save us here: this is a client-side cache, not a query.
 */
export function resetSharedResources(): void {
  for (const [, e] of entries) {
    e.teardown?.();
    if (e.reapTimer) clearTimeout(e.reapTimer);
    if (e.debounceTimer) clearTimeout(e.debounceTimer);
    e.listeners.clear();
  }
  entries.clear();
  for (const fn of resetHooks) fn();
}

// ─── the hook ───────────────────────────────────────────────────────────────────────────────

/**
 * Subscribe to a shared resource. `key` must fully identify the data (include the project id —
 * every hook here is tenant-scoped). Pass `null` to opt out (e.g. before the project resolves);
 * you get a stable "still loading" snapshot and nothing is fetched.
 */
export function useSharedResource<T>(key: string | null, def: ResourceDef<T>): ResourceSnapshot<T> {
  // Create/refresh the entry during render so getSnapshot (which React calls before subscribe) has
  // something to read. Idempotent: it only allocates on first sight of the key.
  if (key) ensureEntry(key, def);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!key) return NOOP;
      const e = entries.get(key)!;

      e.listeners.add(onStoreChange);
      e.refs += 1;
      e.lastUsedAt = Date.now();
      if (e.reapTimer) { clearTimeout(e.reapTimer); e.reapTimer = null; }

      // First consumer opens the live subscription; the rest ride it.
      const wasCold = !e.teardown && !!e.def.subscribe;
      if (wasCold) {
        e.teardown = e.def.subscribe!(makeCtx<T>(key));
      }

      if (wasCold && e.lastFetchedAt !== 0) {
        // The channel had been reaped, so we were deaf to changes for a while and cannot reason
        // about staleness — revalidate unconditionally. (Cached data still paints immediately; this
        // only refreshes it behind the scenes.)
        void forceFetch(e);
      } else {
        // Never fetched → fetch. Fresh → serve cache (this is what makes a remount instant).
        // Stale → revalidate in the background while still showing the cached data.
        void ensureFresh(e);
      }

      return () => {
        e.listeners.delete(onStoreChange);
        e.refs -= 1;
        e.lastUsedAt = Date.now();
        if (e.refs <= 0) {
          e.refs = 0;
          scheduleReap(key);
        }
      };
    },
    [key],
  );

  const getSnapshot = useCallback((): ResourceSnapshot<T> => {
    if (!key) return INERT;
    // Stable identity — set by setSnapshot, never constructed here.
    return (entries.get(key)?.snapshot ?? INERT) as ResourceSnapshot<T>;
  }, [key]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useDebugValue(key);
  return snapshot;
}
