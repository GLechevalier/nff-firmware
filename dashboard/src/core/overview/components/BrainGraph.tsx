import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties } from 'react';
import type { BrainNode, BrainEdge, Category } from '@nff-brain/core/types';
import { spaceOutNodes, type Pt } from '@nff-brain/core/layout';
import { buildSpine } from '@nff-brain/core/spine';
import { buildDensityClusters, DEFAULT_DENSITY_SCREEN_RADIUS, MERGE_SCREEN_SLACK } from '@nff-brain/core/density';
import type { GlowInfo } from '../hooks/useBrainGlow';
import { usePanZoom, type FitBox } from '../../hooks/usePanZoom';
import { TAB_GROUP_ICONS } from '../../lib/tabIcons';
import { BRAIN_TOOL_CATALOG } from '../lib/toolCatalog';
import { offNodeIds } from '../lib/offNodes';
import { subscribePermissions, permissionsVersion, permissionEnabled } from '../../lib/permissionsStore';
import { BRAND_ICONS, type BrandIconProps } from '../../components/BrandIcons';
import type { LucideIcon } from 'lucide-react';

// The brain knowledge-graph renderer — port of nff-dashboard's BrainGraph with
// the palette repointed to the admin's paper(#fff)/ink(#000) theme via
// the theme's CSS variables (same technique as charts/TimeSeriesChart). Pure
// SVG; node x/y are board coordinates. A minimum-spacing pass keeps overlapping
// nodes readable, and the canvas is grab-to-pan / scroll-to-zoom. The parent
// owns selection and hover state so it can pair the graph with a document
// panel, and can call `resetView()` (the Fit button) via a ref.
//
// The graph model and the spacing pass come from @nff-brain/core, which is
// where they are maintained; this file used to carry hand-synced copies of both
// (src/lib/brainTypes.ts and src/lib/brainSpacing.ts, themselves ports of
// nff-dashboard's). Only the rendering is local.

// Keyed by core's Category, which has seven members — the admin's own brain only
// ever produces the first four (the brain_nodes CHECK constraint), but the type
// must be total. Glyphs match nff-brain's VS Code webview so a memory reads the
// same in both surfaces. '·' rather than a blank square if the two ever drift.
const CATEGORY_ICON: Record<Category, string> = {
  core: '◈',
  analysis: '⊕',
  rules: '▦',
  strategy: '↑',
  decision: '⌘',
  preference: '☺',
  task: '☐',
};

// A synced tab-master node (see api/_lib/brain.ts's syncDatabase) reuses the exact
// icon Sidebar.tsx shows for that tab, via the same TAB_GROUP_ICONS lookup, instead
// of the category glyph.
interface SourceRef {
  kind?: string;
  tab?: string;
  tool?: string;
}

function tabIconFor(sourceRef: unknown): LucideIcon | null {
  const ref = sourceRef as SourceRef | null | undefined;
  if (!ref || typeof ref !== 'object') return null;
  if (ref.kind === 'tab' && ref.tab) return TAB_GROUP_ICONS[ref.tab] ?? null;
  return null;
}

// A synced tool-master node (see api/_lib/brain.ts's syncDatabase) reuses the
// exact brand logo Settings → Permissions shows for that tool, via
// BrandIcons.tsx's id-keyed BRAND_ICONS — same mechanism as tabIconFor above,
// just a different lookup table.
function toolIconFor(sourceRef: unknown): ComponentType<BrandIconProps> | null {
  const ref = sourceRef as SourceRef | null | undefined;
  if (!ref || typeof ref !== 'object' || ref.kind !== 'tool' || !ref.tool) return null;
  return BRAND_ICONS[ref.tool] ?? null;
}

const TOOL_PERMISSION_KEYS: Record<string, string[]> = Object.fromEntries(
  BRAIN_TOOL_CATALOG.map(t => [t.id, t.permissionKeys]),
);
const TOOL_STORE_KEY: Record<string, string | undefined> = Object.fromEntries(
  BRAIN_TOOL_CATALOG.map(t => [t.id, t.storeKey]),
);

// Dim-when-off (per the "show every tool always" call): a tool node stays on
// the graph even when every permission behind it is disabled, or its add-on is
// switched off in Settings → Store, just faded — same DIMMED_OPACITY the
// search-match dimming already uses below. A tab master dims the same way when
// its tab is off in the Store, and the dimming cascades to every node reachable
// ONLY through dimmed masters (offNodeIds): a node hanging off a switched-off
// master fades with it; one also linked to a live worker node stays lit.
function toolDisabled(toolId: string, hiddenKeys: readonly string[]): boolean {
  const storeKey = TOOL_STORE_KEY[toolId];
  if (storeKey && hiddenKeys.includes(storeKey)) return true;
  const keys = TOOL_PERMISSION_KEYS[toolId];
  if (!keys) return false;
  return !keys.some(k => permissionEnabled(k));
}

/**
 * Is this master switched off — its tab hidden in the Store, its tool's Store
 * row hidden / every permission off?
 * The seed of the off cascade below; exported so BrainCard can key its
 * "something is folded" hint on the same predicate.
 */
export function isOffMaster(n: { sourceRef?: unknown }, hiddenKeys: readonly string[]): boolean {
  const ref = n.sourceRef as SourceRef | null | undefined;
  return ref?.kind === 'tab' ? !!ref.tab && hiddenKeys.includes(ref.tab)
    : ref?.kind === 'tool' ? !!ref.tool && toolDisabled(ref.tool, hiddenKeys)
    : false;
}

/**
 * Everything folded by the Store: the off masters plus what only they reach
 * (offNodes.ts). Shared with BrainCard, whose hover reveal climbs this set.
 */
export function offMasterIds(
  nodes: readonly { id: string; sourceRef?: unknown; kind?: 'hub' | 'portal'; employeeId?: string }[],
  edges: readonly { from: string; to: string }[],
  hiddenKeys: readonly string[],
  coreId: string | null,
): Set<string> {
  const seeds = new Set<string>();
  const anchors = new Set<string>();
  if (coreId) anchors.add(coreId);
  for (const n of nodes) {
    const ref = n.sourceRef as SourceRef | null | undefined;
    if (isOffMaster(n, hiddenKeys)) seeds.add(n.id);
    else if (ref?.kind === 'tab' || ref?.kind === 'tool' || isEmployeeNode(n)) anchors.add(n.id);
  }
  return offNodeIds(nodes, edges, seeds, anchors);
}

// The brand mark's rendered box on a tool node, as a fraction of the node's
// own (radius) size — derived, not a fixed px constant, so a tool node's icon
// scales together with its circle instead of drifting out of proportion the
// next time the node itself is resized.
const TOOL_ICON_SIZE_RATIO = 1.0125;

// Same idea for a tab-master's lucide icon: sized off the node's own radius,
// not a fixed px constant. The historical look was 24px on a radius-32 master
// (0.75×radius); the icon then grew 50% relative to its box → 1.125×radius.
// With the tab node's own 1.5x bump above, the drawn logo nets 2.25x.
const TAB_ICON_SIZE_RATIO = 1.125;

