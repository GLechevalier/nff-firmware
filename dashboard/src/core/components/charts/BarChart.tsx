// Horizontal per-category bars (e.g. tokens or cost per model). SVG, no deps.

import { useState } from 'react';

export interface BarDatum {
  label: string;
  value: number;
}

export function BarChart({
  data,
  color = 'var(--color-accent-blue)',
  formatValue = (v: number) => String(v),
}: {
  data: BarDatum[];
  color?: string;
  formatValue?: (v: number) => string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (data.length === 0) {
    return <div className="flex h-16 items-center justify-center text-xs text-faint">no data</div>;
  }

  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="space-y-1.5">
      {data.map((d, i) => {
        const isHovered = hovered === i;
        return (
          <div
            key={d.label}
            className="-mx-1 flex items-center gap-2 rounded px-1 py-0.5 transition-colors"
            style={{ backgroundColor: isHovered ? 'var(--color-track)' : 'transparent' }}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            <span className={`w-24 sm:w-44 truncate text-right text-[11px] ${isHovered ? 'text-ink' : 'text-muted'}`}>{d.label}</span>
            <div className="h-3.5 flex-1 bg-track">
              <div
                className="h-full transition-opacity"
                style={{ width: `${(d.value / max) * 100}%`, backgroundColor: color, opacity: hovered === null || isHovered ? 1 : 0.5 }}
              />
            </div>
            <span className={`w-14 sm:w-24 text-[11px] ${isHovered ? 'text-ink' : 'text-muted'}`}>{formatValue(d.value)}</span>
          </div>
        );
      })}
    </div>
  );
}
