// nff-admin's left nav rail (lucide icons, header/nav/spacer/footer stack) in
// the admin's inverted ink/paper palette. Desktop: retracted 48px icon rail
// that expands to 180px on hover — the in-flow spacer stays 48px and the panel
// overlays the content (z-30) so hovering never reflows charts/tables.
// nff-admin has no router — its App.tsx owns useState<Tab> and this component
// is a pure view over it. Groups with >1 tab land on tabs[0] and get a
// SubTabBar in the content column (see nff-admin/src/App.tsx).
//
// The rail. The dashboard feeds it its own sections (src/nav.tsx) plus the brand/footer
// slots; the defaults below are the pinned Settings group and the two always-on tabs.
//
// z-index ladder: 30 this rail's hover overlay / 40 FeatureProgressCard /
// 50 ChatDock+toasts / 59-60 ChatTab conversations drawer / 70 this app
// drawer (must cover ChatTab's).

import type { ReactNode } from 'react';
import capybara from '../assets/capybara.ico';
import { CircleUser, Settings, type LucideIcon } from 'lucide-react';
import { TAB_GROUP_ICONS } from '../lib/tabIcons';

export type Tab = 'overview' | 'chat' | 'settings' | 'settings-store';

// Generic over the tab-id type: nff-admin's nav uses this module's `Tab`
// (the default); nff-app's dashboard feeds the same rail with its own TabId.
export interface NavGroup<T extends string = Tab> {
  id: string;
  label: string;
  icon: LucideIcon;
  // `heading` starts a labeled section above that tab in the settings panel.
  tabs: Array<{ id: T; label: string; heading?: string }>;
}

export interface NavSection<T extends string = Tab> {
  heading?: string;
  groups: NavGroup<T>[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    // Pinned pair: Overview (the default tab) + Chat, divider below.
    groups: [
      { id: 'overview', label: 'Overview', icon: TAB_GROUP_ICONS.overview, tabs: [{ id: 'overview', label: 'Overview' }] },
      { id: 'chat', label: 'Chat', icon: TAB_GROUP_ICONS.chat, tabs: [{ id: 'chat', label: 'Chat' }] },
    ],
  },
];

const NAV_GROUPS: NavGroup[] = NAV_SECTIONS.flatMap((s) => s.groups);

// Kept OUT of NAV_GROUPS on purpose: Settings governs the app itself, not a content
// area, so it is pinned above the account footer.
export const SETTINGS_GROUP: NavGroup = {
  id: 'settings',
  label: 'Settings',
  icon: Settings,
  tabs: [
    // Store leads: it's host-only (filtered out standalone), and the hosted
    // Settings panel wants it right under the App settings entry.
    { id: 'settings-store', label: 'Store', heading: 'App' },
    { id: 'settings', label: 'App settings' },
  ],
};

// ── View ───────────────────────────────────────────────────────────────────
// What the shell filters the nav by: `hiddenGroups` carries the user's Store
// removals (group ids), `hiddenTabs` the same at tab granularity, and `store`
// unlocks the settings-store tab for a shell that runs a Store.
export interface HostView {
  hiddenGroups: string[];
  // Store removals at TAB granularity (e.g. Dev's Repo/Containers/Supabase).
  hiddenTabs?: string[];
  // A shell that runs its OWN Store (nff-admin) sets this to unlock the
  // settings-store tab.
  store?: boolean;
}

export const STANDALONE: HostView = { hiddenGroups: [] };

const STORE_ONLY = new Set<string>(['settings-store']);

// Store keys that own a TAB rather than a nav group (storeCatalog.tsx's
// `settingsTab` entries): hiding the key hides the tab, so an add-on with no
// group of its own still disappears when switched off in the Store.
const STORE_KEY_OF_TAB: Record<string, string> = {};

// Active-surface fill: --brand-accent when a host sets it on :root (nff-app's
// TenantContext does, on branded domains), stock ink otherwise.
export const ACCENT_FILL = { background: 'var(--brand-accent, var(--color-ink))', borderLeftColor: 'var(--brand-accent, var(--color-ink))' } as const;

export function visibleTabs<T extends string>(g: NavGroup<T>, v: HostView): NavGroup<T>['tabs'] {
  let tabs = v.store ? g.tabs : g.tabs.filter((t) => !STORE_ONLY.has(t.id));
  tabs = tabs.filter((t) => {
    const key = STORE_KEY_OF_TAB[t.id];
    return !key || !v.hiddenGroups.includes(key);
  });
  return v.hiddenTabs?.length ? tabs.filter((t) => !v.hiddenTabs!.includes(t.id)) : tabs;
}

