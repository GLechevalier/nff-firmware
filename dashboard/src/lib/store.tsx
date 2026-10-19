import { DevicesIcon, GitHubIcon, CursorIcon, DeployIcon } from '../core/components/BrandIcons';
import type { StoreAdapter } from '../components/squeletton/StoreSection';
import { adminStoreEntries, devSubApp, DEV_STORE_KEY, type AdminStoreEntry } from '../core/storeCatalog';
import { BRAIN_TOOL_CATALOG } from '../core/overview/lib/toolCatalog';

// Settings → Store: the toggleable parts of the customer app. Essentials
// (Overview, Chat, Settings) are never listed. The device nav groups condense
// into ONE "Devices" switch, the dev ones into ONE "Dev" switch with an
// expandable tool list; the rest is THE add-on catalog (src/core/storeCatalog.tsx).
export const DEVICES_GROUP_IDS = ['dashboard', 'device-groups', 'enrollment', 'hardware', 'crash'];
// The Dev sub-app's real nav groups (the RAIL 'dev' entry's members).
export const DEV_GROUP_IDS = ['github', 'code', 'deploy'];
// Dev tools that ship OFF: for these the stored key means SHOWN, not
// hidden (inverted below), so switching the Dev app on gives GitHub only and
// an untouched account starts the same way. Everything else: missing = shown.
const DEV_OPT_IN = ['code', 'deploy'];
// Synthetic Store key — not a real nav group id, it never reaches the sidebar
// filter (DEV_STORE_KEY is the shared one, from storeCatalog).
export const DEVICES_STORE_KEY = 'devices-app';

// A brain master node → the Store key its side panel opens on. RULE: the hub
// (whole Store), its Dev child (its app row) and every tool master with a Store
// row (its own row, unfolded: switch + settings). Devices opens no Store row
// (its hardware actions live in its Hardware tab).
const TAB_FOCUS: Record<string, string> = { dev: DEV_STORE_KEY };
/** The Store key a master node's panel should focus (null = not a Store node). */
export function storeFocusOf(sourceRef: unknown): string | null {
  const r = sourceRef as { kind?: string; tab?: string; tool?: string } | null | undefined;
  if (r?.kind === 'tab' && r.tab) return TAB_FOCUS[r.tab] ?? null;
  if (r?.kind === 'tool' && r.tool) {
    const key = BRAIN_TOOL_CATALOG.find((t) => t.id === r.tool)?.storeKey;
    // A key no row knows (docker's `dev`) would open the whole Store — stay null.
    return key && CATALOG.some((e) => e.key === key || e.tools?.some((t) => t.key === key)) ? key : null;
  }
  return null;
}

/** Stored hidden_parts → the nav-group ids that must actually be hidden
 * (DEV_OPT_IN keys are inverted). Used by both the sidebar filter and the
 * Store's own switches, so the two can never disagree. */
export function hiddenGroups(hidden: string[]): string[] {
  return [
    ...hidden.filter((k) => !DEV_OPT_IN.includes(k)),
    ...DEV_OPT_IN.filter((k) => !hidden.includes(k)),
  ];
}

const ADDONS = adminStoreEntries(false);

// The nav groups nff-app ships as real Dev tools; the Building… integrations
// come from the shared catalog. devSubApp files both by job.
const SHIPPED_DEV_TOOLS: AdminStoreEntry[] = [
  { key: 'code', label: 'Code', description: 'The firmware source browser and editor.', icon: <CursorIcon />, section: 'Write code' },
  { key: 'github', label: 'GitHub', description: 'Repos, branches, pull requests and Actions.', icon: <GitHubIcon />, section: 'Version control & CI',
    brainAdds: 'connected repos and their pipeline runs', ask: ['What shipped to canary this week?', 'Which commit broke the build?'] },
  { key: 'deploy', label: 'Deploy', description: 'Releases and OTA rollouts.', icon: <DeployIcon />, section: 'Build & ship',
    brainAdds: 'every rollout and the group it went to', ask: ['What version is the whole fleet on?'] },
];

const CATALOG: StoreAdapter['catalog'] = [
  { key: DEVICES_STORE_KEY, label: 'Devices', icon: <DevicesIcon />,
    brainAdds: 'devices, groups, crashes and rollouts', ask: ['Which devices crashed this week?', 'Is the canary group healthy?'] },
  devSubApp(ADDONS, SHIPPED_DEV_TOOLS),
  ...ADDONS.filter((e) => !e.section),
];

export function buildStore(
  hidden: string[],
  toggle: (key: string) => void,
  setParts: (hide: string[], show: string[]) => void,
): StoreAdapter {
  const off = hiddenGroups(hidden);
  const devicesInstalled = DEVICES_GROUP_IDS.every((id) => !off.includes(id));
  const devInstalled = DEV_GROUP_IDS.some((id) => !off.includes(id));
  return {
    catalog: CATALOG,
    // What the switches read: the resolved hidden set plus the synthetic app keys
    // when their sub-apps are entirely off.
    hidden: [
      ...off,
      ...(devicesInstalled ? [] : [DEVICES_STORE_KEY]),
      ...(devInstalled ? [] : [DEV_STORE_KEY]),
    ],
    toggle: (key) => {
      if (key === DEVICES_STORE_KEY) return setParts(devicesInstalled ? DEVICES_GROUP_IDS : [], devicesInstalled ? [] : DEVICES_GROUP_IDS);
      // Dev off: hide GitHub and drop the opt-in keys (= Code/Deploy off too).
      // Dev on: clear all three, which is exactly the GitHub-only default.
      if (key === DEV_STORE_KEY) return setParts(devInstalled ? ['github'] : [], DEV_GROUP_IDS);
      // A tool's own switch is a plain membership flip either way — inverted
      // keys flip the same, they just mean the opposite.
      return toggle(key);
    },
  };
}
