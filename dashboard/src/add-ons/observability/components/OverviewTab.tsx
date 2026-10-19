import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { BrainCard } from '../../../core/overview/components/BrainCard';
import { projectBrainSource } from '../../../core/overview/hooks/useProjectBrain';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import type { SourceStatus } from '../../../hooks/useSourceStatus';
import { ONBOARDING_MODE } from '../../../lib/onboardingMode';
import type { AdminBrainNode } from '../../../core/overview/hooks/useBrainGraph';
import type { Device } from '../../../types/device';

// The empty brain IS the onboarding: a lone blinking hub; hovering it pops the
// four Store apps out of it as satellites — Devices / Admin / Dev / Finance,
// the hub's children — dimmed until the pointer picks one. Clicking one opens
// it in the graph's side panel: what the app is for and an Activate button that
// keeps the node out for good, then that part of the Store (the host's
// `brain.nodePanel`, StorePanel in App.tsx — core never imports a feature),
// then — once a source of it is connected — Quickstart, which asks the agent
// to mirror the source into nodes around its master.
// Ids match deriveMasters' (`tab-<id>`, nav.tsx BRAIN_TABS) so the first sync
// morphs them in place; the panel keys off sourceRef, so it opens on the real
// masters too.
//
// Demo mode is the opposite story (lib/demoMode.ts): everything is already
// set up, and the page carries one button — `onSelfHealDemo` — that breaks a
// mock device and lets the agent heal it. App passes it only in that mode. `brain`
// carries BrainCard's host props: tab masters open their compact tab view (TabPanel)
// in the side column, and the running story focuses + marks the master it touches.

// Activated sources persist per workspace, same idiom as useOnboarding's seen flag.
const ACTIVATED_KEY = (projectId: string) => `nff.onboarding.v3.activated.${projectId}`;
function readActivated(projectId: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(ACTIVATED_KEY(projectId)) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function OverviewTab({
  onSelfHealDemo,
  demoLive = false,
  demoRunning = false,
  brain,
  chat,
  sources,
  devices,
}: {
  onSelfHealDemo?: () => void;
  demoLive?: boolean;    // a self-heal story is armed (the button's label)
  demoRunning?: boolean; // …and not done yet (button disabled)
  // BrainCard's host props: a tab master's compact tab view in the side column
  // (nodePanel), the story's focused master and its marker square.
  brain?: {
    nodePanel?: (node: AdminBrainNode) => ReactNode | null | undefined;
    focusId?: string | null;
    markerId?: string | null;
    // Store-off tab masters + their cascade — dims/merges them into the hub
    // (BrainGraph's own offIds/storeCollapseIds). Same list App.tsx's
    // standalone "Brain" tab already passes as brainHiddenKeys.
    hiddenKeys?: string[];
  };
  // The chat half of the card: App builds it (ProjectChat over this workspace's
  // agent) so it can share the selected thread with the console pane.
  chat?: ReactNode;
  sources?: SourceStatus;
  // Spawned as nodes around the Devices seed once it is activated.
  devices?: ReadonlyArray<Pick<Device, 'id' | 'name' | 'status' | 'firmwareVersion'>>;
} = {}) {
  const { currentProject } = useCurrentProject();
  const projectId = currentProject.id;
  // Masked on BOTH ends under the fake-empty dev mode (the write below too): an id
  // activated on the real brain would otherwise pop that satellite out of the hub
  // on the first paint of every onboarding session.
  const [activated, setActivated] = useState(() => (ONBOARDING_MODE ? [] : readActivated(projectId)));
  const activate = useCallback(
    (id: string) =>
      setActivated((cur) => {
        if (cur.includes(id)) return cur;
        const next = [...cur, id];
        // Not under the fake-empty dev mode: leaving it must find the real workspace untouched.
        if (!ONBOARDING_MODE) try { localStorage.setItem(ACTIVATED_KEY(projectId), JSON.stringify(next)); } catch { /* quota */ }
        return next;
      }),
    [projectId],
  );
  // Keyed on a string, not the array: App re-renders on every heartbeat with a fresh
  // `devices`, and a new list here would re-derive the whole seed graph each time.
  const deviceKey = (devices ?? []).map((d) => `${d.id}\t${d.name}\t${d.status}\t${d.firmwareVersion}`).join('\n');
  const deviceSeeds = useMemo(
    () => (devices ?? []).map((d) => ({
      id: `device-${d.id}`,
      title: d.name || d.id,
      content: `Device ${d.name} (${d.id}) — ${d.status}, firmware ${d.firmwareVersion}`,
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deviceKey],
  );
  const seeds = useMemo(() => {
    if (!sources) return undefined;
    // `connected` = any source of that app is live (gates Quickstart).
    const seed = (tab: string, title: string, connected: boolean, description: string, quickstart: string) => ({
      id: `tab-${tab}`,
      title,
      sourceRef: { kind: 'tab' as const, tab },
      description,
      quickstart,
      connected,
      activated: activated.includes(`tab-${tab}`),
      onActivate: () => activate(`tab-${tab}`),
    });
    return [
      {
        ...seed('devices', 'Devices', sources.devices,
          'Your fleet: every board you flash or enroll, with its health, crashes and OTA updates.',
          'Quickstart Devices: list this workspace\'s devices and device groups, then add one brain node per group (which boards it holds, firmware version, last seen) plus one fleet summary node.'),
        // The fleet spawns around the node the moment it is activated — not before, so
        // hovering the hub still reveals just the four apps.
        children: activated.includes('tab-devices') ? deviceSeeds : undefined,
      },
      seed('dev', 'Dev', sources.github,
        'Everything that builds and ships the product: repos, pipelines and rollouts.',
        'Quickstart Dev: list the repositories connected to this workspace and add one brain node per repo (what it builds, its production branch, the last pipeline run or rollout and its state).'),
    ];
  }, [sources, activated, activate, deviceSeeds]);
  return (
    // h-full + child override stretch the card past its own h-[75dvh] so it
    // fills the page; BrainCard itself stays untouched (nff-admin reuses it,
    // and gets the vendor brain from its own default source).
    // Full width, no max: the card splits 50/50 into the chat column and the brain,
    // so capping it at max-w-5xl would leave both halves ~32rem — the graph near the
    // ~300px where the density merge swallows the brain into one blob.
    <div className="mx-auto flex h-full w-full flex-col gap-6 p-4 [&>div]:h-full">
      {/* A <section>, not a <div>: the wrapper's [&>div]:h-full is for the card only. */}
      {onSelfHealDemo && (
        <section className="flex shrink-0 flex-wrap items-center gap-3 border border-ink bg-paper px-3 py-2 font-mono text-[12px] text-ink">
          <button
            onClick={onSelfHealDemo}
            disabled={demoRunning}
            className="border border-ink bg-ink px-3 py-1 text-[12px] font-bold text-paper disabled:cursor-default disabled:opacity-60"
          >
            {demoRunning ? 'Healing… watch the agent work in the brain panel' : demoLive ? '⚡ Run it again →' : '⚡ Trigger the self-heal demo →'}
          </button>
          <span>
            Breaks a mock device with a real firmware fault; the agent diagnoses it, fixes the code and OTA-recovers it.
          </span>
        </section>
      )}
      {/* projectBrainSource reads this workspace's brain straight from Supabase
          under RLS. Without it BrainCard falls back to nff-admin's vendor brain
          over /admin-api — which is what every customer used to see. */}
      <BrainCard source={projectBrainSource} seeds={seeds} chat={chat} {...brain} />
    </div>
  );
}
