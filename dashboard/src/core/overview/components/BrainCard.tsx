import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { adminBrainSource, type AdminBrainNode, type BrainSource } from '../hooks/useBrainGraph';
import type { BrainEdge } from '@nff-brain/core/types';
import { useBrainGlow, type GlowInfo } from '../hooks/useBrainGlow';
import { deriveSeedGraph, revealChain, revealTarget, sameSourceRef, seedVisibility, tierOf, treeParents, upgradeIds, type SeedSource } from '../lib/brainMasters';
import { formatRelativeTime } from '../../lib/time';
import { askChat, BRAIN_TOUR_EVENT, CHAT_REPLIED_EVENT, type BrainTourDetail } from '../../lib/adminChat';
import { BrainGraph, findHubId, isOffMaster, offMasterIds, type BrainGraphHandle } from './BrainGraph';
import { subscribePermissions, permissionsVersion } from '../../lib/permissionsStore';
import { BrainTimeline } from './BrainTimeline';
import { MemoryModal } from './MemoryModal';
import { CreateBrainModal } from './CreateBrainModal';
import { fuseRanked } from '@nff-brain/core/rank';
import type { SimHit } from '@nff-brain/core/vector';
import { layoutTree } from '../lib/brainTree';
import { embedQueryInBrowser } from '../lib/embedQuery';
import { BRAIN_TOOL_CATALOG } from '../lib/toolCatalog';
import { TAB_GROUP_ICONS } from '../../lib/tabIcons';
import { useTenant } from '../../../context/TenantContext';

// The brain + chat card, moved verbatim out of OverviewTab so recoded overviews
// (nff-admin's store) can compose it independently. This card IS the brain: it
// carries everything the old Data ▸ Brain tab did — the graph, ⤵ Merge, and the
// memory document as a modal (MemoryModal) — plus the embedded ChatDock in its
// lower pane (they share the card's flex, so the dock stays inside).
// Self-contained: no props; all state/hooks live here.

// One button in the brain graph's side rail: an icon at rest, widening on
// hover to reveal its label so the rail itself can stay narrow. Absolutely
// positioned within a fixed-size slot so the reveal doesn't reflow its
// neighbours or the rail's own width — it simply draws over the graph panel.
function RailButton({
  icon,
  label,
  title,
  onClick,
  disabled,
  active,
}: {
  icon: string;
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <div className="relative h-8 w-8 shrink-0">
      <button
        onClick={onClick}
        disabled={disabled}
        title={title ?? label}
        className={`group absolute left-0 top-0 z-20 flex h-8 w-8 items-center overflow-hidden border border-ink text-xs transition-[width] duration-150 hover:w-auto ${
          disabled
            ? 'cursor-default bg-elevated text-muted'
            : active
              ? 'bg-ink text-paper'
              : 'bg-paper text-ink hover:bg-ink hover:text-paper'
        }`}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center">{icon}</span>
        <span className="hidden whitespace-nowrap pr-2.5 tracking-wide group-hover:inline">{label}</span>
      </button>
    </div>
  );
}

// The goal a hand-authored node points at — mirrors the server's clamp in
// api/_lib/brain.ts upsertUserNode. "Context" is the third kind: no ref,
// the goal text just lives in node.content.
type UserSourceRef = { kind: 'tool'; tool: string } | { kind: 'tab'; tab: string };

