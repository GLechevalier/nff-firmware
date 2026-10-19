import { createClient } from '@supabase/supabase-js';

// A stalled PostgREST/Auth request (server throttled, or a connection dropped mid-flight) never
// rejects on its own — it just hangs, leaving a hook's `loading` stuck true forever. That is the
// Agent console's "Loading… and can't send a message" prod symptom: the session fetch/insert hung,
// so currentSessionId never resolved and the composer silently no-op'd. Give every REST/Auth call a
// hard ceiling so a hang surfaces as a rejection the hooks already know how to handle. Realtime runs
// over a WebSocket (not this fetch), so subscriptions are unaffected.
const REQUEST_TIMEOUT_MS = 20_000;

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Supabase request timed out', 'TimeoutError')),
    REQUEST_TIMEOUT_MS,
  );

  // Respect a caller-supplied signal (supabase passes one for its own aborts) by chaining it to ours.
  const upstream = init?.signal;
  if (upstream) {
    if (upstream.aborted) controller.abort(upstream.reason);
    else upstream.addEventListener('abort', () => controller.abort(upstream.reason), { once: true });
  }

  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  { global: { fetch: fetchWithTimeout } },
);
