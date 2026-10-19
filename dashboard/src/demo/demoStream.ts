import type { ConsoleEntry } from '../components/squeletton/ConsolePanel';
import type { ChatMessage } from '../components/chat/ChatPanel';

/**
 * Scripted "agent at work" timeline for the public, no-login demo embed.
 *
 * No Supabase, no LLM — just a deterministic sequence the demo plays on a loop so
 * an embedded visitor always sees the agent diagnosing and patching a device. Each
 * step carries a `delay` (ms to wait *before* it appears) and either a console entry
 * or a chat message. `DemoApp` walks this list, then resets and replays.
 *
 * The target is "Device 03" (id 3) — the one mock device in a `warning`
 * state (see ../data/mockDevices). DemoApp flips it back to `online` when the patch
 * lands, so the fleet table visibly reacts.
 */

export type DemoStep =
  | { delay: number; chat: Omit<ChatMessage, 'timestamp'> }
  | { delay: number; console: Omit<ConsoleEntry, 'timestamp'> };

export const DEMO_TARGET_DEVICE_ID = '3';

export const demoScript: DemoStep[] = [
  { delay: 600,  chat:    { id: 'c1', role: 'user',  content: 'Device 03 is flapping. Take a look.' } },
  { delay: 900,  chat:    { id: 'c2', role: 'agent', content: 'On it. Pulling the last logs and the crash ring buffer from the device.' } },
  { delay: 700,  console: { id: 'k1', type: 'command', content: 'nff diagnose --device device-03' } },
  { delay: 800,  console: { id: 'k2', type: 'output',  content: 'fetching last 2000 log lines... done' } },
  { delay: 700,  console: { id: 'k3', type: 'output',  content: 'reading RTC ring buffer (pre-crash)... 64 lines' } },
  { delay: 900,  console: { id: 'k4', type: 'info',    content: 'anomaly: heap free falling 480KB -> 11KB over 30 min' } },
  { delay: 800,  chat:    { id: 'c3', role: 'agent', content: 'Heap is leaking before each reset. Looks like a buffer that never frees on the UART RX path.' } },
  { delay: 800,  console: { id: 'k5', type: 'command', content: 'nff trace --symbol uart_rx_handler' } },
  { delay: 900,  console: { id: 'k6', type: 'error',   content: 'leak: dma_buf alloc at uart.c:212 has no matching free on error path' } },
  { delay: 900,  chat:    { id: 'c4', role: 'agent', content: 'Root cause found: the DMA buffer leaks on the error branch. Writing the fix and a regression test.' } },
  { delay: 1000, console: { id: 'k7', type: 'edit',    content: 'nff edit firmware [src/uart.c] (+3 −1)' } },
  { delay: 800,  console: { id: 'k8', type: 'output',  content: 'compiling firmware 2.3.8 -> 2.3.9 ... ok (build_id 9f2a1c)' } },
  { delay: 900,  console: { id: 'k9', type: 'command', content: 'nff flash --ota device-03' } },
  { delay: 1100, console: { id: 'k10', type: 'output', content: 'OTA: downloading... verifying... installing... committed' } },
  { delay: 700,  console: { id: 'k11', type: 'info',   content: 'device rebooted on 2.3.9 — heap stable at 478KB' } },
  { delay: 900,  chat:    { id: 'c5', role: 'agent', content: 'Patched and flashed over the air. Device 03 is back online on 2.3.9, heap steady. No human in the loop.' } },
];

/** Total runtime of one pass, used to schedule the loop reset. */
export const demoScriptDuration = demoScript.reduce((sum, s) => sum + s.delay, 0);
