// pump.worker.ts — the WiredLink tick source. A dedicated worker's timers are NOT subject to
// Chrome's background-tab throttling (which clamps main-thread timers to 1/min after ~5 min
// backgrounded), so this worker posts a steady tick that pump.ts uses to drive every link timer
// (TCP RTO scans, LCP/IPCP resends, readLoop backoff). The data path itself (reader.read()
// promises, WebSocket messages) is never throttled — only the timer-driven recovery machinery
// was, and it rides these ticks now. Deliberately zero imports and zero state beyond the interval.

let timer: ReturnType<typeof setInterval> | null = null;

self.onmessage = (e: MessageEvent<{ cmd: 'start'; intervalMs: number } | { cmd: 'stop' }>) => {
  if (timer !== null) { clearInterval(timer); timer = null; }
  if (e.data.cmd === 'start') {
    timer = setInterval(() => self.postMessage({ type: 'tick' }), e.data.intervalMs);
  }
};