// The hub's capybara / tenant-logo box as a fraction of the hub's radius
// (1.5 x radius = 75% of the square), so it grows with HUB_LEAD.
const HUB_ICON_SIZE_RATIO = 1.5;
// Title font as a fraction of the node's half-extent, floored at 10 graph
// units. Labels live inside the pan/zoom transform, so a fixed 10 vanished on
// the hub / app squares once APP_LEAD + HUB_LEAD grew them and frameView
// zoomed out to fit (≈0.15: a 210-wide square, a 1.5px title). Small nodes
// (size ≤ 16) keep the old 10.
const LABEL_SIZE_RATIO = 0.6;
const labelSizeFor = (size: number) => Math.max(10, size * LABEL_SIZE_RATIO);
// Gap between the square's bottom edge and the title's baseline, graph units.
const LABEL_GAP = 3;
// The title's drawn footprint below the square: baseline gap + font size +
// a descender allowance. The repel pass (drawMap) keeps neighbours out of it.
const labelFootprint = (size: number) => LABEL_GAP + labelSizeFor(size) + 4;

// The capybara: the alpha mask of src/core/assets/capybara.ico (the rail's
// 32x32 pixel-art icon) traced pixel-for-pixel into one path — one `M h v h z`
// rect per horizontal run of opaque pixels, bbox-normalised. A vector, so it
// stays crisp at any hub size and takes the node's icon colour (white at
// rest). Regenerate with the same trace if the .ico changes.
const CAPYBARA_W = 21;
const CAPYBARA_H = 23;
const CAPYBARA_D = 'M3 0h6v1h-6zM11 0h5v1h-5zM2 1h14v1h-14zM1 2h15v1h-15zM0 3h16v1h-16zM0 4h15v1h-15zM0 5h15v1h-15zM0 6h15v1h-15zM0 7h16v1h-16zM1 8h16v1h-16zM2 9h16v1h-16zM4 10h14v1h-14zM4 11h15v1h-15zM3 12h17v1h-17zM3 13h17v1h-17zM2 14h19v1h-19zM2 15h19v1h-19zM1 16h20v1h-20zM1 17h20v1h-20zM1 18h4v1h-4zM6 18h14v1h-14zM5 19h14v1h-14zM5 20h13v1h-13zM5 21h11v1h-11zM9 22h4v1h-4z';

function edgeStyle(strength: number): { offsets: number[]; width: number; dash?: string } {
  if (strength >= 0.95) return { offsets: [-2.5, 0, 2.5], width: 1 };        // triple bold
  if (strength >= 0.75) return { offsets: [-1.5, 1.5],    width: 1 };        // double
  if (strength >= 0.63) return { offsets: [0],             width: 1.5 };     // single solid
  return                       { offsets: [0],             width: 0.75, dash: '4 4' }; // dotted
}

export interface BrainGraphHandle {
  resetView: () => void;
}

interface BrainGraphProps {
  // sourceRef is an admin-only extension of core's BrainNode (see
  // useBrainGraph.ts's AdminBrainNode) — optional here so this component
  // still accepts a bare BrainNode[] if ever rendered elsewhere.
  nodes: Array<BrainNode & { sourceRef?: unknown; kind?: 'hub' | 'portal'; tier?: Tier }>;
  edges: BrainEdge[];
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (id: string) => void;
  /** Shift-drag box-selected 2+ real nodes at once — their ids, in no particular order. */
  onMultiSelect?: (ids: string[]) => void;
  /** The parent's current box-selection, if any — rendered with the same highlight as selectedId. */
  multiSelectedIds?: ReadonlySet<string>;
  onHover: (id: string | null) => void;
  /** Double-click on a node — currently only meaningful for a 'portal' (open/close its cluster in place). */
  onExpand?: (id: string) => void;
  /** 'modifier' leaves a bare wheel to the page — for a graph inside a scrolling tab. */
  wheelZoom?: 'always' | 'modifier';
  /** Search results: null/undefined = search inactive, everything full opacity. */
  matchedIds?: ReadonlySet<string> | null;
  /** Settings → Store hidden keys (nav-group / add-on ids): their tab/tool masters dim, and so does everything hanging only off them. */
  hiddenKeys?: readonly string[];
  /** White-label tenant logo: drawn inside the hub instead of the capybara. */
  hubLogoUrl?: string | null;
  /** Derived clustering overlay (buildSpine) — grouping labels, never persisted. */
  showSpine?: boolean;
  /** Spatial density heatmap — additive glow blobs at each node's position, brighter where nodes cluster. */
  showDensity?: boolean;
  /** Live-activity heat: nodes the worker recently recalled/distilled glow and breathe. */
  glow?: ReadonlyMap<string, GlowInfo>;
  /**
   * Nodes folded INTO the hub — drawn at the hub's position, size 2, opacity 0,
   * no pointer events (exactly what an absorbed blob member gets), so
   * un-folding slides them out along the existing 400ms transitions. Layout,
   * fit and density still use their true positions. Onboarding's satellites
   * before the hub is hovered.
   */
  collapsedIds?: ReadonlySet<string>;
  /**
   * Per-node dimming override (true = dimmed, false = lit) — wins over the
   * Store-off fade, loses to search. The hub's upgrade offer: folded apps pop
   * out dimmed and must light up on hover even when their Store app is off.
   */
  fade?: ReadonlyMap<string, boolean>;
  /**
   * Hovered parents: each one's folded children pop back out of it, dimmed, and
   * light up under the pointer — the hub's Store-off apps, an app's off tools,
   * one generation per hover. The brain's upgrade offer, in every state. The
   * host clears it when the pointer leaves the graph with no panel holding it.
   */
  revealed?: ReadonlySet<string>;
  /** The node the agent is working in right now: a small pulsing accent square at its top-right corner. */
  markerId?: string | null;
}

const DIMMED_OPACITY = 0.15;
// Stable default so the offIds memo below doesn't re-run on every render.
const NO_HIDDEN_KEYS: readonly string[] = [];
const NO_REVEALED: ReadonlySet<string> = new Set();

// Density HEATMAP blobs hold a constant SCREEN size (compensated by
// 1/view.scale, since they're drawn inside the pan/zoom transform) rather
// than a fixed graph-space radius — so granularity tracks zoom: zoomed in,
// blobs shrink relative to node spacing and stay distinct; zoomed out, they
// merge into coarser hot regions. Heatmap only — the overlap-MERGE trigger
// below uses core's much tighter MERGE_SCREEN_SLACK instead: heat spreads
// wider than "these squares are stacked".
const DENSITY_BLOB_SCREEN_RADIUS = DEFAULT_DENSITY_SCREEN_RADIUS;

const isEmployeeNode = (node: { kind?: 'hub' | 'portal'; employeeId?: string }) =>
  node.kind === 'hub' || node.kind === 'portal' || !!node.employeeId;

// The hub's drawn half-extent is at least this many times the biggest other
// visible node's — the guarantee behind "the hub is the biggest node".
const HUB_LEAD = 1.15;
// A Store app's drawn half-extent is at least this many times the biggest
// visible tier-3+ node's (see appRenderSize) — "an app is bigger than what
// hangs off it", the same guarantee HUB_LEAD gives the hub.
const APP_LEAD = 1.1;

// THE central hub — the admin / agent worker. One predicate (brainMasters'
// findHubId) drives this graph's pin, size clamp and merge priority, plus
// BrainCard's reorganize root and auto-select; re-exported so BrainCard keeps
// importing it from here.
import { findHubId, tierOf, tierScale, treeParents, type Tier } from '../lib/brainMasters';
export { findHubId };

// Tier → core density rank (see the densityClusters memo for why 2.5).
const MERGE_RANK: Record<Tier, number> = { 1: 1, 2: 2, 3: 2.5, 4: 3, 5: 4 };

