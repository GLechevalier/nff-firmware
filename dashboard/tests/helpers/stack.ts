import net from 'node:net';
import { test } from '@playwright/test';

// Local dev services the heavier tiers depend on. The dashboard SPA itself is started by
// Playwright's `webServer`; these are the back-end services the demo flows call through the
// Vite dev-api middleware. Bring them up with `npm run dev` at the repo root.
export const PORTS = {
  fleet: 3001, // nff-fleet (crash/ping commands over MQTT)
  ota: 3002, // nff-ota (held-firmware seed + deploy)
  mockController: 3004, // nff-mock controller (spawns mock devices)
  agentWorker: 8090, // nff-agent-worker (performs the actual code fix — spends tokens)
} as const;

// Tier B (`live`): spawn + crash kick-off. No agent, no token spend.
export const LIVE_PORTS = [PORTS.mockController, PORTS.fleet, PORTS.ota];
// Tier C (`live-heal`): adds the agent worker that actually heals.
export const HEAL_PORTS = [...LIVE_PORTS, PORTS.agentWorker];

function probe(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

export async function missingPorts(ports: number[]): Promise<number[]> {
  const results = await Promise.all(ports.map(async (p) => ({ p, up: await probe(p) })));
  return results.filter((r) => !r.up).map((r) => r.p);
}

// Call inside test.beforeAll: SKIPS the whole suite (not a failure) when the local stack
// isn't up. So a plain `npm run test:e2e` with nothing else running just reports Tier B/C
// as skipped instead of red.
export async function requireStack(ports: number[], label: string): Promise<void> {
  const missing = await missingPorts(ports);
  test.skip(
    missing.length > 0,
    `${label}: local stack not up (missing 127.0.0.1:${missing.join(', ')}). ` +
    'Start it with `npm run dev` at the repo root.',
  );
}

// Token guard for Tier C: the recovery assertions drive a real agent run, so require an
// explicit opt-in even when the full stack happens to be up.
export function requireHealOptIn(): void {
  test.skip(
    !process.env.RUN_HEAL,
    'recovery tests spend agent tokens — set RUN_HEAL=1 (or run `npm run test:e2e:heal`).',
  );
}
