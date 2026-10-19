import { useTokenUsage } from '../../hooks/useTokenUsage';

const fmt = (n: number) => n.toLocaleString();

// Pinned readout of the current project's agent token spend today (UTC day),
// shown at the foot of the Current Task panel. When a display ceiling is set
// (VITE_AGENT_DAILY_TOKEN_CEILING) it adds a progress bar that shifts amber→red as
// the project nears its daily cap, mirroring the worker's soft limit.
export function AgentTokenUsage() {
  const { tokensToday, ceiling } = useTokenUsage();
  if (tokensToday === null) return null; // not loaded / no project

  const pct = ceiling ? Math.min(100, (tokensToday / ceiling) * 100) : null;
  const barColor =
    pct === null  ? '#000' :
    pct >= 100    ? '#ef4444' :
    pct >= 80     ? '#eab308' :
                    '#22c55e';

  return (
    <div style={{ flexShrink: 0, borderTop: '1px solid #000', padding: '5px 8px', fontSize: 11 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ color: '#555' }}>Tokens today</span>
        <span style={{ fontWeight: 'bold' }}>
          {fmt(tokensToday)}
          {ceiling && <span style={{ color: '#999', fontWeight: 'normal' }}> / {fmt(ceiling)}</span>}
        </span>
      </div>
      {pct !== null && (
        <div style={{ marginTop: 4, height: 4, background: '#eee', position: 'relative' }}>
          <div style={{ position: 'absolute', inset: 0, width: `${pct}%`, background: barColor }} />
        </div>
      )}
      {pct !== null && pct >= 100 && (
        <div style={{ marginTop: 3, color: '#ef4444' }}>Daily limit reached — resets 00:00 UTC</div>
      )}
    </div>
  );
}
