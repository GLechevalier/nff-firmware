// pump.ts — throttle-proof scheduler for the WiredLink timers.
//
// Chrome's background-tab intensive throttling clamps MAIN-THREAD timers to one wake-up per
// minute, which starves exactly the link's recovery machinery: the 250 ms TCP RTO scan
// (tcp.ts), the 500 ms LCP/IPCP Conf-Req resend (cp.ts), and the readLoop re-acquire backoff
// (index.ts). Dedicated-worker timers are not throttled, so pump.worker.ts posts a 50 ms tick
// and this module runs a deadline-based scheduler off it: link code asks linkScheduler for
// intervals/timeouts instead of setInterval/setTimeout and keeps firing at full cadence while
// the tab is backgrounded. Everything stays on the main thread except the tick source.
//
// The worker exists only while a link does (acquirePump/releasePump, refcounted). If Worker
// construction fails (CSP, exotic browser), a main-thread interval takes over — behavior then
// degrades exactly to the pre-worker world, never below it.

const TICK_MS = 50;   // finest cadence any link timer needs (readLoop backoff)

interface Entry {
  deadline: number;
  periodMs: number | null;   // null = one-shot
  fn: () => void;
}

class Scheduler {
  private entries = new Set<Entry>();

  /** Run fn every periodMs until the returned cancel fn is called. */
  every(periodMs: number, fn: () => void): () => void {
    const e: Entry = { deadline: performance.now() + periodMs, periodMs, fn };
    this.entries.add(e);
    return () => this.entries.delete(e);
  }

  /** Run fn once after delayMs unless the returned cancel fn is called first. */
  after(delayMs: number, fn: () => void): () => void {
    const e: Entry = { deadline: performance.now() + delayMs, periodMs: null, fn };
    this.entries.add(e);
    return () => this.entries.delete(e);
  }

  /** Tick-driven sleep — resolves on the first tick past the deadline. */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { this.after(ms, resolve); });
  }

  tick(): void {
    const now = performance.now();
    for (const e of [...this.entries]) {
      if (now < e.deadline) continue;
      if (e.periodMs === null) this.entries.delete(e);
      else e.deadline = now + e.periodMs;   // deadline from NOW: no burst catch-up after a stall
      try { e.fn(); } catch { /* one timer's throw must not starve the rest */ }
    }
  }
}

export const linkScheduler = new Scheduler();

let worker: Worker | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let refs = 0;

/** Start the tick source (first caller) / bump the refcount. Pair every call with releasePump. */
export function acquirePump(): void {
  refs++;
  if (refs > 1) return;
  try {
    worker = new Worker(new URL('./pump.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = () => linkScheduler.tick();
    worker.postMessage({ cmd: 'start', intervalMs: TICK_MS });
  } catch {
    worker = null;
    fallbackTimer = setInterval(() => linkScheduler.tick(), TICK_MS);
  }
}

export function releasePump(): void {
  if (refs === 0) return;
  refs--;
  if (refs > 0) return;
  if (worker) { worker.postMessage({ cmd: 'stop' }); worker.terminate(); worker = null; }
  if (fallbackTimer !== null) { clearInterval(fallbackTimer); fallbackTimer = null; }
}

// HMR: a disposed module instance must not leave a ticking worker behind (the replacing instance
// starts its own on the next acquire).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    worker?.terminate();
    worker = null;
    if (fallbackTimer !== null) { clearInterval(fallbackTimer); fallbackTimer = null; }
    refs = 0;
  });
}