function visibleGroup<T extends string>(g: NavGroup<T>, v: HostView): boolean {
  return visibleTabs(g, v).length > 0 && !v.hiddenGroups.includes(g.id);
}

export const ALL_GROUPS = [...NAV_GROUPS, SETTINGS_GROUP];

export function groupOf(tab: Tab): NavGroup {
  return ALL_GROUPS.find((g) => g.tabs.some((t) => t.id === tab))!;
}

export function tabLabel(tab: Tab): string {
  for (const g of ALL_GROUPS) {
    const hit = g.tabs.find((t) => t.id === tab);
    if (hit) return hit.label;
  }
  return '';
}

export function Sidebar<T extends string = Tab>({
  activeGroupId,
  onChange,
  userEmail,
  onSignOut,
  open,
  onClose,
  view = STANDALONE,
  sections = NAV_SECTIONS as NavSection<T>[],
  pinned = [SETTINGS_GROUP] as NavGroup<T>[],
  brand,
  footer: footerSlot,
}: {
  // The highlighted rail group — the caller computes it (the active tab's group).
  activeGroupId: string;
  onChange: (tab: T) => void;
  // Default footer only (email + Sign out); a `footer` slot replaces both.
  userEmail?: string;
  onSignOut?: () => void;
  open: boolean;
  onClose: () => void;
  view?: HostView;
  // A shell that DECLARES its own nav (nff-admin's App, nff-app's nav.tsx)
  // passes its sections; default = this module's NAV_SECTIONS, so existing
  // callers are unchanged. Ceiling: groupOf/visibleTabs/tabLabel/ALL_GROUPS
  // still read the module constants — a caller with custom sections computes
  // its own group lookup.
  sections?: NavSection<T>[];
  // Groups pinned above the footer (default: Settings).
  pinned?: NavGroup<T>[];
  // Rail header: a logo (or the name's initial collapsed) + the name on hover.
  // Default = the nff-admin mark; `null` keeps the strip but leaves it empty (nff-app).
  brand?: { name: string; logoUrl?: string | null } | null;
  // Replaces the default email + Sign out footer.
  footer?: ReactNode;
}) {
  const name = brand?.name ?? 'nff-admin';
  const showHeader = brand !== null;
  // The (view-filtered) sections, each group carrying its own click action.
  const railSections = sections.map((section) => ({
    heading: section.heading,
    groups: section.groups
      .filter((g) => visibleGroup(g, view))
      .map((g) => ({ id: g.id, label: g.label, icon: g.icon, go: () => onChange(visibleTabs(g, view)[0].id) })),
  })).filter((section) => section.groups.length > 0);

  // overflow-x-hidden: the collapsed rail keeps the (invisible) section
  // headings laid out at full width — without it they'd spawn a horizontal
  // scrollbar inside the 48px rail.
  const nav = (touch: boolean) => (
    <nav className="flex flex-1 flex-col overflow-x-hidden overflow-y-auto pt-1 [scrollbar-width:none]">
      {railSections.map((section, i) => (
        <div key={section.heading ?? (i === 0 ? 'first' : 'pinned')}>
          {/* Hard rule only under the first un-headed section; headings carry
              the later section breaks on their own. */}
          {i === 1 && <div className="mt-1 border-t border-ink" />}
          {section.heading && (
            <div
              className={`whitespace-nowrap px-3 uppercase tracking-widest text-faint ${
                touch
                  ? 'pt-3.5 pb-1.5 text-[11px]'
                  : 'pt-3 pb-1 text-[10px] opacity-0 group-hover/rail:opacity-100'
              }`}
            >
              {section.heading}
            </div>
          )}
          {section.groups.map((g) => (
            <button
              key={g.id}
              title={g.label}
              data-tour={`nav-${g.id}`}
              onClick={() => {
                g.go();
                if (touch) onClose();
              }}
              className={`flex w-full items-center gap-2 border-l-[3px] px-3 text-left ${
                touch ? 'py-2.5 text-sm' : 'h-8 text-[13px]'
              } ${
                activeGroupId === g.id
                  ? 'border-ink bg-ink font-bold text-paper'
                  : 'border-transparent text-muted'
              }`}
              style={activeGroupId === g.id ? ACCENT_FILL : undefined}
            >
              <g.icon size={16} strokeWidth={1.75} className="shrink-0 opacity-70" />
              <span className={touch ? '' : 'hidden whitespace-nowrap group-hover/rail:inline'}>
                {g.label}
              </span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );

  // Pinned above the footer, not in `nav` — see SETTINGS_GROUP's comment.
  const pinnedButton = (g: NavGroup<T>, touch: boolean) =>
    !visibleGroup(g, view) ? null : (
    <button
      key={g.id}
      title={g.label}
      data-tour={`nav-${g.id}`}
      onClick={() => {
        onChange(visibleTabs(g, view)[0].id);
        if (touch) onClose();
      }}
      className={`flex w-full items-center gap-2 border-t border-t-ink border-l-[3px] px-3 text-left ${
        touch ? 'py-2.5 text-sm' : 'h-8 text-[13px]'
      } ${activeGroupId === g.id ? 'border-l-ink bg-ink font-bold text-paper' : 'border-l-transparent text-muted'}`}
      style={activeGroupId === g.id ? ACCENT_FILL : undefined}
    >
      <g.icon size={16} strokeWidth={1.75} className="shrink-0 opacity-70" />
      <span className={touch ? '' : 'hidden whitespace-nowrap group-hover/rail:inline'}>
        {g.label}
      </span>
    </button>
  );

  // Desktop uses `invisible` (not `hidden`) so the footer keeps the same
  // height collapsed — otherwise the Settings row above it jumps on hover.
  // A `footer` slot stays visible collapsed (32px wide: icon-only rows, labels
  // on hover — see nff-app's railFooter) and owns its own collapsed look.
  const footer = (touch: boolean) => (
    <div className={`border-t border-ink py-2.5 ${footerSlot ? 'px-2' : 'px-3'}`}>
      {footerSlot ? (
        footerSlot
      ) : (
        <>
          <div className="mb-2 flex items-center gap-1.5 text-xs text-faint">
            <CircleUser size={14} strokeWidth={1.75} className="shrink-0 opacity-70" />
            <span className={`truncate ${touch ? '' : 'invisible group-hover/rail:visible'}`}>
              {userEmail}
            </span>
          </div>
          <button
            onClick={onSignOut}
            className={`w-full whitespace-nowrap border border-ink px-2 py-1 text-xs text-ink hover:bg-ink hover:text-paper ${
              touch ? '' : 'invisible group-hover/rail:visible'
            }`}
          >
            Sign out
          </button>
        </>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop rail: 48px spacer holds the layout; the panel overlays and
          widens on hover so the content column never reflows. */}
      {/* view-transition-name: its own group, stacked above the sub-tab column, so that
          column slides in from UNDER the rail during a view transition (theme.css). A named
          element is a stacking context, so z-10 keeps the hover-expanded rail panel above the
          (later, also named) sub-tab column at rest too. */}
      <div className="relative z-10 hidden h-full w-12 shrink-0 md:block [view-transition-name:side-rail]">
        <div className="group/rail absolute inset-y-0 left-0 z-30 flex w-12 flex-col overflow-hidden border-r border-ink bg-paper transition-[width] duration-150 hover:w-[180px]">
          {/* Header strip — always the same height so both apps' rails line
              up; `brand === null` leaves it empty (the personalisation slot). */}
          <div className="whitespace-nowrap border-b border-ink px-3 pb-2 pt-2.5">
            <span className="flex h-5 items-center gap-2 text-sm font-bold tracking-label text-ink">
              {showHeader && (brand?.logoUrl ? (
                <img src={brand.logoUrl} alt="" className="h-5 w-auto shrink-0" />
              ) : (
                <img src={capybara} alt="" className="h-5 w-5 shrink-0 group-hover/rail:hidden" />
              ))}
              {showHeader && <span className="hidden group-hover/rail:inline">{name}</span>}
            </span>
          </div>
          {nav(false)}
          {pinned.map((g) => pinnedButton(g, false))}
          {footer(false)}
        </div>
      </div>

      {/* Phone nav drawer */}
      {open && (
        <div className="fixed inset-0 z-[70] md:hidden">
          <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-ink bg-paper">
            <div className="flex items-center justify-between border-b border-ink px-4 py-2">
              <span className="flex items-center gap-2 text-sm font-bold tracking-label text-ink">
                {showHeader && brand?.logoUrl && <img src={brand.logoUrl} alt="" className="h-5 w-auto" />}
                {showHeader && name}
              </span>
              <button
                onClick={onClose}
                aria-label="Close navigation"
                className="flex h-10 w-10 items-center justify-center text-ink"
              >
                ✕
              </button>
            </div>
            {nav(true)}
            {pinned.map((g) => pinnedButton(g, true))}
            {footer(true)}
          </div>
        </div>
      )}
    </>
  );
}
