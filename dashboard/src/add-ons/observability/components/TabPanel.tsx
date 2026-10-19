import { useEffect, useState, type ReactNode } from 'react';
import { useDevices } from '../hooks/useDevices';
import { useAgentMessages } from '../../../hooks/useAgentMessages';
import { useDemoHealState } from '../../../context/DeviceHealthContext';
import { NAV_GROUPS, type TabId } from '../../../components/squeletton/TabBar';
import { NARRATION_PREFIX } from '../../../components/chat/ChatPanel';
import { LiveNarration } from '../../../components/chat/LiveNarration';
import type { DemoStory } from '../../../components/brain/DemoCodeWatcher';
import { CodeTab } from '../../../components/brain/CodeTab';
import { StatusBadge } from './StatusBadge';
import { CrashTab } from './CrashTab';
import { OtaTab } from './OtaTab';

// A tab master's compact tab view, mounted in the brain's side column (BrainCard
// `nodePanel`) when that master is selected — the Devices master shows Fleet / Crashes,
// the Dev master Code / Deploy — with a ⤢ button
// that opens the real tab. In demo mode the self-heal story drives `tab` (the beat the
// agent is on) and `demo` adds one live line of agent narration. Every data hook here is
// shared with the real tabs, so this opens no extra realtime channel.
export type PanelRail = 'devices' | 'dev';

// Which rail a tab master node belongs to, or null for any other node.
export function railOfNode(node: { sourceRef?: unknown }): PanelRail | null {
  const r = node.sourceRef as { kind?: string; tab?: string } | null | undefined;
  return r?.kind === 'tab' && (r.tab === 'devices' || r.tab === 'dev') ? r.tab : null;
}

export interface TabPanelDemo {
  story: DemoStory | null;
  done: boolean;           // story parked on 'recover' and the device is no longer healing
  error: string | null;    // the start call failed server-side (no L2 online, pool full …)
  booting?: boolean;       // local dev: a freshly seeded L2 is still booting (QEMU, ~1 min)
  sessionId: string | null;
  deviceId: string | null; // the device being healed (DeviceHealthContext marker)
}

// The tabs each rail can show compactly, in story order.
const RAIL_TABS: Record<PanelRail, TabId[]> = { devices: ['dashboard', 'crash'], dev: ['code', 'ota'] };
const STORY_TABS: TabId[] = ['dashboard', 'crash', 'code', 'ota'];
const REACHED: Record<DemoStory['phase'], number> = { crash: 1, code: 2, deploy: 3, recover: 4 };
const CHIP_LABEL: Partial<Record<TabId, string>> = { dashboard: 'Fleet', ota: 'Deploy' };

export function TabPanel({ rail, tab, onOpenTab, demo }: {
  rail: PanelRail;
  tab?: TabId | null;                // the story's current tab; null = user's pick / first chip
  onOpenTab: (tab: TabId) => void;   // ⤢ — open the real tab
  demo?: TabPanelDemo;
}) {
  const tabs = RAIL_TABS[rail];
  // A chip click pins a tab; the next story beat (a change of `tab`) takes over again.
  const [pick, setPick] = useState<TabId | null>(null);
  useEffect(() => { setPick(null); }, [tab]);
  const current = pick ?? (tab && tabs.includes(tab) ? tab : tabs[0]);
  const reached = demo?.story ? REACHED[demo.story.phase] : 0;

  return (
    <div className="flex h-full min-h-0 flex-col font-mono text-[12px] text-ink">
      {/* The tabs this master can show — the story ticks the ones it has passed. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-ink px-3 py-2">
        {tabs.map(t => {
          const group = NAV_GROUPS.find(g => g.tabs.some(x => x.id === t));
          const active = t === current;
          const ticked = !active && STORY_TABS.indexOf(t) < reached;
          return (
            <button
              key={t}
              onClick={() => setPick(t)}
              className={`border border-ink px-2 py-0.5 text-[11px] ${active ? 'bg-ink text-paper' : ticked ? 'text-ink' : 'text-faint'}`}
            >
              {ticked ? '✓' : group?.icon} {CHIP_LABEL[t] ?? group?.label}
            </button>
          );
        })}
        <button
          onClick={() => onOpenTab(current)}
          title="Open the full tab"
          className="ml-auto border border-ink px-2 py-0.5 text-[11px] hover:bg-ink hover:text-paper"
        >
          ⤢
        </button>
      </div>

      {demo && <div className="shrink-0 border-b border-ink px-3 py-2"><DemoLine {...demo} /></div>}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {current === 'crash' ? (
          <CrashTab />
        ) : current === 'code' ? (
          <CodeTab compact />
        ) : current === 'ota' ? (
          <OtaTab compact />
        ) : (
          <FleetList victimId={demo?.deviceId ?? null} />
        )}
      </div>
    </div>
  );
}

// Fleet: DeviceTable's nine nowrap columns don't fit the column; the lifecycle dot
// (amber → red → blue → green) is the payoff, so just dots + name + firmware.
function FleetList({ victimId }: { victimId: string | null }) {
  const { devices } = useDevices();
  return (
    <ul className="w-full overflow-y-auto px-3 py-2">
      {devices.map(d => (
        <li key={d.id} className={`flex items-center gap-2 py-0.5 ${d.id === victimId ? 'font-bold' : ''}`}>
          <StatusBadge status={d.status} deviceId={d.id} />
          <span className="truncate">{d.name}</span>
          <span className="ml-auto shrink-0 text-muted">{d.firmwareVersion}</span>
        </li>
      ))}
    </ul>
  );
}

// What the agent is doing right now (demo mode only): the last ⚙ narration row of the
// demo's chat session, or the story's ending.
function DemoLine({ done, error, booting, sessionId, deviceId }: TabPanelDemo) {
  const { devices } = useDevices();
  const heal = useDemoHealState(deviceId);
  // `undefined` skips the fetch until the API hands back the session id.
  const { messages } = useAgentMessages(sessionId ?? undefined);
  const victim = devices.find(d => d.id === deviceId) ?? null;
  const last = messages[messages.length - 1];
  const narration = last?.role === 'agent' && last.content.startsWith(NARRATION_PREFIX)
    ? last.content.slice(NARRATION_PREFIX.length)
    : null;

  let line: ReactNode;
  if (error) {
    line = <span className="text-error">✗ Couldn't start: {error}</span>;
  } else if (done) {
    line = heal === 'recovered'
      ? <span className="text-ink">✓ Recovered — {victim?.name ?? deviceId} runs v{victim?.firmwareVersion}</span>
      : heal === 'expired'
        ? <span className="text-error">✗ The fix never landed</span>
        : <span className="text-ink">✓ Done</span>;
  } else if (booting) {
    line = <LiveNarration text="Booting a QEMU device (~1 min)" />;
  } else if (narration) {
    line = <LiveNarration text={narration} />;
  } else {
    line = <LiveNarration text={sessionId ? 'Waiting for the agent' : `Breaking ${victim?.name ?? 'a mock device'}`} />;
  }
  return line;
}
