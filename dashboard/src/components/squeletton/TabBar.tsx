import { DEV_MODE } from '../../lib/devMode';

// The company's own apps and the Vercel add-on left for nff-admin in Oct 2026 (techforge
// docs/handoff-app-admin.md): this dashboard is the fleet product only.
export type TabId = 'overview' | 'agent-management' | 'dashboard' | 'crash' | 'ota' | 'groups' | 'enrollment' | 'hardware' | 'github' | 'brain' | 'policy' | 'builder' | 'device-detail' | 'security' | 'code' | 'follow-us' | 'settings';

export type GroupId = 'overview' | 'agents' | 'dashboard' | 'device-groups' | 'deploy' | 'code' | 'github' | 'crash' | 'enrollment' | 'hardware' | 'security' | 'follow-us' | 'settings' | 'builder';
export interface NavGroup { id: GroupId; label: string; icon: string; defaultTab?: TabId; tabs: { id: TabId; label: string }[]; }

// Canonical nav order. Keep this the single source of truth for tab ordering.
export const NAV_GROUPS: NavGroup[] = [
  { id: 'overview',   label: 'Overview',  icon: '⊡', tabs: [ { id: 'overview', label: 'Overview' } ] },
  { id: 'dashboard',  label: 'Dashboard', icon: '▦', tabs: [ { id: 'dashboard', label: 'Dashboard' } ] },
  // Device groups sit with the fleet (the shell's My Physical Devices entry),
  // not with Deploy.
  { id: 'device-groups', label: 'Device groups', icon: '⊟', tabs: [ { id: 'groups', label: 'Device groups' } ] },
  { id: 'agents',     label: 'Agents',    icon: '⚙', tabs: [
    { id: 'agent-management', label: 'Management' }, { id: 'brain', label: 'Brain' }, { id: 'policy', label: 'Policy' } ] },
  { id: 'enrollment', label: 'Enroll',    icon: '⊞', tabs: [ { id: 'enrollment', label: 'Enroll' } ] },
  // Hardware actions (flash / WiFi / guided deploy / break-and-heal), parked here after
  // leaving the brain's Devices side panel — final home still to be decided.
  { id: 'hardware',   label: 'Hardware',  icon: '⚡', tabs: [ { id: 'hardware', label: 'Hardware' } ] },
  // Code and GitHub are siblings under the shell's Dev entry (with Deploy), not nested.
  { id: 'code',       label: 'Code',      icon: '< >', tabs: [ { id: 'code', label: 'Code' } ] },
  { id: 'github',     label: 'GitHub',    icon: '◈',   tabs: [ { id: 'github', label: 'GitHub' } ] },
  { id: 'deploy',     label: 'Deploy',    icon: '⑂', defaultTab: 'ota', tabs: [
    { id: 'ota', label: 'Releases' } ] },
  { id: 'crash',      label: 'Crashes',   icon: '✕', tabs: [ { id: 'crash', label: 'Crashes' } ] },
  // Builder is its own separate tab. Clicking it opens a fresh feature-builder
  // interview (handled in App's tab-change dispatch).
  { id: 'builder',    label: 'Builder',   icon: '⚒', tabs: [ { id: 'builder', label: 'Builder' } ] },
  // Dev-only: the vulnerability-tree Security tab is hidden in normal builds.
  ...(DEV_MODE ? [{ id: 'security' as GroupId, label: 'Security', icon: '🛡', tabs: [ { id: 'security' as TabId, label: 'Security' } ] }] : []),
  // Usage + Billing are deliberately NOT here: they are account-scoped (they span every project
  // you belong to), so they live in AccountSettingsModal, not in this project-scoped sidebar.
  { id: 'follow-us',  label: 'Follow us', icon: '✦', tabs: [ { id: 'follow-us', label: 'Follow us' } ] },
  { id: 'settings',   label: 'Settings',  icon: '⛭', tabs: [ { id: 'settings', label: 'Settings' } ] },
];

// `?tab=<id>` deep link (used by the GitHub App install callback to land back on the GitHub
// tab). Only ids that exist in the nav are honoured; anything else falls back to the default.
export function tabFromSearch(search: string): TabId | null {
  const id = new URLSearchParams(search).get('tab');
  if (!id) return null;
  return NAV_GROUPS.some(g => g.tabs.some(t => t.id === id)) ? (id as TabId) : null;
}

export function groupOf(tab: TabId): GroupId {
  if (tab === 'device-detail') return 'dashboard'; // device detail lives under Dashboard
  if (tab === 'builder') return 'builder';          // Builder is its own nav group below Enroll
  if (tab === 'security') return 'security';        // dev-only group, may be absent from NAV_GROUPS
  return NAV_GROUPS.find(g => g.tabs.some(t => t.id === tab))!.id;
}