// White editor panel for a hand-authored (`usr-`) node: title + goal kind
// (Tool / Tab / Context) + the matching picker. Mounted with key={node.id}
// so switching selection re-seeds the form from the node.
function NodeEditor({
  node,
  onSave,
  className,
}: {
  node: AdminBrainNode;
  onSave: (p: { id: string; title: string; content?: string; sourceRef: UserSourceRef | null }) => Promise<string>;
  /** Placement classes (side column vs. bottom strip) — see BrainCard's sideCls. */
  className: string;
}) {
  const ref = node.sourceRef as { kind?: string; tool?: string; tab?: string } | null;
  const [title, setTitle] = useState(node.title);
  const [kind, setKind] = useState<'tool' | 'tab' | 'context'>(
    ref?.kind === 'tool' || ref?.kind === 'tab' ? ref.kind : 'context',
  );
  const [tool, setTool] = useState(ref?.tool ?? BRAIN_TOOL_CATALOG[0].id);
  const [tab, setTab] = useState(ref?.tab ?? Object.keys(TAB_GROUP_ICONS)[0]);
  const [content, setContent] = useState(node.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        id: node.id,
        title,
        content,
        sourceRef: kind === 'tool' ? { kind: 'tool', tool } : kind === 'tab' ? { kind: 'tab', tab } : null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const field =
    'border border-neutral-300 bg-white px-2 py-1 text-xs text-black focus:border-black focus:outline-none';
  return (
    <div className={`flex ${className} flex-col gap-2 overflow-y-auto bg-white px-4 py-3 text-black`}>
      <span className="text-[10px] uppercase tracking-label text-neutral-500">your node</span>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={80}
        placeholder="Title"
        className={field}
      />
      <span className="mt-1 text-[10px] uppercase tracking-label text-neutral-500">goal</span>
      <div className="flex gap-1">
        {(['tool', 'tab', 'context'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            className={`flex-1 border px-2 py-1 text-[11px] capitalize ${
              kind === k
                ? 'border-black bg-black text-white'
                : 'border-neutral-300 bg-white text-black hover:border-black'
            }`}
          >
            {k}
          </button>
        ))}
      </div>
      {kind === 'tool' && (
        <select value={tool} onChange={(e) => setTool(e.target.value)} className={field}>
          {BRAIN_TOOL_CATALOG.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      )}
      {kind === 'tab' && (
        <select value={tab} onChange={(e) => setTab(e.target.value)} className={field}>
          {Object.keys(TAB_GROUP_ICONS).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      )}
      {kind === 'context' && (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={1200}
          rows={6}
          placeholder="What should the agent know or aim for here?"
          className={`${field} resize-none leading-5`}
        />
      )}
      {error && <span className="text-[11px] text-red-600">Save failed: {error}</span>}
      <button
        onClick={save}
        disabled={saving || !title.trim()}
        className="mt-1 border border-black bg-black px-2 py-1 text-[11px] uppercase tracking-wide text-white disabled:opacity-40"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

// Stable empty defaults: BrainGraph memoizes on the hidden-keys / collapsed-set identity.
const NO_HIDDEN_KEYS: string[] = [];
const NO_UPGRADES: ReadonlySet<string> = new Set();
const NO_REVEALED: ReadonlySet<string> = new Set();

/**
 * `source` is the whole backend seam. Default = nff-admin's vendor brain, read
 * through /api/tables/brain/* with the service role (nff-admin renders
 * <BrainCard /> bare, so it keeps exactly today's behaviour). nff-app passes
 * projectBrainSource, which reads its OWN workspace's brain straight from
 * Supabase under RLS — so no customer request reaches nff-admin for brain data.
 * Vendor-only controls are hidden via source.features rather than duplicated.
 * `pane`: the right-hand variant — fills its parent, no outer frame and no chat
 * column (whatever hosts it in a pane IS the chat).
 */
export function BrainCard({
  source = adminBrainSource,
  pane = false,
  hiddenKeys,
  seeds,
  nodePanel,
  focusId,
  markerId,
  chat,
}: {
  source?: BrainSource;
  pane?: boolean;
  // The chat that sits beside the graph (half the card on desktop). Host-supplied
  // so core stays neutral about WHICH agent it talks to — nff-app's Overview
  // passes its project-agent chat, nff-admin's passes the admin data-dock — and
  // so a chat that itself renders a BrainCard cannot close an import cycle.
  // Omitted (the `pane` variant, the standalone graph) = graph only.
  chat?: ReactNode;
  // Host-supplied side body for the SELECTED node: return a node to replace the
  // memory / connect-card panel with it (nff-app shows a tab master's compact tab
  // view — Fleet, Code… — core never imports a feature, so the host decides).
  // Null/undefined = the usual panel. Gets the wider column.
  nodePanel?: (node: AdminBrainNode) => ReactNode | null | undefined;
  // Host-driven selection: whenever this changes to a node id in the graph, that
  // node is selected (the self-heal story lands on the tab it is touching).
  focusId?: string | null;
  // Node carrying the accent-square marker ("the agent is working here").
  markerId?: string | null;
  // Settings → Store hidden keys, passed by the shell (App.tsx).
  hiddenKeys?: string[];
  // Empty company brain: instead of the text hint, a lone blinking hub whose
  // hover pops these sources out as satellites, dimmed until hovered. Clicking
  // one opens it in the side column: `description` + Activate (the host persists
  // `activated`; the node then stays out for good), then the host's `nodePanel`
  // body for it (nff-app: that part of the Store), then `quickstart` — the
  // question the agent gets once the source is `connected`. Clicking the hub
  // opens its `nodePanel` body too (the whole Store). Matched on sourceRef, so
  // the same panel opens on the real masters too.
  seeds?: Array<
    SeedSource & {
      description: string;
      activated: boolean;
      onActivate: () => void;
      connected: boolean;
      quickstart?: string;
    }
  >;
} = {}) {
  // White-label tenants get their logo inside the hub instead of the capybara.
  const tenant = useTenant();
  const storeHidden = hiddenKeys ?? NO_HIDDEN_KEYS;
  // Which brain the card shows: the company's or one member's — switched by the
  // dropdown or by selecting a portal node.
  const [brainId, setBrainId] = useState('company');
  const isCompanyBrain = brainId === 'company';
  // The viewer's OWN brain, where one exists (nff-app). Editable like the
  // company brain; a teammate's brain is read-only by construction — their
  // shared subset is all RLS ever returns, and every 0156 write policy is
  // gated on is_project_member of the row's project.
  const isMyBrain = source.features.myBrainId !== null && brainId === source.features.myBrainId;
  const isEditableBrain = isCompanyBrain || isMyBrain;
  const {
    nodes,
    edges,
    employees,
    customBrains,
    createCustomBrain,
    loading: brainLoading,
    error: brainError,
    reduce,
    reducing,
    reorganize,
    reorganizing,
    syncDatabase,
    syncing,
    semanticSearch,
    saveNode,
    refresh: refreshBrain,
  } = source.useGraph(brainId);
  const glow = useBrainGlow(nodes);
  // A chat reply may have touched this brain — recall bumps the nodes it read,
  // the run distills new ones — so refetch instead of waiting out the 15s poll
  // and the glow lands right away. Both chats that can fill the `chat` slot
  // fire this; through a ref so the listener is registered once.
  const refreshRef = useRef(refreshBrain);
  useEffect(() => { refreshRef.current = refreshBrain; }, [refreshBrain]);
  useEffect(() => {
    const onReplied = () => void refreshRef.current();
    window.addEventListener(CHAT_REPLIED_EVENT, onReplied);
    return () => window.removeEventListener(CHAT_REPLIED_EVENT, onReplied);
  }, []);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Shift-drag box-selected 2+ nodes at once — just their ids; titles are
  // looked up at render time from `nodes`, same as selectedNode below, so
  // there's one source of truth for what a node is titled.
  const [multiSelectedIds, setMultiSelectedIds] = useState<string[] | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [reading, setReading] = useState(false); // memory document modal
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showSpine, setShowSpine] = useState(false);
  const [showDensity, setShowDensity] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showCreateBrain, setShowCreateBrain] = useState(false);
  const [addingNode, setAddingNode] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<BrainGraphHandle>(null);
  // Set right after a successful Sync/Merge, consumed by the effect below once
  // the NEXT render actually carries the fresh nodes/edges (reorganize must
  // never lay out the stale pre-sync/merge graph it'd see if called inline —
  // reduce()/syncDatabase() already awaited their own refresh(), but that only
  // updates the module-level resourceCache; this component's own `nodes` closes
  // over whatever the last render committed, not that cache, until React
  // re-renders it in).
  const pendingReorganize = useRef(false);

  useEffect(() => {
    if (!showExportMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!exportMenuRef.current?.contains(e.target as Node)) setShowExportMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowExportMenu(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showExportMenu]);

  // Seed mode: the onboarding graph for an empty company brain (see `seeds`).
  // Satellites stay folded in the hub until it's hovered (sticky, so the
  // pointer can travel hub → satellite), and fold back when the pointer leaves
  // the graph. Ends by itself the moment a sync lands real rows.
  const seedMode = isCompanyBrain && nodes.length === 0 && !!seeds?.length && !brainLoading && !brainError;
  const seed = useMemo(
    () => (seeds?.length ? deriveSeedGraph(seeds, source.features.companyLabel) : null),
    [seeds, source.features.companyLabel],
  );
  // The hub in either mode (primitive: the callbacks below stay stable).
  const hubId = useMemo(() => (seedMode && seed ? seed.hubId : findHubId(nodes)), [seedMode, seed, nodes]);
  // Activated satellites (persisted by the host) stay out and lit whatever the pointer does.
  // …and so do the children a seed spawned (they only exist once it is activated).
  const activatedIds = useMemo(
    () => new Set((seeds ?? []).filter((s) => s.activated).flatMap((s) => [s.id, ...(s.children ?? []).map((c) => c.id)])),
    [seeds],
  );
  // RULE: only the LAST hovered parent keeps its folded children out — hover Admin and
  // To Do pops (greyed, activable); hover the hub next and To Do folds back. Hovering a
  // leaf changes nothing. BrainGraph pops the folded children of every id in
  // `revealedIds`: the last parent, plus the folded ancestors a popped child needs to
  // stay drawn (so the pointer can travel hub → app → tool), plus the selected node's
  // chain while its panel is open. Cleared on the way out.
  const [lastRevealed, setLastRevealed] = useState<string | null>(null);
  const reveal = setLastRevealed; // a state setter is already stable
  const parentOf = useMemo(() => {
    const g = seedMode && seed ? seed : { nodes, edges };
    const tiers = new Map(g.nodes.map((n) => [n.id, n.tier ?? tierOf(n, hubId)]));
    return treeParents(g.nodes, g.edges, tiers, hubId);
  }, [seedMode, seed, nodes, edges, hubId]);
  // What is folded right now — same predicates as seedVisibility / BrainGraph's offIds.
  // Permissions live in a module store, hence the version dep.
  const permVersion = useSyncExternalStore(subscribePermissions, permissionsVersion);
  const foldable = useMemo(
    () => (seedMode && seed
      ? new Set(seed.nodes.map((n) => n.id).filter((id) => id !== seed.hubId && !activatedIds.has(id)))
      : offMasterIds(nodes, edges, storeHidden, hubId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [seedMode, seed, activatedIds, nodes, edges, storeHidden, hubId, permVersion],
  );
  const revealIf = useCallback((id: string) => {
    if (revealTarget(id, foldable, parentOf, hubId)) setLastRevealed(id);
  }, [foldable, parentOf, hubId]);
  const revealedIds = useMemo<ReadonlySet<string>>(() => {
    const out = revealChain([lastRevealed, selectedId], foldable, parentOf, hubId);
    return out.size ? out : NO_REVEALED;
  }, [lastRevealed, selectedId, parentOf, foldable, hubId]);
  const seedRevealed = hubId != null && revealedIds.has(hubId);
  // The onboarding tour's "hover the core" / "click the node" gates (App listens).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent<BrainTourDetail>(BRAIN_TOUR_EVENT, { detail: { hubRevealed: seedRevealed, selectedId } }));
  }, [seedRevealed, selectedId]);
  const seedVis = useMemo(
    () => (seed ? seedVisibility(seed, { revealed: seedRevealed, hoveredId, selectedId, activatedIds }) : null),
    [seed, seedRevealed, hoveredId, selectedId, activatedIds],
  );
  // The blink: the hub strobes ink/paper (`active` → nb-blink) over a hot halo until the user finds it.
  const seedGlow = useMemo<ReadonlyMap<string, GlowInfo> | undefined>(
    () => (seed && !seedRevealed ? new Map([[seed.hubId, { intensity: 1, fresh: false, delayMs: 0, periodMs: 1500, active: true }]]) : undefined),
    [seed, seedRevealed],
  );

  // Stable handlers: BrainGraph is memo'd, and this card re-renders on every
  // hover and every host render — a fresh function per render would make the
  // memo useless.
  const handleHover = useCallback((id: string | null) => {
    setHoveredId(id);
    if (id) revealIf(id);
  }, [revealIf]);

  const handleSelect = useCallback((id: string | null) => {
    if (id) revealIf(id); // touch / keyboard fallback for hover
    // Clicking the selected node again closes its panel — the only way out, there
    // is no background-click deselect (the hub's panel is the Store, not a toggle).
    setSelectedId((cur) => (cur === id ? null : id));
    setMultiSelectedIds(null);
  }, [reveal]);

  const handleMultiSelect = useCallback((ids: string[]) => {
    setMultiSelectedIds(ids);
    setSelectedId(null);
  }, []);
  const multiSelectedSet = useMemo(
    () => (multiSelectedIds ? new Set(multiSelectedIds) : undefined),
    [multiSelectedIds],
  );

  // Double-clicking a portal node opens its employee's brain IN PLACE, as a
  // ring of real nodes around the portal, instead of switchBrain()'s full
  // navigation away. A one-time snapshot (not a live poll, per the "for now"
  // scope) fetched straight from the same route useBrainGraph itself polls.
  const [expandedEmployeeId, setExpandedEmployeeId] = useState<string | null>(null);
  const [expandedSnapshot, setExpandedSnapshot] = useState<{ nodes: AdminBrainNode[]; edges: BrainEdge[] } | null>(
    null,
  );
  const expandSeq = useRef(0);

  function switchBrain(next: string) {
    if (next === brainId) return;
    setBrainId(next);
    setSelectedId(null);
    setMultiSelectedIds(null);
    setShowSpine(false);
    setShowDensity(false);
    setExpandedEmployeeId(null);
    setExpandedSnapshot(null);
  }

  const handleExpand = useCallback((id: string) => {
    const node = nodes.find((n) => n.id === id);
    if (!node || node.kind !== 'portal' || !node.employeeId) return;
    setSelectedId(null);
    if (expandedEmployeeId === node.employeeId) {
      setExpandedEmployeeId(null);
      setExpandedSnapshot(null);
      return;
    }
    const employeeId = node.employeeId;
    setExpandedEmployeeId(employeeId);
    setExpandedSnapshot(null);
    const seq = ++expandSeq.current;
    void source.fetchGraph(employeeId).then((snapshot) => {
      if (seq !== expandSeq.current) return; // superseded by a later toggle
      setExpandedSnapshot(snapshot);
    });
  }, [nodes, expandedEmployeeId, source]);

  // The employee list refreshes every 15s (useBrainGraph's poll) — if the
  // expanded employee gets deactivated mid-view, their portal disappears from
  // `nodes` and the merge below has nothing to anchor a ring to.
  useEffect(() => {
    if (expandedEmployeeId && !nodes.some((n) => n.id === `employee-portal-${expandedEmployeeId}`)) {
      setExpandedEmployeeId(null);
      setExpandedSnapshot(null);
    }
  }, [nodes, expandedEmployeeId]);

  // Additive merge: the always-on shared-node ring (server-derived, brain.ts)
  // is left untouched; this only adds the employee's remaining (non-shared)
  // nodes on an outer ring, spoked back to the portal. Ring positions are
  // recomputed from the portal's CURRENT x/y every render rather than cached,
  // since spaceOutNodes may still be nudging it.
  const { renderNodes, renderEdges } = useMemo(() => {
    if (!expandedEmployeeId || !expandedSnapshot) return { renderNodes: nodes, renderEdges: edges };
    const portal = nodes.find((n) => n.id === `employee-portal-${expandedEmployeeId}`);
    if (!portal) return { renderNodes: nodes, renderEdges: edges };
    const alreadyShown = new Set(nodes.filter((n) => n.employeeId === expandedEmployeeId).map((n) => n.id));
    const idMap = new Map<string, string>();
    for (const n of expandedSnapshot.nodes) {
      idMap.set(n.id, alreadyShown.has(n.id) ? n.id : `${expandedEmployeeId}:${n.id}`);
    }
    const newNodes = expandedSnapshot.nodes
      .filter((n) => !alreadyShown.has(n.id))
      .map((n, i, arr) => ({
        ...n,
        id: idMap.get(n.id)!,
        // A synced 'core' node is that employee's OWN hub — it must not fight
        // the company layout's single pinned core node (see brain.ts:261).
        category: n.category === 'core' ? ('strategy' as const) : n.category,
        employeeId: expandedEmployeeId,
        relatedIds: n.relatedIds.map((rid) => idMap.get(rid) ?? rid),
        x: portal.x + 260 * Math.cos((i * 2 * Math.PI) / arr.length),
        y: portal.y + 260 * Math.sin((i * 2 * Math.PI) / arr.length),
      }));
    const spokeEdges: BrainEdge[] = newNodes.map((n) => ({ from: n.id, to: portal.id, strength: 0.6 }));
    const innerEdges: BrainEdge[] = expandedSnapshot.edges
      .map((e) => ({ from: idMap.get(e.from), to: idMap.get(e.to), strength: e.strength }))
      .filter((e): e is BrainEdge => !!e.from && !!e.to);
    return {
      renderNodes: nodes.concat(newNodes),
      renderEdges: edges.concat(spokeEdges, innerEdges),
    };
  }, [nodes, edges, expandedEmployeeId, expandedSnapshot]);

  // Hybrid search: lexical is instant (fuseRanked's pure-lexical path), semantic
  // arrives ~250ms later once the query is embedded in-browser (embedQuery.ts) and
  // matched against brain_vector_search (0071_brain_semantic.sql). Any failure —
  // model still loading, no embedding for this node yet, offline — just leaves
  // semanticHits null and fuseRanked degrades to its documented lexical-only path.
  const [semanticHits, setSemanticHits] = useState<SimHit[] | null>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    setSemanticHits(null); // clear immediately so a stale query's hits never bleed in
    if (!q) return;
    const seq = ++searchSeq.current;
    const timer = window.setTimeout(async () => {
      const vector = await embedQueryInBrowser(q);
      if (!vector || seq !== searchSeq.current) return;
      try {
        const hits = await semanticSearch(vector);
        if (seq === searchSeq.current) setSemanticHits(hits);
      } catch {
        // leave semanticHits null — fuseRanked degrades to lexical
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, semanticSearch]);

  const matches = useMemo(
    () => fuseRanked(query, nodes, semanticHits).map(r => r.node),
    [query, nodes, semanticHits],
  );
  const matchedIds = useMemo(
    () => (query.trim() ? new Set(matches.map(n => n.id)) : null),
    [matches, query],
  );

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setQuery('');
      e.currentTarget.blur();
      return;
    }
    if (e.key !== 'Enter' || matches.length === 0) return;
    const i = matches.findIndex(n => n.id === selectedId);
    setSelectedId(matches[(i + 1) % matches.length].id);
  }

  // Lay the brain out as its priority TREE (brainTree.ts layoutTree: hub at
  // the centre, Store apps around it, each master's children around it…) and
  // persist the result so the arrangement survives a reload — the ADMIN brain
  // project has no members, so this can't go straight from the browser to
  // Supabase under RLS like brain_merge_reduce does; it goes through the same
  // service-role route Merge already uses.
  async function handleReorganize() {
    if (reorganizing || nodes.length === 0) return;
    // RULE: the hub is the tree root — everything radiates from it and it
    // stays where it is (the layout centre).
    const coreId = findHubId(nodes);
    if (!coreId) return;
    const hub = nodes.find(n => n.id === coreId)!;
    const positions = layoutTree(nodes, edges, { hubId: coreId, center: { x: hub.x, y: hub.y } });
    try {
      await reorganize(positions);
    } catch (e) {
      setNotice(`Reorganize failed: ${e instanceof Error ? e.message : String(e)}`);
      window.setTimeout(() => setNotice(null), 4000);
    }
  }

  // Consolidate the brain (~25% per click) by MERGING the least-used learned
  // nodes into their nearest neighbours — nothing is deleted, and the RPC never
  // folds away curated or central nodes. Moved here verbatim from the Brain tab.
  async function handleReduce() {
    if (reducing || nodes.length === 0) return;
    if (
      !window.confirm(
        'Consolidate the brain?\n\nThis merges the least-used learned nodes (about 25%) into their ' +
          'nearest neighbours — their knowledge is kept, not deleted. Curated and central nodes are ' +
          'always preserved.',
      )
    )
      return;
    try {
      const merged = await reduce(0.25);
      setNotice(merged > 0 ? `Merged ${merged} node${merged === 1 ? '' : 's'}` : 'Nothing to merge');
      setSelectedId(null);
      // Folding nodes away leaves the survivors' old positions behind —
      // reorganize once the smaller graph lands so the layout doesn't drift.
      if (merged > 0) pendingReorganize.current = true;
    } catch (e) {
      setNotice(`Merge failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    window.setTimeout(() => setNotice(null), 4000);
  }

  // Mirror every tab into the brain as a master node (source_ref-only). Non-destructive to anything but origin:'supabase' rows
  // (diffed on every call — only the delta is written), so no confirm dialog
  // like Merge. No reorganize afterwards either: untouched nodes keep their
  // spot and new ones arrive next to their nearest neighbour server-side.
  async function handleSyncDatabase() {
    if (syncing) return;
    try {
      const { synced, added, changed, removed } = await syncDatabase();
      setNotice(`Synced ${synced} node${synced === 1 ? '' : 's'}: +${added} · ~${changed} · −${removed}`);
      // A handful of new nodes land beside their neighbours server-side and
      // everything else keeps its spot. A bulk arrival (a workspace's first
      // sync mirrors a hundred rows onto a few masters) stacks into one blob —
      // lay the graph out once so it's readable.
      // ponytail: threshold, not a density check; raise it if small syncs jitter.
      if (added >= 10) pendingReorganize.current = true;
    } catch (e) {
      setNotice(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    window.setTimeout(() => setNotice(null), 4000);
  }

  // Drop a fresh hand-authored node next to the hub, then select it so the
  // white NodeEditor panel opens for its goal. POST-then-refresh (saveNode)
  // rather than an optimistic local node — the 15s poll would wipe one.
  async function handleAddNode() {
    if (addingNode) return;
    const core = nodes.find((n) => n.category === 'core');
    const x = core ? core.x + 140 + Math.random() * 60 : 120 + Math.random() * 560;
    const y = core ? core.y + (Math.random() - 0.5) * 120 : 100 + Math.random() * 400;
    setAddingNode(true);
    try {
      const id = await saveNode({ title: 'New node', x, y });
      handleSelect(id);
    } catch (e) {
      setNotice(`Add node failed: ${e instanceof Error ? e.message : String(e)}`);
      window.setTimeout(() => setNotice(null), 4000);
    } finally {
      setAddingNode(false);
    }
  }

  // Consumes the pendingReorganize flag armed by Sync/Merge above. Runs on
  // every nodes/edges change (i.e. every render carrying a fresh graph, not
  // just the poll ticks) but only ACTS the one time the flag is set, so an
  // unrelated 15s poll tick is always a no-op here.
  useEffect(() => {
    if (!pendingReorganize.current || reorganizing) return;
    pendingReorganize.current = false;
    void handleReorganize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  function downloadBlob(content: string, mime: string, filename: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Client-side transform of the already-fetched graph — no server route
  // needed, this card already holds the full nodes/edges for whichever brain
  // is selected. JSON matches @nff-brain/core's BrainFile shape; Markdown is a
  // read-friendly document (one section per node, edges listed at the end).
  function handleExport(format: 'json' | 'md') {
    if (nodes.length === 0) return;
    setShowExportMenu(false);
    const brainName = isCompanyBrain
      ? 'Company'
      : isMyBrain
        ? 'My brain'
        : (employees.find((e) => e.id === brainId)?.name ?? customBrains.find((b) => b.id === brainId)?.name ?? brainId);
    const filenameBase = isCompanyBrain ? 'company' : isMyBrain ? 'my-brain' : brainId;

    if (format === 'json') {
      const file = {
        version: 1,
        updatedAt: new Date().toISOString(),
        nodes: nodes.map(
          ({ id, title, category, content, color, x, y, size, origin, lastUpdated, recallCount, lastRecalledAt }) => ({
            id,
            title,
            category,
            content,
            color,
            x,
            y,
            size,
            origin,
            lastUpdated,
            recallCount,
            lastRecalledAt,
          }),
        ),
        edges,
      };
      downloadBlob(JSON.stringify(file, null, 2), 'application/json', `${filenameBase}-brain.json`);
      return;
    }

    const titleById = new Map(nodes.map((n) => [n.id, n.title]));
    const lines: string[] = [
      `# ${brainName} — Brain`,
      '',
      `_Exported ${new Date().toLocaleString()}_ · ${nodes.length} node${nodes.length === 1 ? '' : 's'} · ${edges.length} link${edges.length === 1 ? '' : 's'}`,
      '',
    ];
    for (const n of nodes) {
      lines.push(`## ${n.title}`, '', `**${n.category}** · updated ${new Date(n.lastUpdated).toLocaleString()}`, '', n.content, '');
    }
    if (edges.length > 0) {
      lines.push('---', '', '## Edges', '');
      for (const e of edges) {
        lines.push(`- ${titleById.get(e.from) ?? e.from} → ${titleById.get(e.to) ?? e.to} (${e.strength.toFixed(2)})`);
      }
    }
    downloadBlob(lines.join('\n'), 'text/markdown', `${filenameBase}-brain.md`);
  }

  // One list for the graph AND the selection lookup: in seed mode the rendered
  // nodes are the seed satellites, which are not in renderNodes at all.
  const graphNodes = seedMode && seed ? seed.nodes : renderNodes;
  const graphEdges = seedMode && seed ? seed.edges : renderEdges;
  // RULE: the brain is upgradable at all times — in the REAL graph the apps not in
  // use yet fold into the hub and pop out on hover exactly like the seed satellites
  // (brainMasters.upgradeIds), dimmed until the pointer picks one; Activate keeps one
  // out for good. Only the company brain, only when the host passes seeds. Excludes
  // Store-governed tab masters (devices/admin/dev/finance): their own Store on/off is
  // now that signal (BrainGraph's offIds/storeCollapseIds) — this fold is only for a
  // genuine not-yet-real connection (a future kind:'tool' seed).
  const upgrade = useMemo(() => {
    const upgradeSeeds = seeds?.filter((s) => s.sourceRef.kind !== 'tab');
    return !seedMode && isCompanyBrain && upgradeSeeds?.length && hubId ? upgradeIds(graphNodes, graphEdges, upgradeSeeds, hubId) : NO_UPGRADES;
  }, [seedMode, isCompanyBrain, seeds, hubId, graphNodes, graphEdges]);
  const upgradeFade = useMemo(
    () => (seedRevealed && upgrade.size ? new Map([...upgrade].map((id) => [id, id !== hoveredId && id !== selectedId])) : undefined),
    [seedRevealed, upgrade, hoveredId, selectedId],
  );
  // Is anything folded on the graph right now? BrainGraph folds every off master
  // (Store-off app, permission-off tool) onto its parent — same predicate,
  // so the hint below only shows while there is something to find.
  const anyOff = useMemo(
    () => graphNodes.some((n) => isOffMaster(n, storeHidden)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graphNodes, storeHidden, permVersion],
  );
  const folded = upgrade.size > 0 || anyOff;
  // Fold back on the way out — unless a panel is open for a node the pointer revealed
  // (reaching for the panel would otherwise collapse what it belongs to).
  const holdRevealed = !!selectedId && (seedMode || revealedIds.has(selectedId));
  // Host-driven focus: the self-heal story selects the tab master it is touching. Only
  // re-fires when the id changes, so a user click elsewhere holds until the next beat.
  useEffect(() => {
    if (focusId && nodes.some((n) => n.id === focusId)) {
      setSelectedId(focusId);
      setMultiSelectedIds(null);
    }
  }, [focusId, nodes]);

  const selectedNode = graphNodes.find((n) => n.id === selectedId) ?? null;
  // Last selected id, kept across deselect: the panel keeps drawing that node
  // while its strip slides shut (conditional set-state-in-render, per React docs).
  const [stickyId, setStickyId] = useState<string | null>(null);
  if (selectedId && selectedId !== stickyId) setStickyId(selectedId);
  const panelNode = selectedNode ?? graphNodes.find((n) => n.id === stickyId) ?? null;
  // A source's own connect card replaces the memory panel wherever that source's
  // master node is clicked — the seed hub AND the real graph, so it can be wired
  // up (or re-checked) without leaving the brain, whatever state the brain is in.
  // Matched on sourceRef, never on id: the seed satellite is `tool-github`, the
  // derived master is too, but one a workspace sync persisted is `<proj8>-tool-github`.
  const selectedSeed = panelNode ? (seeds?.find((s) => sameSourceRef(s.sourceRef, panelNode.sourceRef)) ?? null) : null;
  // A Store-governed tab master (devices/admin/dev/finance) is always "kept" once its
  // Store row is on — an off one is now invisible/unclickable via BrainGraph's own
  // merge, so a real master that's still selectable IS on. The separate onboarding
  // "Activate to keep this" gesture only still applies in seedMode (spawns first
  // content) or to a genuine not-yet-real external-tool connection (kind:'tool').
  const seedActivated = !!selectedSeed && (!seedMode && selectedSeed.sourceRef.kind === 'tab' ? true : selectedSeed.activated);
  // The host's own side body for this node (a tab master's compact tab view), if any.
  const hostBody = panelNode ? (nodePanel?.(panelNode) ?? null) : null;
  // Selection / editor panel: a strip under the graph. The shell below owns its height,
  // so every body here just fills what it is given.
  const sideCls = 'h-full w-full min-h-0 shrink-0';
  const sideOpen = !!selectedNode || (multiSelectedIds?.length ?? 0) > 1;
  // lastUpdated is core's ISO string, so parse before comparing.
  const brainUpdated = nodes.length
    ? new Date(Math.max(...nodes.map((n) => new Date(n.lastUpdated).getTime())))
    : null;

  const sidePanel = (
    <>
    {/* A picked source: its part of the Store (the host's body), beside the graph
        rather than a tab away — the point is never to have to leave the brain.
        What the master node itself remembers rides above, so the Store adds to
        the memory instead of hiding it. Activate gates the body; Quickstart
        follows it once a source of the app is connected. */}
    {/* view-transition-name: this box grows into the full tab on the panel's ⤢ —
        App.openTabFullScreen wraps the switch in withViewTransition and the destination
        tab wrapper carries the same name. */}
    {selectedSeed && panelNode ? (
      <div className={`flex ${sideCls} min-h-0 flex-col overflow-hidden [view-transition-name:tab-panel]`}>
        {/* The header is empty once the Store row is showing — it carries the app's own
            blurb, so the memory line, title and Activate above it would only repeat it. */}
        {!(seedActivated && hostBody) && (
        <div className="shrink-0 px-4 py-3">
          {panelNode.content && panelNode.content !== panelNode.title && !(seedActivated && hostBody) && (
            <button
              onClick={() => setReading(true)}
              title="Read the full memory"
              className="mb-3 flex w-full flex-col items-start gap-1 border-b border-hairline pb-3 text-left hover:bg-elevated"
            >
              <span className="shrink-0 text-[11px] text-faint underline">Read it →</span>
              <p className="text-xs leading-5 text-muted">{panelNode.content.split('\n\n')[0]}</p>
            </button>
          )}
          {/* The Store rows carry their own blurbs, so ours shows only until they do. */}
          {(!seedActivated || !hostBody) && (
            <>
              <h2 className="text-sm font-bold tracking-label text-ink">{selectedSeed.title}</h2>
              <p className="mt-1 text-xs text-muted">{selectedSeed.description}</p>
            </>
          )}
          {!seedActivated && (
            <button
              onClick={() => { selectedSeed.onActivate(); if (hubId) reveal(hubId); }}
              title="Keep this node in the brain for good"
              className="mt-3 border border-ink bg-ink px-3 py-1.5 text-xs font-bold text-paper"
            >
              Activate
            </button>
          )}
        </div>
        )}
        {seedActivated && hostBody && <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{hostBody}</div>}
        {/* Quickstart: the agent mirrors the source into nodes around this master. The
            embedded dock below picks the question up, shows the run, and hands the reply
            to the Chat tab; onSent refetches the graph so the new nodes glow in. */}
        {seedActivated && selectedSeed.connected && selectedSeed.quickstart && (
          <div className="shrink-0 border-t border-ink px-4 py-3">
            <button
              onClick={() => askChat(`${selectedSeed.quickstart}\n\nLink every node you create to the brain node "${panelNode.title}" (id ${panelNode.id}) of this workspace's brain.`)}
              title="Let the agent fill this node's surroundings from the source"
              className="block border border-ink bg-ink px-3 py-1.5 text-xs font-bold text-paper"
            >
              ⚡ Quickstart →
            </button>
          </div>
        )}
      </div>
    ) : (
      /* The host's body for this node (the Store, a tab master's compact tab view), in place of the memory. */
      hostBody && <div className={`flex ${sideCls} min-h-0 flex-col overflow-hidden [view-transition-name:tab-panel]`}>{hostBody}</div>
    )}

    {!hostBody && !selectedSeed && panelNode &&
      (panelNode.id.startsWith('usr-') ? (
        <NodeEditor key={panelNode.id} node={panelNode} onSave={saveNode} className={sideCls} />
      ) : (
        <button
          onClick={() => setReading(true)}
          title="Read the full memory"
          className={`flex ${sideCls} flex-col items-start gap-1 overflow-y-auto px-4 py-3 text-left hover:bg-elevated`}
        >
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-label text-muted">{panelNode.category}</span>
            <span className="shrink-0 text-[11px] text-faint underline">Read it →</span>
          </div>
          <span className="text-xs font-bold text-ink">{panelNode.title}</span>
          <p className="text-xs leading-5 text-muted">{panelNode.content.split('\n\n')[0]}</p>
        </button>
      ))}

    {!hostBody && multiSelectedIds && multiSelectedIds.length > 1 && (
      <div className={`flex ${sideCls} flex-col gap-1 overflow-y-auto px-4 py-3`}>
        <span className="text-[10px] uppercase tracking-label text-muted">
          {multiSelectedIds.length} nodes selected
        </span>
        <ul className="mt-1 flex flex-col gap-0.5">
          {multiSelectedIds.map((id) => {
            const n = renderNodes.find((x) => x.id === id);
            return (
              <li key={id} className="text-xs leading-5 text-ink">
                · {n?.title ?? id}
              </li>
            );
          })}
        </ul>
      </div>
    )}
    </>
  );

  return (
    <div
      className={
        // view-transition-name: the box that morphs Overview → Chat pane (see
        // core/lib/viewTransition.ts). Only ever one BrainCard rendered at a time.
        pane
          ? 'flex h-full min-h-0 w-full flex-col bg-paper [view-transition-name:brain-graph]'
          // Desktop: chat column | brain column. Phone: the same stack as before (the chat
          // is last in the DOM, md:order-first only moves it once there is room beside it).
          : 'flex h-[75dvh] min-h-[36rem] flex-col border border-ink bg-paper shadow-card md:flex-row [view-transition-name:brain-graph]'
      }
    >
      <div className="flex min-h-0 min-w-0 flex-[3] flex-col md:flex-1">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-ink px-3 py-2">
          <span className="truncate text-[11px] uppercase tracking-label text-ink">
            {isCompanyBrain
              ? source.features.companyLabel
              : isMyBrain
                ? 'My Brain'
                : `${employees.find((e) => e.id === brainId)?.name ?? source.features.memberNoun} — Brain`}{' '}
            · {nodes.length} node{nodes.length === 1 ? '' : 's'} · {edges.length} link
            {edges.length === 1 ? '' : 's'}
            {brainUpdated && ` · updated ${formatRelativeTime(brainUpdated)}`}
          </span>
          <div className="flex items-center gap-2.5">
            <select
              value={brainId}
              onChange={(e) => {
                if (e.target.value === '__create__') {
                  setShowCreateBrain(true);
                  return;
                }
                switchBrain(e.target.value);
              }}
              title="Which brain to view — the company's, a synced employee's, or a custom context"
              className="border border-ink bg-paper px-2 py-1 text-[11px] text-ink focus:outline-none"
            >
              <option value="company">{source.features.companyLabel}</option>
              {source.features.myBrainId && <option value={source.features.myBrainId}>My brain</option>}
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
              {customBrains.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
              {source.features.createBrain && <option value="__create__">+ Create a new brain…</option>}
            </select>
            {notice && <span className="text-[11px] text-muted">{notice}</span>}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="search…"
              title="Search nodes — Enter cycles matches, Esc clears"
              className="w-28 border border-ink bg-paper px-2 py-1 text-[11px] text-ink placeholder:text-faint focus:outline-none"
            />
            {query.trim() && (
              <span className="text-[10px] text-faint">
                {matches.length} hit{matches.length === 1 ? '' : 's'}
              </span>
            )}
            <span className="hidden text-[10px] text-faint sm:inline">grab to pan · ctrl+scroll to zoom</span>
            <div ref={exportMenuRef} className="relative">
              <button
                onClick={() => setShowExportMenu((v) => !v)}
                disabled={nodes.length === 0}
                aria-haspopup="menu"
                aria-expanded={showExportMenu}
                title="Export this brain"
                className={`border border-ink px-2.5 py-1 text-[11px] tracking-wide ${
                  nodes.length === 0
                    ? 'cursor-default bg-elevated text-muted'
                    : 'bg-paper text-ink hover:bg-ink hover:text-paper'
                }`}
              >
                ⇩ Export
              </button>
              {showExportMenu && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-30 mt-1 w-36 border border-ink bg-paper shadow-card"
                >
                  <button
                    role="menuitem"
                    onClick={() => handleExport('json')}
                    className="block w-full px-3 py-1.5 text-left text-[11px] text-ink hover:bg-elevated"
                  >
                    as JSON
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => handleExport('md')}
                    className="block w-full border-t border-hairline px-3 py-1.5 text-left text-[11px] text-ink hover:bg-elevated"
                  >
                    as Markdown
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* The selection panel stacks UNDER the graph, never beside it: a side column
            leaves the graph ~300px, the auto-fit floors at minScale and density
            clustering swallows the whole brain into one blob. */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
          <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-ink py-2">
            <RailButton
              icon="⤢"
              label="Fit"
              title="Fit the whole graph to the panel"
              onClick={() => graphRef.current?.resetView()}
            />
            <RailButton
              icon="▦"
              label="Density"
              title="Density heatmap — where nodes are visually crowded together"
              active={showDensity}
              onClick={() => setShowDensity((v) => !v)}
            />
            {isEditableBrain && (
              <>
                <div className="my-1 h-px w-6 bg-hairline" />
                <RailButton
                  icon="⤨"
                  label={reorganizing ? 'Reorganizing…' : 'Reorganize'}
                  title="Lay the brain out as its priority tree — hub, Store apps, their masters, then memories (persists the new positions)"
                  disabled={reorganizing || nodes.length === 0}
                  onClick={handleReorganize}
                />
                <RailButton
                  icon="⤵"
                  label={reducing ? 'Merging…' : 'Merge'}
                  title="Fold the least-used learned nodes into their nearest neighbours (nothing is deleted; curated + central nodes are kept)"
                  disabled={reducing || nodes.length === 0}
                  onClick={handleReduce}
                />
                {source.features.sync && (
                  <RailButton
                    icon="⇄"
                    label={syncing ? 'Syncing…' : 'Sync database'}
                    title="Mirror every tab into the brain as a master node, as a starting point"
                    disabled={syncing}
                    onClick={handleSyncDatabase}
                  />
                )}
                <RailButton
                  icon="+"
                  label={addingNode ? 'Adding…' : 'Add node'}
                  title="Add a node by hand and set its goal — a tool, a tab, or context"
                  disabled={addingNode}
                  onClick={handleAddNode}
                />
                {source.features.commits && (
                  <RailButton
                    icon="🕓"
                    label="History"
                    title="The commit history behind this brain — each employee push lands here as a commit on main"
                    active={showHistory}
                    onClick={() => setShowHistory((v) => !v)}
                  />
                )}
              </>
            )}
          </div>
          {/* onMouseLeave refolds the satellites on the way out — but not while a
              source's panel is open, or reaching for it would collapse them. */}
          <div
            data-tour="brain-graph"
            className="relative min-w-0 flex-1 overflow-hidden"
            onMouseLeave={() => { if (!holdRevealed) setLastRevealed(null); }}
          >
            {(seedMode || folded) && (
              <p className="pointer-events-none absolute bottom-2 left-3 z-10 text-[11px] text-faint">
                {revealedIds.size > 0 ? 'Hover a child, click it to activate it. Click the core for the whole Store.' : 'Hover the core, or an app, to see what it can connect to.'}
              </p>
            )}
            {showHistory && isCompanyBrain && source.features.commits ? (
              <BrainTimeline branch="main" />
            ) : brainError && nodes.length === 0 ? (
              <div className="p-4 text-xs text-muted">
                The brain is unavailable: {brainError}.
              </div>
            ) : brainLoading && nodes.length === 0 ? (
              <div className="p-4 text-xs text-faint">Loading the graph…</div>
            ) : nodes.length === 0 && !seedMode ? (
              <div className="p-4 text-xs text-faint">
                {isCompanyBrain
                  ? source.features.emptyCompanyHint
                  : isMyBrain
                    ? 'Your brain is empty. Connect it in Settings, then your nff-brain extension or CLI syncs it here — mark a node shared to publish it to the company brain.'
                    : (() => {
                      // Honest empty state: "never synced" and "synced, but the
                      // push was empty" are different problems for the admin.
                      const emp = employees.find((e) => e.id === brainId);
                      return emp?.lastSyncedAt
                        ? `${emp.name} last synced ${new Date(emp.lastSyncedAt).toLocaleString()}, but the push was empty (${emp.nodeCount} nodes) — their extension had no brain to send (unpaired, or everything marked private).`
                        : source.features.memberSyncHint;
                      })()}
              </div>
            ) : (
              // One element for both the seed graph and the real one: ids match
              // (tab-<rail>, tool-<id>), so the first sync morphs in place.
              <BrainGraph
                ref={graphRef}
                nodes={graphNodes}
                edges={graphEdges}
                selectedId={selectedId}
                hoveredId={hoveredId}
                onSelect={handleSelect}
                onMultiSelect={handleMultiSelect}
                multiSelectedIds={multiSelectedSet}
                onExpand={handleExpand}
                onHover={handleHover}
                // The overview page scrolls: a bare wheel must move the PAGE, not the graph.
                wheelZoom="modifier"
                // Seed mode borrows the search dimming: everything off the focus set greys out.
                matchedIds={seedMode ? (seedVis?.focusIds ?? null) : matchedIds}
                hiddenKeys={storeHidden}
                hubLogoUrl={tenant?.logoUrl ?? null}
                showSpine={showSpine}
                showDensity={showDensity}
                glow={seedMode ? seedGlow : glow}
                collapsedIds={seedMode ? seedVis?.collapsedIds : seedRevealed || upgrade.size === 0 ? undefined : upgrade}
                fade={seedMode ? undefined : upgradeFade}
                revealed={revealedIds}
                markerId={markerId}
              />
            )}
          </div>
          </div>

          {/* Always-mounted shell: the panel's share of the column eases up from 0, so the
              graph/panel separator slides and usePanZoom's ResizeObserver re-fits per frame.
              flex-basis, not height: a percentage height against a flex item is not
              reliably definite, a basis against the column's main size always is. */}
          <div
            data-tour="brain-side-panel"
            className="shrink-0 grow-0 overflow-hidden transition-[flex-basis] duration-300 ease-out"
            style={{ flexBasis: sideOpen ? '40%' : '0%' }}
            onTransitionEnd={() => { if (!sideOpen) setStickyId(null); }} // unmount once hidden
          >
            <div className="flex h-full w-full border-t border-ink">{sidePanel}</div>
          </div>
        </div>
      </div>

      {reading && selectedNode && (
        <MemoryModal
          node={selectedNode}
          nodes={renderNodes}
          onSelect={setSelectedId}
          onClose={() => setReading(false)}
        />
      )}

      {showCreateBrain && (
        <CreateBrainModal
          onClose={() => setShowCreateBrain(false)}
          onCreated={(id) => {
            setShowCreateBrain(false);
            switchBrain(id);
          }}
          createCustomBrain={createCustomBrain}
        />
      )}

      {/* The chat half. A flex COLUMN, not a plain block: the chat fills this
          height and scrolls inside itself — without it a long transcript grows
          the card and the whole Overview page scrolls instead. */}
      {!pane && chat && (
        <div className="flex min-h-0 flex-[2] flex-col border-t border-ink md:order-first md:h-full md:w-1/2 md:flex-none md:border-r md:border-t-0">
          {chat}
        </div>
      )}
    </div>
  );
}
