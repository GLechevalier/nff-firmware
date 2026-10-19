/**
 * Deployment-state chip classes. The chip is bordered rather than filled: the
 * border carries the status hue as a graphic mark, the label stays on a
 * readable-on-white tier for legibility at 11px.
 *
 * Pair with a `border` class at the call site.
 */
export function stateChip(state: string): string {
  if (state === 'READY') return 'border-online text-emerald-600';
  if (state === 'ERROR') return 'border-error text-red-600';
  return 'border-warning text-amber-700';
}