// ---- Per-element memo components -------------------------------------------
// The graph is ~1 600 SVG elements. Without these, a hover or a select (two
// nodes change) reconciled every one of them; memo'd on scalars, React skips
// everything whose inputs didn't move. Only the CSS transitions that Chrome
// can actually animate are kept (rect x/y/width/height, group opacity, the
// icon transform): `x1/y1/x2/y2` on <line> and `x/y` on <text> are plain
// attributes, not CSS geometry properties, so a transition on them is a dead
// style object per element per render.

const NO_POINTER: CSSProperties = { pointerEvents: 'none', userSelect: 'none' };
const ICON_G_STYLE: CSSProperties = { pointerEvents: 'none', transition: 'transform 400ms ease' };
const RECT_STYLE: CSSProperties = { transition: 'x 400ms ease, y 400ms ease, width 400ms ease, height 400ms ease' };
const MARKER_STYLE: CSSProperties = { pointerEvents: 'none', animation: 'nff-dot-pulse 1.2s ease-in-out infinite', transition: 'x 400ms ease, y 400ms ease' };

/** One edge = its 1–3 parallel lines (edgeStyle). */
const EdgeLines = memo(function EdgeLines({ x1, y1, x2, y2, strength, active, dimmed }: {
  x1: number; y1: number; x2: number; y2: number; strength: number; active: boolean; dimmed: boolean;
}) {
  const stroke = active ? 'var(--color-ink)' : 'var(--color-faint)';
  const { offsets, width, dash } = edgeStyle(strength);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  const px = len > 0 ? -dy / len : 0;
  const py = len > 0 ?  dx / len : 0;
  return (
    <g opacity={dimmed ? DIMMED_OPACITY : 1}>
      {offsets.map((o, j) => (
        <line
          key={j}
          x1={x1 + px * o} y1={y1 + py * o}
          x2={x2 + px * o} y2={y2 + py * o}
          stroke={stroke}
          strokeWidth={width}
          strokeDasharray={dash}
        />
      ))}
    </g>
  );
});

type GraphNode = BrainGraphProps['nodes'][number];

/**
 * One node square + icon/glyph + label (+ marker, + blob badge). `absorbed`:
 * just eaten by a blob (or folded into the hub) — drawn at the anchor's
 * position at size 2 / opacity 0 so the CSS transitions slide it in.
 */
const NodeGlyph = memo(function NodeGlyph({
  node, x, y, size, absorbed, selected, hovered, dimmed, blink, marker, blobCount, blobSummary,
  isHub, hubLogoUrl, onClick, onDoubleClick, onHover,
}: {
  node: GraphNode; x: number; y: number; size: number;
  isHub: boolean; hubLogoUrl: string | null;
  absorbed: boolean; selected: boolean; hovered: boolean; dimmed: boolean; blink: boolean; marker: boolean;
  blobCount: number; blobSummary: string | null;
  onClick: (id: string) => void; onDoubleClick: (id: string) => void; onHover: (id: string | null) => void;
}) {
  const TabIcon = tabIconFor(node.sourceRef);
  const ToolIcon = TabIcon ? null : toolIconFor(node.sourceRef);
  // Derived from this node's own (already 1.5x-bumped, possibly
  // absorption-bumped) size, so the logo grows and shrinks with it.
  const toolIconSize = size * TOOL_ICON_SIZE_RATIO;
  const tabIconSize = size * TAB_ICON_SIZE_RATIO;
  const hubIconSize = size * HUB_ICON_SIZE_RATIO;
  const labelSize = labelSizeFor(size);
  // Fit the (non-square) capybara bbox inside HALF the hub icon box, centred.
  const capyScale = (hubIconSize * 0.5) / Math.max(CAPYBARA_W, CAPYBARA_H);
  // core nodes (the hub + every tab master) read white at
  // rest, not just black-like everything else, so they stand out from
  // across the room. Tool nodes always read white — brand logos are
  // full-color marks, not icons drawn in iconColor, so they need a
  // plain white plate under them, not the ink/paper category fill.
  // Selected/hovered keep their own distinct look, for every node kind.
  const fill = selected
    ? 'var(--color-ink)'
    : hovered
      ? 'var(--color-elevated)'
      : ToolIcon
        ? 'white'
        : node.category === 'core'
          ? 'var(--color-ink)'
          : 'var(--color-paper)';
  const iconColor = fill === 'var(--color-ink)' ? 'var(--color-paper)' : 'var(--color-ink)';
  return (
    <g
      // Onboarding tour anchors: the hub, and each node by id (OnboardingTour spotlights them).
      data-tour={isHub ? 'brain-hub' : `brain-node-${node.id}`}
      style={{
        cursor: absorbed ? 'default' : 'pointer',
        opacity: absorbed ? 0 : dimmed ? DIMMED_OPACITY : 1,
        pointerEvents: absorbed ? 'none' : undefined,
        transition: 'opacity 400ms ease',
      }}
      onClick={() => onClick(node.id)}
      onDoubleClick={() => onDoubleClick(node.id)}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
    >
      <rect
        className={blink ? 'nb-blink' : undefined}
        x={x - size} y={y - size}
        width={size * 2} height={size * 2}
        rx={isEmployeeNode(node) ? size * 0.35 : ToolIcon ? size : undefined}
        fill={fill}
        stroke="var(--color-ink)"
        strokeWidth={selected ? 0 : 1}
        style={RECT_STYLE}
      />
      {isHub && hubLogoUrl ? (
        // Tenant logo: a full-color mark, so a white plate under it (same
        // rule as tool nodes), sized off the hub radius like every other icon.
        <g transform={`translate(${x - hubIconSize / 2} ${y - hubIconSize / 2})`} style={ICON_G_STYLE}>
          <rect width={hubIconSize} height={hubIconSize} rx={hubIconSize * 0.2} fill="white" />
          <image
            href={hubLogoUrl}
            x={hubIconSize * 0.1} y={hubIconSize * 0.1}
            width={hubIconSize * 0.8} height={hubIconSize * 0.8}
            preserveAspectRatio="xMidYMid meet"
          />
        </g>
      ) : isHub ? (
        // The capybara silhouette (CAPYBARA_D), scaled off the hub radius so
        // it grows with HUB_LEAD. Reads paper-on-ink at rest (white), ink
        // when hovered; nb-blink-text on the <g> inherits into the path.
        <g
          className={blink ? 'nb-blink-text' : undefined}
          transform={`translate(${x - (CAPYBARA_W * capyScale) / 2} ${y - (CAPYBARA_H * capyScale) / 2}) scale(${capyScale})`}
          fill={iconColor}
          style={ICON_G_STYLE}
        >
          <path d={CAPYBARA_D} shapeRendering="crispEdges" />
        </g>
      ) : TabIcon ? (
        <g transform={`translate(${x - tabIconSize / 2} ${y - tabIconSize / 2})`} style={ICON_G_STYLE}>
          <TabIcon size={tabIconSize} color={iconColor} strokeWidth={1.75} />
        </g>
      ) : ToolIcon ? (
        <g transform={`translate(${x - toolIconSize / 2} ${y - toolIconSize / 2})`} style={ICON_G_STYLE}>
          {/* Brand logos carry their own colors — a white chip, not the
              ink/paper node fill, keeps them legible either way. Both
              sized directly via BrandIcons.tsx's `size` prop (explicit
              width/height, not a transform scale), off toolIconSize so
              resizing the node resizes the logo with it. */}
          <rect width={toolIconSize} height={toolIconSize} rx={toolIconSize * 0.25} fill="white" />
          <ToolIcon bare size={toolIconSize} />
        </g>
      ) : (
        // x/y on <text> are attributes, not CSS properties — only a translate
        // on a wrapping <g> can be transitioned (same for every label below).
        <g transform={`translate(${x} ${y + 4})`} style={ICON_G_STYLE}>
          <text
            className={blink ? 'nb-blink-text' : undefined}
            textAnchor="middle"
            fontSize={size > 20 ? 13 : 9}
            fill={iconColor}
            fontFamily="Arial, Helvetica, sans-serif"
            style={NO_POINTER}
          >
            {/* Employee routing nodes (server-derived, see api/_lib/
                brain.ts) get their own glyphs over the category's:
                the Employees hub and each per-employee portal. */}
            {node.kind === 'hub' ? '⧉' : node.kind === 'portal' ? '◫' : (CATEGORY_ICON[node.category] ?? '·')}
          </text>
        </g>
      )}
      <g transform={`translate(${x} ${y + size + labelSize + 3})`} style={ICON_G_STYLE}>
        <text
          textAnchor="middle"
          fontSize={labelSize}
          fill="var(--color-ink)"
          fontFamily="Arial, Helvetica, sans-serif"
          fontWeight={selected ? 'bold' : 'normal'}
          style={NO_POINTER}
        >
          {node.title}
        </text>
      </g>
      {marker && (
        // "The agent is working here": the platform's working blue (the
        // updating dot / floor grid), pulsing, at the top-right corner outside
        // the square so the icon stays clear. BRAND_ACCENT falls back to ink.
        <rect
          x={x + size - 3} y={y - size - 5}
          width={8} height={8}
          fill="#1d4ed8"
          stroke="var(--color-paper)"
          strokeWidth={1}
          style={MARKER_STYLE}
        />
      )}
      {blobCount > 0 && (
        <>
          {/* Mass badge: how many nodes this anchor absorbed. Top-right
              corner, outside the square so no glyph/logo is covered. */}
          <g transform={`translate(${x + size + 2} ${y - size + 2})`} style={ICON_G_STYLE}>
            <text
              fontSize={10}
              fontWeight="bold"
              fill="var(--color-ink)"
              fontFamily="Arial, Helvetica, sans-serif"
              style={NO_POINTER}
            >
              {`×${blobCount}`}
            </text>
          </g>
          <title>
            {`${blobSummary}\n\n(click to read ${node.title}, double-click to list the absorbed nodes)`}
          </title>
        </>
      )}
    </g>
  );
});

