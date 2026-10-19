// Hand-rolled SVG bar time series — no chart dependency, matching the
// dashboard's zero-chart-dep convention. ~31 daily points max.

import { useState } from 'react';

export interface SeriesPoint {
  label: string; // x label, e.g. "2026-06-10"
  value: number;
}

/** Round tick values (1/2/5 × 10ⁿ steps) covering [lo, hi]. Integer steps — all series are counts. */
function niceTicks(lo: number, hi: number, target = 4): number[] {
  if (hi <= lo) return [lo];
  const rawStep = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = Math.max(1, (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag);
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step / 1e6; t += step) ticks.push(t);
  return ticks;
}

/** Compact axis label — the full formatValue (with units) stays on hover/header. */
const tickLabel = (v: number) =>
  v >= 10_000 ? `${Math.round(v / 1000)}k` : v >= 1_000 ? `${(v / 1000).toFixed(1)}k` : String(v);

export function TimeSeriesChart({
  points,
  height = 160,
  color = 'var(--color-accent-green)',
  formatValue = (v: number) => String(v),
  autoScale = false,
}: {
  points: SeriesPoint[];
  height?: number;
  color?: string;
  formatValue?: (v: number) => string;
  /** Baseline = data min instead of 0, so small differences stay visible (header shows the min–max range). */
  autoScale?: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (points.length === 0) {
    return <div className="flex h-24 items-center justify-center text-xs text-faint">no data</div>;
  }

  const width = 640;
  const padX = 4;
  const padLeft = 46; // y-axis gutter for tick labels
  const padTop = 16;
  const padBottom = 18;
  const max = Math.max(...points.map((p) => p.value), autoScale ? Number.NEGATIVE_INFINITY : 1);
  const min = autoScale ? Math.min(...points.map((p) => p.value)) : 0;
  const span = max - min;
  const innerW = width - padLeft - padX;
  const innerH = height - padTop - padBottom;
  // Lifted baseline: keep a visible stub for the min-value bar so it doesn't vanish.
  const barFloor = autoScale ? 6 : 0;
  const colW = innerW / points.length;
  const barW = Math.max(2, colW - 2);
  const hoveredPoint = hovered !== null ? points[hovered] : null;

  // One shared value→pixel mapping for bars and gridlines, so lines land on bar tops.
  const fracOf = (v: number) => (autoScale ? (span === 0 ? 0.5 : (v - min) / span) : v / max);
  const yOf = (v: number) => padTop + innerH - (barFloor + fracOf(v) * (innerH - barFloor));
  const ticks = niceTicks(min, max);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img">
      {/* y-axis gridlines + tick labels, under the bars */}
      {ticks.map((t) => (
        <g key={`tick-${t}`}>
          <line
            x1={padLeft}
            x2={width - padX}
            y1={yOf(t)}
            y2={yOf(t)}
            stroke="var(--color-hairline)"
            strokeWidth={1}
          />
          <text
            x={padLeft - 4}
            y={yOf(t) + 3}
            fill="var(--color-faint)"
            fontSize="9"
            fontFamily="Arial, Helvetica, sans-serif"
            textAnchor="end"
          >
            {tickLabel(t)}
          </text>
        </g>
      ))}
      {points.map((p, i) => {
        const h = barFloor + fracOf(p.value) * (innerH - barFloor);
        const x = padLeft + colW * i + 1;
        const y = padTop + innerH - h;
        const isHovered = hovered === i;
        return (
          <g key={p.label}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={h}
              fill={color}
              opacity={hovered === null || isHovered ? 1 : 0.4}
            />
            {isHovered && (
              <rect x={x - 1} y={y} width={barW + 2} height={h} fill="none" stroke={color} strokeWidth={1.5} />
            )}
            {/* full-height, full-column hit target — the visible bar can be a couple px wide on 90-day series */}
            <rect
              x={padLeft + colW * i}
              y={padTop}
              width={colW}
              height={innerH}
              fill="transparent"
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            >
              <title>{`${p.label}: ${formatValue(p.value)}`}</title>
            </rect>
          </g>
        );
      })}
      <text x={padX} y={11} fill={hoveredPoint ? 'var(--color-ink)' : 'var(--color-muted)'} fontSize="10" fontFamily="Arial, Helvetica, sans-serif">
        {hoveredPoint
          ? `${hoveredPoint.label}: ${formatValue(hoveredPoint.value)}`
          : autoScale
            ? `${formatValue(min)} – ${formatValue(max)}`
            : `max ${formatValue(max)}`}
      </text>
      <text x={padLeft} y={height - 5} fill="var(--color-muted)" fontSize="10" fontFamily="Arial, Helvetica, sans-serif">
        {points[0].label}
      </text>
      <text x={width - padX} y={height - 5} fill="var(--color-muted)" fontSize="10" fontFamily="Arial, Helvetica, sans-serif" textAnchor="end">
        {points[points.length - 1].label}
      </text>
    </svg>
  );
}
