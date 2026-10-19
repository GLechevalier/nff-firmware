export function AgentBadge({ connected }: { connected: boolean }) {
  return connected ? <span>yes</span> : <span>—</span>;
}
