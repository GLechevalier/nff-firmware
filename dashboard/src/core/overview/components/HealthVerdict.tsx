import { useServiceStatus, SERVICES, CRITICAL_SERVICES } from '../../hooks/useServiceStatus';

// The tri-state health verdict (Everything Healthy / N down, not critical /
// N down, critical!) — collapsed from the old per-service tile grid; per-service
// detail is on the Containers tab. Moved verbatim out of OverviewTab so recoded
// overviews (nff-admin's store) can compose it independently.
export function HealthVerdict({ onJumpToContainers }: { onJumpToContainers: () => void }) {
  const { getState } = useServiceStatus(); // Realtime — faster than the 15s poll

  // Not memoized: useServiceStatus hands back a fresh getState on every store
  // tick, which is exactly when this has to be recomputed anyway.
  const down = SERVICES.map((s) => ({ service: s, ...getState(s) })).filter((s) => s.state !== 'online');
  const criticalDown = down.some((s) => CRITICAL_SERVICES.includes(s.service));
  const verdict =
    down.length === 0
      ? 'Everything Healthy'
      : `${down.length} service${down.length === 1 ? '' : 's'} down, ${criticalDown ? 'critical!' : 'not critical'}`;
  const verdictTone = down.length === 0 ? 'text-emerald-600' : criticalDown ? 'text-red-600' : 'text-amber-700';
  const verdictDot = down.length === 0 ? 'bg-online' : criticalDown ? 'bg-error' : 'bg-amber-400';

  return down.length === 0 ? (
    <section className="flex items-center gap-2 border border-ink bg-paper px-4 py-2 shadow-card">
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${verdictDot}`} />
      <p className={`text-sm font-bold ${verdictTone}`}>{verdict}</p>
    </section>
  ) : (
    <button
      onClick={onJumpToContainers}
      title="See which services are down on the Containers tab"
      className="flex items-center gap-2 border border-ink bg-paper px-4 py-2 text-left shadow-card hover:bg-elevated"
    >
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${verdictDot}`} />
      <p className={`text-sm font-bold ${verdictTone}`}>{verdict}</p>
    </button>
  );
}
