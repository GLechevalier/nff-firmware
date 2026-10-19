import { Code, Cpu, LayoutDashboard, Settings } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { NavGroup as RailGroup, NavSection } from './core/components/Sidebar';
import type { BrainApp } from './core/overview/lib/brainMasters';
import type { GroupId, NavGroup, TabId } from './components/squeletton/TabBar';

// The rail nff-app declares — the same shared Sidebar nff-admin renders, fed
// with THIS app's arrangement (nff-admin/src/nav.tsx is the sibling). A rail
// group bundles the dashboard's NAV_GROUPS (TabBar.tsx) it contains: the rail
// is the global nav, the SubTabBar panel lists the members. Visibility
// (source lenses, tenant hiding, Store removals) is decided on NAV_GROUPS by App;
// railSections() just projects whatever survived.
interface RailEntry {
  id: string;
  label: string;
  icon: LucideIcon;
  members: GroupId[];
  section?: 'Product' | 'Business';
  // Panel label per member (default: the member group's own label).
  labels?: Partial<Record<GroupId, string>>;
  // A member that opens a labelled group inside the panel (the small uppercase
  // text SubTabBar renders above it, like the rail's section headings). The
  // heading survives that member being hidden: it lands on the next visible one.
  headings?: Partial<Record<GroupId, string>>;
}

const RAIL: RailEntry[] = [
  // Pinned pair on top (no heading), divider below — nff-admin's convention.
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, members: ['overview'] },
  // Product lenses below appear once their source is connected (App's
  // hiddenGroupIds); the way in is the brain's Store nodes on Overview.
  {
    id: 'devices', label: 'Devices', icon: Cpu, section: 'Product',
    members: ['dashboard', 'device-groups', 'enrollment', 'hardware', 'crash'],
    labels: { dashboard: 'Fleet', 'device-groups': 'Device groups', enrollment: 'Enroll', hardware: 'Hardware', crash: 'Crashes' },
  },
  // Source = where the code lives; Deploy = the device OTA it ships to.
  {
    id: 'dev', label: 'Dev', icon: Code, section: 'Product',
    members: ['code', 'github', 'deploy'],
    labels: { deploy: 'Devices' },
    headings: { code: 'Source', deploy: 'Deploy' },
  },
];

// Pinned above the footer, like nff-admin's Settings.
export const SETTINGS_RAIL: RailGroup<TabId> = {
  id: 'settings', label: 'Settings', icon: Settings, tabs: [{ id: 'settings', label: 'App settings' }],
};

/** The rail group a dashboard group belongs to ('settings' for the pinned one). */
export function railGroupOf(group: GroupId): string {
  return RAIL.find((r) => r.members.includes(group))?.id ?? group;
}

/** Every dashboard group sharing a rail entry with `group` (itself alone if it has no rail entry) —
 * what a tab panel's ⤢ reveals, so the whole sub-tab column comes with the tab. */
export function railMembersOf(group: GroupId): GroupId[] {
  return RAIL.find((r) => r.members.includes(group))?.members ?? [group];
}

/** The brain graph's tab masters (deriveMasters): one per rail entry (Overview is the frame
 * around the brain and the chat it holds — not data in it), so the hub's Store children —
 * Devices / Dev (brainMasters.ts BRAIN_APPS) — are always real spokes. `app` = the tree
 * rule's parent: each app is its own. */
export const BRAIN_TABS: Array<{ id: string; label: string; app: BrainApp }> = RAIL.filter((r) => r.id !== 'overview').map(({ id, label }) => ({
  id, label, app: id as BrainApp,
}));

/** Rail entries whose every member is hidden — what dims their tab master on the brain graph. */
export function hiddenRailIds(hidden: readonly string[]): string[] {
  return RAIL.filter((r) => r.members.every((m) => hidden.includes(m))).map((r) => r.id);
}

/** Projects the currently visible dashboard groups (in NAV_GROUPS order) onto the rail. */
export function railSections(visible: NavGroup[]): NavSection<TabId>[] {
  const groups = RAIL.flatMap((r) => {
    let pending: string | undefined;
    const tabs = r.members.flatMap((m) => {
      pending = r.headings?.[m] ?? pending;
      const g = visible.find((v) => v.id === m);
      if (!g) return [];
      // A multi-view member lists every view; a single-view
      // member is one panel entry, labelled for the panel.
      const own: NavGroup['tabs'] = g.tabs.length > 1
        ? g.tabs
        : [{ id: g.defaultTab ?? g.tabs[0].id, label: r.labels?.[m] ?? g.label }];
      const heading = pending;
      pending = undefined;
      return own.map((t, i) => (i === 0 && heading ? { ...t, heading } : t));
    });
    return tabs.length ? [{ id: r.id, label: r.label, icon: r.icon, tabs, section: r.section }] : [];
  });
  const section = (heading?: 'Product' | 'Business') =>
    groups.filter((g) => g.section === heading).map(({ section: _s, ...g }) => g);
  return [
    { groups: section(undefined) },
    { heading: 'Product', groups: section('Product') },
    { heading: 'Business', groups: section('Business') },
  ].filter((s) => s.groups.length > 0);
}
