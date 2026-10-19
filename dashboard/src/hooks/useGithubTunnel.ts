import { useEffect, useState } from 'react';

// Polls /api/github/health, which probes nff-github THROUGH its public tunnel
// (NFF_GITHUB_INTERNAL_URL). nff-github heartbeats into Supabase from inside its
// box, so that beat stays fresh even when the tunnel fronting it is down — and the
// tunnel is the only path the dashboard has to reach it. The Management graph ANDs
// this with the heartbeat so nff-github reads green only when online AND reachable.
const POLL_MS = 15_000;

export function useGithubTunnel() {
  // undefined while the first probe is in flight (treated as "not yet healthy").
  const [tunnelOnline, setTunnelOnline] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      try {
        const resp = await fetch('/api/github/health', { method: 'GET' });
        const data = (await resp.json()) as { reachable?: boolean };
        if (!cancelled) setTunnelOnline(!!data?.reachable);
      } catch {
        if (!cancelled) setTunnelOnline(false);
      }
    }

    probe();
    const timer = setInterval(probe, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { tunnelOnline: tunnelOnline === true };
}