export const BrainGraph = memo(forwardRef<BrainGraphHandle, BrainGraphProps>(function BrainGraph(
  { nodes: rawNodes, edges, selectedId, hoveredId, onSelect, onMultiSelect, multiSelectedIds, onHover, onExpand, wheelZoom = 'always', matchedIds, hiddenKeys = NO_HIDDEN_KEYS, showSpine, showDensity, glow, collapsedIds, fade, revealed = NO_REVEALED, markerId, hubLogoUrl = null },
  ref,
) {
  // Re-render on a permission flip so a tool node's dimming stays live —
  // toolDisabled() reads the same module-level mirror SettingsTab.tsx does.
  // The version is a dep of the offIds memo below, nothing more.
  const permVersion = useSyncExternalStore(subscribePermissions, permissionsVersion);

  // The central hub is pinned during spacing so the graph keeps its anchor.
  // Resolved on the raw rows: the predicate reads category/sourceRef only.
  const coreId = useMemo(() => findHubId(rawNodes), [rawNodes]);

  // Priority tier per node (brainMasters.ts tierOf): deriveMasters stamps it
  // on the rows it saw; rows from a source that never derives (nff-admin's
  // vendor brain, the teammate overlay) are tiered here on their relatedIds.
  const tiers = useMemo(
    () => new Map(rawNodes.map(n => [n.id, n.tier ?? tierOf(n, coreId)])),
    [rawNodes, coreId],
  );

  // Size by tier: the hub 3x, a Store app 2.5x (under the hub's HUB_LEAD so
  // the clamp below never inflates the hub past its own 3x), tier 3 keeps its
  // old bumps (tool logo 2.25x, employee 1.3x, tab 1.5x), a central
  // memory 1.5x, a plain one as stored. Every bump goes in here, before
  // spacing/fit/glow, so they don't crowd their neighbours instead of just
  // visually overlapping them. The hub's 3x is what keeps it the biggest blob
  // when zoomed out: merge priority only settles CONTESTED nodes, and
  // area-conserving growth means a 2.25x tool master would need ~16 absorbed
  // plain nodes to outgrow a 3x hub — "almost guaranteed". The tool/tab logo
  // itself is drawn off this same (already-bumped) node.size — see
  // toolIconSize/tabIconSize below — so it always scales together with the
  // circle, never independently.
  const nodes = useMemo(
    () =>
      rawNodes.map(n => {
        const k = tierScale(n, tiers.get(n.id) ?? 5);
        return k === 1 ? n : { ...n, size: n.size * k };
      }),
    [rawNodes, tiers],
  );

  // Store-off / permissions-off masters plus everything that hangs only off
  // them (see toolDisabled above). Seeds: tab masters whose tab is hidden,
  // tool masters that are off. Anchors:
  // the hub, every master still on, and the employee hub/portals — a node the
  // anchors can still reach without crossing a seed stays lit. The whole set
  // FOLDS onto its parents (foldTarget below) until a hover pops it out.
  const offIds = useMemo(() => offMasterIds(nodes, edges, hiddenKeys, coreId), [nodes, edges, hiddenKeys, coreId, permVersion]);
  // Store-off fade unless the host says otherwise for this node (see `fade`) —
  // a popped-out node lights up under the pointer / when selected.
  const dimOf = (id: string) =>
    fade?.get(id) ?? (offIds.has(id) && id !== hoveredId && id !== selectedId);

  // RULE: a folded node sits on its MOTHER node, not the hub — GitHub on Dev,
  // To Do on Admin, an app on the hub (treeParents: the nearest higher-tier neighbour).
  // The off set and the host's own collapsedIds (onboarding satellites) fold
  // alike; hovering a parent (`revealed`) pops ITS children out, one generation
  // per hover. foldTarget = folded id → the nearest ancestor that is drawn, so a
  // child of a still-folded parent rides along to wherever that parent sits.
  const parentOf = useMemo(() => treeParents(nodes, edges, tiers, coreId), [nodes, edges, tiers, coreId]);
  const foldTarget = useMemo(() => {
    const folded = new Set<string>(collapsedIds ?? []);
    for (const id of offIds) {
      const p = parentOf.get(id) ?? coreId;
      if (!(p && revealed.has(p))) folded.add(id);
    }
    const target = new Map<string, string>();
    for (const id of folded) {
      let p = parentOf.get(id) ?? coreId;
      for (let guard = 0; p && folded.has(p) && guard < 32; guard++) p = parentOf.get(p) ?? coreId;
      if (p && p !== id) target.set(id, p);
    }
    return target;
  }, [collapsedIds, offIds, parentOf, coreId, revealed]);

  // Minimum-spacing pass, memoized on the node SET (ids + positions + sizes) so live
  // hover updates never re-jitter the layout.
  const spaceKey = useMemo(
    () => nodes.map(n => `${n.id}:${Math.round(n.x)}:${Math.round(n.y)}:${n.size}`).join('|'),
    [nodes],
  );
  const laidOut = useMemo(
    () => spaceOutNodes(nodes, { minGap: 60, pinnedId: coreId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spaceKey, coreId],
  );

  // Content bounding box (board coords, incl. node squares + the label beneath) for auto-fit.
  const fit = useMemo<FitBox | null>(() => {
    if (nodes.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const p = laidOut[n.id];
      if (!p) continue;
      minX = Math.min(minX, p.x - n.size);
      minY = Math.min(minY, p.y - n.size);
      maxX = Math.max(maxX, p.x + n.size);
      maxY = Math.max(maxY, p.y + n.size + 20); // label sits below the square
    }
    if (!Number.isFinite(minX)) return null;
    // RULE: the screen is centered on the hub — every fit (initial, resize,
    // the Fit button) frames the graph around it, not around the bbox centre.
    const focus = coreId ? laidOut[coreId] : undefined;
    return { minX, minY, maxX, maxY, focus };
  }, [nodes, laidOut, coreId]);

  // Re-arm the one-shot auto-fit only when the node-id set changes (add / remove / merge),
  // not on every position tweak — so a merge reframes but hovering doesn't.
  const fitKey = useMemo(() => nodes.map(n => n.id).sort().join(','), [nodes]);

  const { view, panning, svgRef, movedRef, startPan, resetView } = usePanZoom({
    fit,
    fitKey,
    padding: 56,
    minScale: 0.15,
    maxScale: 2.5,
    wheelZoom,
  });

  useImperativeHandle(ref, () => ({ resetView }), [resetView]);

  // Board-space cursor position while the density overlay is on — drives the
  // "picker" readout beside the legend. null when the pointer isn't over the
  // canvas (or the overlay is off), so the readout just doesn't render.
  const [pointerBoard, setPointerBoard] = useState<Pt | null>(null);

  // Memoized on laidOut (itself gated on spaceKey) so the identity only
  // changes when a node's settled position/size does — every heavy memo below
  // (densityClusters' O(n²) merge pass in particular) hangs off this object,
  // and a hover, pan step, glow tick or poll must not re-run them.
  const nodeMap = useMemo(
    () => Object.fromEntries(nodes.map(n => [n.id, laidOut[n.id]])),
    [nodes, laidOut],
  );
  // Shift-drag box-select: a plain drag on empty canvas still pans (startPan,
  // unchanged) — only a shift-held drag starts a marquee instead. Board-space
  // corners (not screen), so the drawn box tracks the content under the
  // pan/zoom transform like everything else. The move/up handlers are created
  // fresh per gesture and attached directly to `document` (same "survives
  // leaving the SVG" reasoning as usePanZoom's own pan gesture) — closing over
  // `view`/`visibleNodes`/`nodeMap` from the render the drag started in is
  // fine here since none of them move mid-drag.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const toBoard = (clientX: number, clientY: number): Pt | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: (clientX - rect.left - view.tx) / view.scale, y: (clientY - rect.top - view.ty) / view.scale };
  };
  const handlePointerDown = (e: React.PointerEvent) => {
    if (!e.shiftKey || e.pointerType !== 'mouse' || e.button !== 0) {
      startPan(e);
      return;
    }
    e.preventDefault();
    const start = toBoard(e.clientX, e.clientY);
    if (!start) return;
    setMarquee({ x0: start.x, y0: start.y, x1: start.x, y1: start.y });

    const onMove = (ev: PointerEvent) => {
      const p = toBoard(ev.clientX, ev.clientY);
      if (p) setMarquee(m => (m ? { ...m, x1: p.x, y1: p.y } : m));
    };
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      const end = toBoard(ev.clientX, ev.clientY) ?? start;
      const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x);
      const minY = Math.min(start.y, end.y), maxY = Math.max(start.y, end.y);
      setMarquee(null);
      if (maxX - minX < 3 && maxY - minY < 3) return; // a shift-click, not a drag — no-op
      const hits = visibleNodes
        .filter(n => {
          const p = drawMap[n.id];
          return p && p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
        })
        .map(n => n.id);
      if (hits.length >= 2) onMultiSelect?.(hits);
      else if (hits.length === 1) onSelect(hits[0]);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  // Purely a labelled-grouping visualization — recomputed every render, never
  // persisted (see spine.ts's own design note on why a spine node must never
  // be written back). Cheap enough to gate on a boolean rather than memoizing
  // against showSpine too.
  const spine = useMemo(() => (showSpine ? buildSpine(nodes, edges) : null), [showSpine, nodes, edges]);

  // Overlap merging — Agar.io style. Nodes whose squares visually overlap at
  // the current zoom fuse into a blob anchored on the highest-priority member
  // (then the largest); the anchor stays rendered (in its own shape/logo,
  // grown by blobSize) and the other members hide behind it. Derived here,
  // never persisted, same contract as the spine above; the difference is
  // this one HIDES members instead of drawing a boundary around them. Fed
  // the SETTLED (de-overlapped) positions via nodeMap, not the raw node.x/y
  // prop — "stacked" has to mean stacked where it actually renders. The
  // slack tracks 1/view.scale so zooming out coalesces and zooming in
  // dissolves.
  const densityClusters = useMemo(() => {
    // Priority decides who absorbs whom when a node overlaps several blobs:
    // the tier (hub, Store app, other master, central memory, plain memory),
    // lower wins. Core PROTECTS ranks below DEFAULT_PRIORITY (3) — they anchor
    // blobs and visibly absorb whatever stacks on them, yet can never
    // themselves be hidden as another blob's member — and compares ranks
    // numerically only, so tier 3 rides at 2.5: still protected, but a
    // contested node prefers an app over a tool master. Tiers 4–5 map to 3–4:
    // absorbable, a central memory preferred as anchor over a plain one.
    // ponytail: fractional rank instead of a core `protectBelow` option —
    // add that (and re-vendor) if a sixth tier ever needs protecting.
    const positioned = nodes.map(n => {
      const p = nodeMap[n.id];
      return p ? { ...n, x: p.x, y: p.y } : n;
    });
    const priority = new Map<string, number>();
    for (const n of positioned) priority.set(n.id, MERGE_RANK[tiers.get(n.id) ?? 5]);
    return buildDensityClusters(positioned, edges, { slack: MERGE_SCREEN_SLACK / view.scale, priority });
  }, [nodes, edges, nodeMap, view.scale, tiers]);
  // A blob's anchor keeps rendering as itself; only the OTHER members hide.
  const blobByAnchor = useMemo(
    () => new Map(densityClusters.map(c => [c.anchorId, c])),
    [densityClusters],
  );
  const hiddenIds = useMemo(
    () => new Set(densityClusters.flatMap(c => c.memberIds.filter(id => id !== c.anchorId))),
    [densityClusters],
  );
  const memberToAnchor = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of densityClusters) for (const id of c.memberIds) if (id !== c.anchorId) m.set(id, c.anchorId);
    return m;
  }, [densityClusters]);
  // A node absorbed into a blob doesn't just vanish the instant it merges —
  // it stays rendered for one transition, sliding and shrinking into the
  // anchor that ate it, then drops out for good (by then it's sitting
  // invisibly on top of the anchor anyway). memberId → the anchor id it's
  // animating toward. Presence in hiddenIds already hides it from the normal
  // edge/label bookkeeping below; this only affects the main node loop.
  // A CONTENT signature, not the Map's reference — `densityClusters` (and so
  // `memberToAnchor`) is a fresh object whenever its memo re-runs (every zoom
  // step, every layout change) even if membership didn't move, and depending
  // on the Map itself re-ran this effect — re-cancelling its own just-armed
  // removal timer via the cleanup below — so an absorbed node's timer never
  // survived long enough to fire: it got added to `absorbing` and then stuck
  // there forever, permanently invisible (opacity 0) instead of reappearing
  // hidden-but-fine behind hiddenIds.
  const mergedKey = useMemo(
    () => [...memberToAnchor.entries()].map(([id, anchor]) => `${id}:${anchor}`).sort().join('|'),
    [memberToAnchor],
  );
  const [absorbing, setAbsorbing] = useState<Map<string, string>>(new Map());
  const prevMergedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const newlyAbsorbed = [...memberToAnchor.keys()].filter(id => !prevMergedRef.current.has(id));
    prevMergedRef.current = new Set(memberToAnchor.keys());
    setAbsorbing(prev => {
      // An id that left memberToAnchor un-merged (zoom back in): it must leave
      // the farewell state too, or it keeps rendering at the anchor at
      // opacity 0 forever. This prune is also the safety net for batches whose
      // removal timer got cancelled by a mid-gesture mergedKey change — the
      // cleanup below clears the pending timer every time the merge set
      // shifts, and wheel zoom shifts it many times per 500ms window.
      let changed = false;
      const next = new Map(prev);
      for (const id of prev.keys())
        if (!memberToAnchor.has(id)) { next.delete(id); changed = true; }
      for (const id of newlyAbsorbed) { next.set(id, memberToAnchor.get(id)!); changed = true; }
      return changed ? next : prev;
    });
    if (newlyAbsorbed.length === 0) return;
    const timer = setTimeout(() => {
      setAbsorbing(prev => {
        const next = new Map(prev);
        for (const id of newlyAbsorbed) next.delete(id);
        return next;
      });
    }, 500); // outlasts the 400ms x/y/opacity transitions below
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedKey]);

  const visibleNodes = useMemo(
    () => nodes.filter(n => !hiddenIds.has(n.id) || absorbing.has(n.id)),
    [nodes, hiddenIds, absorbing],
  );
  // Redirect any edge touching a hidden member to its blob's anchor (a real,
  // visible node), dedupe, and drop now-internal edges (both ends in one blob).
  const visibleEdges = useMemo(() => {
    if (densityClusters.length === 0) return edges;
    const seen = new Set<string>();
    const out: BrainEdge[] = [];
    for (const e of edges) {
      const from = memberToAnchor.get(e.from) ?? e.from;
      const to = memberToAnchor.get(e.to) ?? e.to;
      if (from === to) continue;
      const key = `${from}>${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...e, from, to });
    }
    return out;
  }, [edges, densityClusters, memberToAnchor]);
  // RULE: the hub is the biggest node at EVERY zoom. The 3x bump above only
  // reserves it room; a tool master fat with absorbed nodes could still
  // outgrow it, so the drawn size is clamped to a fixed lead over the biggest
  // other visible node. Read by every drawing path through renderSizeFor
  // (rect, logo, label offset, glow, ×N badge, hit area).
  // Same rule one tier down: a Store app (tier 2) draws at least APP_LEAD over
  // the biggest visible tier-3+ node, so a tool blob fat with absorbed
  // memories never outgrows its app; the hub's clamp then reads the clamped
  // app sizes, keeping hub > app > the rest at every zoom.
  const appRenderSize = useMemo(() => {
    let maxLower = 0;
    for (const n of visibleNodes) if ((tiers.get(n.id) ?? 5) >= 3) maxLower = Math.max(maxLower, blobByAnchor.get(n.id)?.size ?? n.size);
    return maxLower * APP_LEAD;
  }, [visibleNodes, tiers, blobByAnchor]);
  const hubRenderSize = useMemo(() => {
    if (!coreId) return null;
    const hub = nodes.find(n => n.id === coreId);
    if (!hub) return null;
    let maxOther = 0;
    for (const n of visibleNodes) {
      if (n.id === coreId) continue;
      const own = blobByAnchor.get(n.id)?.size ?? n.size;
      maxOther = Math.max(maxOther, tiers.get(n.id) === 2 ? Math.max(own, appRenderSize) : own);
    }
    return Math.max(blobByAnchor.get(coreId)?.size ?? hub.size, maxOther * HUB_LEAD);
  }, [coreId, nodes, visibleNodes, blobByAnchor, tiers, appRenderSize]);
  // An anchor renders at the blob's grown size (core's blobSize, already
  // computed on the cluster); everything else at its own; the hub and the
  // apps at their clamps.
  const renderSizeFor = (n: { id: string; size: number }) => {
    if (n.id === coreId && hubRenderSize != null) return hubRenderSize;
    const own = blobByAnchor.get(n.id)?.size ?? n.size;
    return tiers.get(n.id) === 2 ? Math.max(own, appRenderSize) : own;
  };
  // Repel pass: a blob that grew (absorbed members, or the hub clamp above)
  // shoves every visible NON-merged neighbour clear of its grown square — a
  // tab master can't be eaten, so it gets pushed instead. Same AABB pass as
  // laidOut, just fed the drawn sizes. Always starts from nodeMap (the base
  // settled positions), so nothing drifts across zoom steps; absorbing /
  // collapsed nodes render on their anchor and sit the pass out. Hub pinned
  // (screen-centred rule). Only what is DRAWN reads this — merging itself
  // keeps deciding on nodeMap, or it would feed back on its own output.
  // RULE: a title is part of the node's footprint — no neighbour may sit on
  // it. spaceOutNodes only knows centred squares, so each node's box is
  // shifted down by half its title footprint and grown by the same amount
  // (= exactly the square + title, and wide enough for the title's run),
  // and the resolved centres are shifted back up afterwards.
  const drawMap = useMemo(() => {
    const grown = visibleNodes
      .filter(n => nodeMap[n.id] && !absorbing.has(n.id) && !foldTarget.has(n.id))
      .map(n => {
        const size = renderSizeFor(n);
        const half = labelFootprint(size) / 2;
        return { id: n.id, x: nodeMap[n.id].x, y: nodeMap[n.id].y + half, size: size + half, half };
      });
    const spaced = spaceOutNodes(grown, { minGap: 60, pinnedId: coreId });
    for (const g of grown) spaced[g.id] = { x: spaced[g.id].x, y: spaced[g.id].y - g.half };
    return { ...nodeMap, ...spaced };
    // renderSizeFor closes over exactly blobByAnchor/hubRenderSize/appRenderSize/tiers/coreId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeMap, visibleNodes, absorbing, blobByAnchor, hubRenderSize, appRenderSize, tiers, coreId, foldTarget]);
  // Where an edge or halo is DRAWN: a folded node sits on its fold target.
  const drawPos = (id: string): Pt | undefined => {
    const t = foldTarget.get(id);
    return t ? drawMap[t] : drawMap[id];
  };

  // Spine group nodes carry no coordinates of their own — buildSpine only
  // knows which real nodes are in each group (memberIds is always real node
  // ids, never other spine ids). Placing a group at its members' centroid is
  // enough to draw it as a labelled region over the real layout, with no
  // need to run layoutBrain's separate radial-tree placement here.
  const spinePos: Record<string, Pt> | null = useMemo(() => {
    if (!spine) return null;
    const pos: Record<string, Pt> = {};
    spine.nodes.forEach(g => {
      const pts = g.memberIds.map(id => drawMap[id]).filter((p): p is Pt => !!p);
      if (pts.length === 0) return;
      pos[g.id] = {
        x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
        y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
      };
    });
    return pos;
  }, [spine, drawMap]);
  const resolvePos = (id: string): Pt | undefined => drawMap[id] ?? spinePos?.[id];
  // Which blob's member popover is open, if any — local UI state, not knowledge.
  const [expandedClusterId, setExpandedClusterId] = useState<string | null>(null);
  // Stable per-node handlers (NodeGlyph is memo'd — a fresh closure per render
  // would defeat it). Latest props/lookups go through a ref so the callbacks
  // never change identity.
  const latestRef = useRef({ onSelect, onExpand, onHover, blobByAnchor, nodes });
  latestRef.current = { onSelect, onExpand, onHover, blobByAnchor, nodes };
  // Guard against a pan-drag that ends over a node mis-selecting it.
  const handleNodeClick = useCallback((id: string) => {
    if (!movedRef.current) latestRef.current.onSelect(id);
  }, [movedRef]);
  // Employee nodes keep their open-employee-brain double-click even when they
  // anchor a blob (they rank 2, so they absorb stacked nodes); any other blob
  // anchor's double-click toggles its absorbed-members popover.
  const handleNodeDoubleClick = useCallback((id: string) => {
    if (movedRef.current) return;
    const { onExpand, blobByAnchor, nodes } = latestRef.current;
    const node = nodes.find(n => n.id === id);
    const blob = blobByAnchor.get(id);
    if (node && isEmployeeNode(node)) onExpand?.(id);
    else if (blob) setExpandedClusterId(cur => (cur === blob.id ? null : blob.id));
    else onExpand?.(id);
  }, [movedRef]);
  const handleNodeHover = useCallback((id: string | null) => latestRef.current.onHover(id), []);
  useEffect(() => {
    if (expandedClusterId && !densityClusters.some(c => c.id === expandedClusterId)) setExpandedClusterId(null);
  }, [densityClusters, expandedClusterId]);

  // Density value = neighbor count within the same radius the blobs are
  // drawn at, so the number on the legend always matches what's on screen —
  // shrinks/grows together as DENSITY_BLOB_SCREEN_RADIUS/view.scale tracks zoom.
  // ponytail: O(n²) pairwise scan, recomputed on every layout/zoom change
  // while the overlay is on — fine at brain-graph sizes (tens–hundreds of
  // nodes); switch to a spatial grid/quadtree if that stops being true.
  const densityRadius = DENSITY_BLOB_SCREEN_RADIUS / view.scale;
  const { densityCounts, densityMax } = useMemo(() => {
    if (!showDensity) return { densityCounts: null as Map<string, number> | null, densityMax: 0 };
    const counts = new Map<string, number>();
    let max = 0;
    const positioned = nodes.map(n => ({ id: n.id, p: nodeMap[n.id] })).filter((n): n is { id: string; p: Pt } => !!n.p);
    for (const a of positioned) {
      let count = 0;
      for (const b of positioned) {
        if (a.id === b.id) continue;
        const dx = a.p.x - b.p.x;
        const dy = a.p.y - b.p.y;
        if (dx * dx + dy * dy <= densityRadius * densityRadius) count++;
      }
      counts.set(a.id, count);
      if (count > max) max = count;
    }
    return { densityCounts: counts, densityMax: max };
  }, [showDensity, nodes, nodeMap, densityRadius]);

  // Same neighbor-count formula as densityCounts above, just centered on the
  // cursor's board position instead of a node's — the "pick a point, read its
  // value" counterpart to the per-node blobs.
  const pickerCount =
    showDensity && pointerBoard
      ? nodes.reduce((acc, n) => {
          const p = drawMap[n.id];
          if (!p) return acc;
          const dx = p.x - pointerBoard.x;
          const dy = p.y - pointerBoard.y;
          return dx * dx + dy * dy <= densityRadius * densityRadius ? acc + 1 : acc;
        }, 0)
      : null;
  // WIP density picker: readout and pointer handlers aren't wired to the
  // canvas yet — reference the halves so tsc stays green until they are.
  void setPointerBoard;
  void pickerCount;

  return (
    <svg
      ref={svgRef}
      onPointerDown={handlePointerDown}
      onPointerMove={(e) => {
        if (!showDensity) return;
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect) return;
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        setPointerBoard({ x: (px - view.tx) / view.scale, y: (py - view.ty) / view.scale });
      }}
      onPointerLeave={() => setPointerBoard(null)}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        cursor: showDensity ? 'crosshair' : panning ? 'grabbing' : 'grab',
        touchAction: 'none',
      }}
    >
      <defs>
        <radialGradient id="density-blob">
          <stop offset="0%" stopColor="#ff6a00" stopOpacity={0.35} />
          <stop offset="100%" stopColor="#ff6a00" stopOpacity={0} />
        </radialGradient>
        {/* Same color/opacity range a blob's fillOpacity is driven through
            below (0 → densityMax neighbors) — the legend's numeric ticks are
            the real min/max of that scale, not just decoration. */}
        <linearGradient id="density-scale">
          <stop offset="0%" stopColor="#ff6a00" stopOpacity={0.05} />
          <stop offset="100%" stopColor="#ff6a00" stopOpacity={0.9} />
        </linearGradient>
      </defs>
      <rect x={0} y={0} width="100%" height="100%" fill="var(--color-paper)" />
      <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
        {showDensity && densityCounts && (
          <g>
            {nodes.map(node => {
              const p = drawMap[node.id];
              if (!p) return null;
              const count = densityCounts!.get(node.id) ?? 0;
              const intensity = densityMax > 0 ? count / densityMax : 0;
              return (
                <circle
                  key={`density-${node.id}`}
                  cx={p.x} cy={p.y} r={densityRadius}
                  fill="url(#density-blob)"
                  fillOpacity={intensity}
                  style={{ transition: 'cx 400ms ease, cy 400ms ease, r 200ms ease, fill-opacity 200ms ease' }}
                />
              );
            })}
          </g>
        )}
        {spine && spinePos && spine.edges.map((edge, i) => {
          const from = resolvePos(edge.from);
          const to = resolvePos(edge.to);
          if (!from || !to) return null;
          return (
            <line
              key={`spine-e-${i}`}
              x1={from.x} y1={from.y} x2={to.x} y2={to.y}
              stroke="var(--color-faint)"
              strokeWidth={0.75}
              strokeDasharray="2 4"
            />
          );
        })}
        {visibleEdges.map(edge => {
          const from = drawPos(edge.from);
          const to   = drawPos(edge.to);
          if (!from || !to) return null;
          const isActive =
            edge.from === selectedId || edge.to === selectedId ||
            edge.from === hoveredId  || edge.to === hoveredId;
          // An explicit focus set (search hits, the seed hub's hover) outranks the
          // Store-off fade: what the user is pointing at must never stay greyed.
          const dimmed = matchedIds != null
            ? !(matchedIds.has(edge.from) && matchedIds.has(edge.to))
            : dimOf(edge.from) || dimOf(edge.to);
          return (
            <EdgeLines
              key={`${edge.from}>${edge.to}`}
              x1={from.x} y1={from.y} x2={to.x} y2={to.y}
              strength={edge.strength}
              active={isActive}
              dimmed={dimmed}
            />
          );
        })}
        {/* Activity halos — BEHIND the ink squares so a recently-recalled node
            glows around its edges. All motion is CSS (nb-glow-breathe); React
            only sets the intensity/period/delay vars, at most every 10s. */}
        {glow &&
          visibleNodes.map(node => {
            const g = glow.get(node.id);
            const p = drawPos(node.id);
            if (!g || !p) return null;
            const size = renderSizeFor(node);
            const pad = 6;
            return (
              <rect
                key={`glow-${node.id}`}
                className={`nb-glow${g.fresh ? ' nb-glow--fresh' : ''}`}
                x={p.x - size - pad} y={p.y - size - pad}
                width={(size + pad) * 2} height={(size + pad) * 2}
                fill="none"
                stroke="var(--color-ink)"
                strokeWidth={2}
                style={
                  {
                    '--nb-glow-i': String(g.intensity),
                    '--nb-glow-period': `${g.periodMs}ms`,
                    '--nb-glow-delay': `${g.delayMs}ms`,
                    transition: 'x 400ms ease, y 400ms ease',
                  } as CSSProperties
                }
              />
            );
          })}
        {visibleNodes.map(node => {
          // Just absorbed into a merged cluster — animate toward the hub
          // that ate it instead of vanishing outright: render AT the hub's
          // position, shrunk to nearly nothing, faded to 0 opacity. The x/y/
          // width/height/opacity CSS transitions in NodeGlyph do the actual
          // sliding — React just moves the target, the browser tweens it.
          const absorbTarget = absorbing.get(node.id) ?? foldTarget.get(node.id);
          const p = absorbTarget ? (drawMap[absorbTarget] ?? drawMap[node.id]) : drawMap[node.id];
          if (!p) return null;
          const isSelected = node.id === selectedId || !!multiSelectedIds?.has(node.id);
          // The anchor of an overlap blob renders grown — as if it ate its
          // hidden members (which is exactly what happened).
          const blob = absorbTarget ? undefined : blobByAnchor.get(node.id);
          return (
            <NodeGlyph
              key={node.id}
              node={node}
              x={p.x} y={p.y}
              size={absorbTarget ? 2 : renderSizeFor(node)}
              absorbed={!!absorbTarget}
              selected={isSelected}
              hovered={node.id === hoveredId && !isSelected}
              dimmed={matchedIds != null ? !matchedIds.has(node.id) : dimOf(node.id)}
              // An agent pulled this node just now: the square strobes ink/paper
              // (nb-blink, theme.css).
              blink={!!glow?.get(node.id)?.active && !absorbTarget}
              marker={node.id === markerId && !absorbTarget}
              blobCount={blob ? blob.memberIds.length - 1 : 0}
              blobSummary={blob ? blob.summary : null}
              isHub={node.id === coreId}
              hubLogoUrl={hubLogoUrl}
              onClick={handleNodeClick}
              onDoubleClick={handleNodeDoubleClick}
              onHover={handleNodeHover}
            />
          );
        })}
        {spine && spinePos && spine.nodes.map(g => {
          const p = spinePos[g.id];
          if (!p) return null;
          return (
            <g key={g.id} style={{ pointerEvents: 'none' }}>
              <circle
                cx={p.x} cy={p.y} r={10}
                fill="none"
                stroke="var(--color-muted)"
                strokeWidth={1}
                strokeDasharray="2 3"
                style={{ transition: 'cx 400ms ease, cy 400ms ease' }}
              />
              <g transform={`translate(${p.x} ${p.y - 14})`} style={ICON_G_STYLE}>
                <text
                  textAnchor="middle"
                  fontSize={9}
                  fill="var(--color-muted)"
                  fontFamily="Arial, Helvetica, sans-serif"
                  style={NO_POINTER}
                >
                  {g.title}
                </text>
              </g>
            </g>
          );
        })}
        {/* Open blob popover — drawn LAST so it sits on top of the graph.
            The blob itself is its anchor node, already rendered (grown, with
            a ×N badge) in the node pass above; only the double-click member
            list lives here. */}
        {densityClusters.map(c => {
          if (c.id !== expandedClusterId) return null;
          const p = drawMap[c.anchorId];
          if (!p) return null;
          const renderSize = renderSizeFor({ id: c.anchorId, size: c.size });
          return (
            <foreignObject
              key={c.id}
              x={p.x + renderSize + 8} y={p.y - renderSize}
              width={220} height={Math.min(300, c.memberIds.length * 20 + 40)}
            >
              <div
                style={{
                  background: 'var(--color-paper)',
                  border: '1px solid var(--color-ink)',
                  color: 'var(--color-ink)',
                  fontFamily: 'Arial, Helvetica, sans-serif',
                  fontSize: 11,
                  padding: 8,
                  maxHeight: Math.min(300, c.memberIds.length * 20 + 40),
                  overflowY: 'auto',
                  boxSizing: 'border-box',
                }}
              >
                <div style={{ fontSize: 10, color: 'var(--color-muted)', marginBottom: 2 }}>{c.id}</div>
                <div style={{ fontWeight: 'bold', marginBottom: 4 }}>{c.summary}</div>
                {c.memberIds.map(id => {
                  const n = nodes.find(x => x.id === id);
                  return (
                    <div
                      key={id}
                      style={{ cursor: 'pointer', padding: '2px 0' }}
                      onClick={() => {
                        setExpandedClusterId(null);
                        onSelect(id);
                      }}
                    >
                      {n?.title ?? id}
                    </div>
                  );
                })}
              </div>
            </foreignObject>
          );
        })}
        {/* Shift-drag box-select — drawn LAST so it's never hidden under a
            node/cluster it's being dragged over. */}
        {marquee && (
          <rect
            x={Math.min(marquee.x0, marquee.x1)} y={Math.min(marquee.y0, marquee.y1)}
            width={Math.abs(marquee.x1 - marquee.x0)} height={Math.abs(marquee.y1 - marquee.y0)}
            fill="var(--color-ink)" fillOpacity={0.08}
            stroke="var(--color-ink)" strokeWidth={1} strokeDasharray="4 3"
            style={{ pointerEvents: 'none' }}
          />
        )}
      </g>
      {/* Legend — screen-fixed (outside the pan/zoom <g>), so it stays put
          while the graph itself pans and zooms underneath it. */}
      {showDensity && (
        <g transform="translate(16, 16)" style={{ pointerEvents: 'none' }}>
          <rect x={-8} y={-14} width={170} height={46} fill="var(--color-paper)" stroke="var(--color-ink)" strokeWidth={1} opacity={0.9} />
          <text x={0} y={-2} fontSize={9} fill="var(--color-muted)" fontFamily="Arial, Helvetica, sans-serif">nodes within radius</text>
          <rect x={0} y={4} width={88} height={10} fill="url(#density-scale)" stroke="var(--color-ink)" strokeWidth={0.5} />
          {/* Marks where the cursor's own value falls on the scale. */}
          {pickerCount != null && (
            <line
              x1={88 * (densityMax > 0 ? pickerCount / densityMax : 0)} y1={2}
              x2={88 * (densityMax > 0 ? pickerCount / densityMax : 0)} y2={16}
              stroke="var(--color-ink)"
              strokeWidth={1.5}
            />
          )}
          <text x={0} y={28} fontSize={9} fill="var(--color-ink)" fontFamily="Arial, Helvetica, sans-serif">0</text>
          <text x={88} y={28} textAnchor="end" fontSize={9} fill="var(--color-ink)" fontFamily="Arial, Helvetica, sans-serif">{densityMax}</text>
          <text x={98} y={12} fontSize={11} fontWeight="bold" fill="var(--color-ink)" fontFamily="Arial, Helvetica, sans-serif">
            {pickerCount != null ? pickerCount : '—'}
          </text>
        </g>
      )}
    </svg>
  );
}));
