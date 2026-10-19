import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Device } from './types/device';
import type { CrashReport } from './add-ons/observability/types/crash';
import { useDevices } from './add-ons/observability/hooks/useDevices';
import { useBuilderFeatures } from './hooks/useBuilderFeatures';
import { useChatSessions } from './hooks/useChatSessions';
import type { QueryContext } from './types/query';
import { DeviceTable } from './add-ons/observability/components/DeviceTable';
import { NAV_GROUPS, groupOf, tabFromSearch, type TabId } from './components/squeletton/TabBar';
import { useTenant } from './context/TenantContext';
// The shell chrome is the shared rail nff-admin renders too (src/add-ons),
// fed with THIS app's arrangement (src/nav.tsx).
import { Sidebar, STANDALONE } from './core/components/Sidebar';
import { SubTabBar } from './core/components/SubTabBar';
import { SETTINGS_RAIL, hiddenRailIds, railGroupOf, railMembersOf, railSections } from './nav';
import { ProfileMenu } from './components/squeletton/ProfileMenu';
import { CircleHelp, Sprout, Clapperboard, Undo2 } from 'lucide-react';
import { BetaBanner } from './components/squeletton/BetaBanner';
// The workspace's chat with its own project agent, and that same thread's tool
// transcript. Both live on the Overview: ProjectChat in the brain card's chat
// half, the console in the shell's right-hand pane. (The admin data-chat —
// ChatDock / ChatTab — belongs to nff-admin's worker and is not mounted here.)
import { ProjectChat } from './components/chat/ProjectChat';
import { ConsoleTab } from './add-ons/console/components/ConsoleTab';
// Add-on tabs picked straight from the library (src/add-ons) — the same components
// nff-admin composes into its own shell. Their ids live in this app's TabId.
import type { StoreAdapter } from './components/squeletton/StoreSection';
import { DEVICES_GROUP_IDS, DEV_GROUP_IDS, storeFocusOf } from './lib/store';
import { AgentManagementTab } from './components/brain/AgentManagementTab';
import { DeviceDetailTab } from './add-ons/observability/components/DeviceDetailTab';
import { CrashTab } from './add-ons/observability/components/CrashTab';
import { OtaTab } from './add-ons/observability/components/OtaTab';
import { GroupsTab } from './add-ons/observability/components/GroupsTab';
import { EnrollmentTab } from './add-ons/observability/components/EnrollmentTab';
import { HardwareTab } from './add-ons/observability/components/HardwareTab';
import { GithubTab } from './add-ons/github/components/GithubTab';
import { BrainCard } from './core/overview/components/BrainCard';
import { projectBrainSource } from './core/overview/hooks/useProjectBrain';
import { ASK_CHAT_EVENT, BRAIN_SYNCED_EVENT, BRAIN_TOUR_EVENT, CHAT_REPLIED_EVENT, type BrainSyncedDetail, type BrainTourDetail } from './core/lib/adminChat';
import { withViewTransition } from './core/lib/viewTransition';
import { PolicyTab } from './components/brain/PolicyTab';
import { BuilderTab } from './components/brain/BuilderTab';
import { BuildChecklistModal } from './components/brain/BuildChecklistModal';
import { OtaRolloutModal } from './add-ons/observability/components/OtaRolloutModal';
import { FleetIncidentModal } from './add-ons/observability/components/FleetIncidentModal';
import { CrashToast } from './add-ons/observability/components/CrashToast';
import { DemoCodeWatcher, DEMO_STORY_TTL, type DemoStory } from './components/brain/DemoCodeWatcher';
import { PlanReadyWatcher } from './components/brain/PlanReadyWatcher';
import { DemoActivityToast, type DemoActivity } from './components/brain/DemoActivityToast';
import { PolicyActivityToast } from './components/brain/PolicyActivityToast';
import { usePolicyActivation } from './hooks/usePolicyActivation';
import { RateLimitGuard } from './components/squeletton/RateLimitModal';
import { CodeTab } from './components/brain/CodeTab';
import { OverviewTab } from './add-ons/observability/components/OverviewTab';
import { TabPanel, railOfNode } from './add-ons/observability/components/TabPanel';
import type { AdminBrainNode } from './core/overview/hooks/useBrainGraph';
import { TAB_OVERRIDES } from './overrides';
import { StorePanel } from './components/squeletton/StorePanel';
import { isHubNode } from './core/overview/lib/brainMasters';
import { useSourceStatus } from './hooks/useSourceStatus';
import { WebFlashModal } from './add-ons/observability/components/WebFlashModal';
import { WifiHandoffModal } from './add-ons/observability/components/WifiHandoffModal';
import { resumeWiredLink } from './lib/ppplink/linkStore';
import { SettingsTab } from './components/squeletton/SettingsTab';
import { FollowUsTab } from './components/squeletton/FollowUsTab';
import { SecurityTab } from './add-ons/observability/components/SecurityTab';
import { DEV_MODE } from './lib/devMode';
import { ONBOARDING_MODE, setOnboardingMode } from './lib/onboardingMode';
import { DEMO_MODE, setDemoMode } from './lib/demoMode';
import { QueryPopup } from './components/chat/QueryPopup';
import { FeedbackPopup } from './components/squeletton/FeedbackPopup';
import { AccountSettingsModal, type AccountSection } from './components/squeletton/AccountSettingsModal';
import { OnboardingTour } from './components/squeletton/OnboardingTour';
import { OnboardingPathModal } from './components/squeletton/OnboardingPathModal';
import { onboardingSteps, TOUR_TARGET, DEPLOY_STEPS } from './components/squeletton/onboardingSteps';
import type { StepSignal } from './components/squeletton/onboardingSteps';
import { useDeviceGroups } from './add-ons/observability/hooks/useDeviceGroups';
import { useGithubConnections } from './add-ons/github/hooks/useGithubConnections';
import { useOnboarding } from './hooks/useOnboarding';
import { useCurrentProject } from './context/CurrentProjectContext';
import { useMarkBreaking, useMarkDemoBroken, useDeviceBreakState, useDemoBrokeAt, useDemoBrokenDeviceId, useDemoHealState } from './context/DeviceHealthContext';
import { BREAK_TITLE } from './data/babynffDemoGit';
import { DemoFixWatcher } from './components/brain/DemoFixWatcher';
import { pickVictim, triggerSelfHeal, waitForVictim } from './lib/selfHealDemo';
import { useDemoFleetSeed } from './hooks/useDemoFleetSeed';
import { useIsMobile } from './hooks/useIsMobile';

// How long the guided demo lingers on the Deploy/OTA tab (the "shipping the fix" beat) before
// handing off to the Dashboard to watch the device recover. Purely narrative — the real rollout
// row lives in the pool project, so this is a timed nav, not a live-row view, and it asserts
// nothing about the device's health.
const DEPLOY_BEAT_MS = 7_000;

interface QueryTarget {
  anchor: { x: number; y: number };
  context: QueryContext;
}

function App({
  userId,
  hiddenParts = [],
  store,
}: {
  userId: string;
  hiddenParts?: string[];
  // Settings → Store adapter (AuthGate builds it from the user's hidden_parts).
  store?: StoreAdapter;
}) {
  const isMobile                                   = useIsMobile();
  const tenant                                     = useTenant();
  const onboarding                                 = useOnboarding(userId);
  // The Deploy walkthrough (the Devices source card's "Ship firmware"): a gated sub-tour whose
  // steps unlock only once the user has really created a group / connected a repo / shipped.
  const [deployTourOpen, setDeployTourOpen]        = useState(false);
  // Browser USB flasher, opened from the Devices source card.
  const [flashOpen, setFlashOpen]                  = useState(false);
  // "Cut the cord": push WiFi creds over serial to the wired (USB/PPPoS) device.
  const [wifiHandoffOpen, setWifiHandoffOpen]      = useState(false);
  // "The user rolled out an update" cannot be read off `deployments.length` — the break-heal
  // demo back in `watch-devices` already shipped a real OTA, so the count is non-zero long
  // before the user gets here. Only the Trigger-update modal sets this.
  const [shippedUpdate, setShippedUpdate]          = useState(false);
  const { groups, reload: reloadGroups }           = useDeviceGroups();
  const { connections: realConnections }           = useGithubConnections();
  // Onboarding mode fakes a workspace with no repo connected: this makes repoConnected
  // (and so sources.github) false AND closes the Dev lens below, which checks the
  // connection list directly. These three uses are the only ones in the file.
  const connections = ONBOARDING_MODE ? [] : realConnections;
  const { devices, setDeviceName, loading: devicesLoading } = useDevices();
  // The demo repo is injected client-side, not connected — it must not satisfy a gate.
  const repoConnected = connections.some(c => !c.virtual);
  const deploySignals: Partial<Record<StepSignal, boolean>> = {
    'group-exists':       groups.length > 0,
    'repo-connected':     repoConnected,
    'deployment-created': shippedUpdate,
  };
  // What feeds the brain — drives the rail's lenses, the tour's gates, the brain's Store seeds and
  // the auto-sync on connect (useSourceStatus).
  const sources = useSourceStatus({ deviceCount: devices.length, devicesReady: !devicesLoading, github: repoConnected });
  // "Grow your brain" tour gates: a sync added nodes / a chat reply landed (window events,
  // so the dock, the Chat tab and /skills all count).
  const [nodesAdded, setNodesAdded]                = useState(false);
  const [chatReplied, setChatReplied]              = useState(false);
  // The brain beats: hub hovered once (latched — the reveal folds back when the pointer
  // leaves), and whichever node is selected right now (BrainCard's BRAIN_TOUR_EVENT).
  const [hubRevealed, setHubRevealed]              = useState(false);
  const [brainSelectedId, setBrainSelectedId]      = useState<string | null>(null);
  useEffect(() => {
    const onSynced = (e: Event) => { if (((e as CustomEvent<BrainSyncedDetail>).detail?.added ?? 0) > 0) setNodesAdded(true); };
    const onReplied = () => setChatReplied(true);
    const onBrainTour = (e: Event) => {
      const d = (e as CustomEvent<BrainTourDetail>).detail;
      if (d.hubRevealed) setHubRevealed(true);
      setBrainSelectedId(d.selectedId);
    };
    window.addEventListener(BRAIN_SYNCED_EVENT, onSynced);
    window.addEventListener(CHAT_REPLIED_EVENT, onReplied);
    window.addEventListener(BRAIN_TOUR_EVENT, onBrainTour);
    return () => {
      window.removeEventListener(BRAIN_SYNCED_EVENT, onSynced);
      window.removeEventListener(CHAT_REPLIED_EVENT, onReplied);
      window.removeEventListener(BRAIN_TOUR_EVENT, onBrainTour);
    };
  }, []);
  const tourSteps = useMemo(() => (onboarding.path ? onboardingSteps(onboarding.path) : []), [onboarding.path]);
  const tourSignals: Partial<Record<StepSignal, boolean>> = {
    'hub-revealed':    hubRevealed,
    'target-selected': !!onboarding.path && brainSelectedId === TOUR_TARGET[onboarding.path].id,
    'any-source':      sources.connectedCount > 0,
    'second-source':   sources.connectedCount > 1,
    'nodes-added':     nodesAdded,
    'chat-replied':    chatReplied,
  };

  // The "create a group" step has no Skip, and it opens on a device_groups Realtime event that
  // only exists once migration 0081 has been applied. Poll while that step is waiting so a lagging
  // (or unpublished) database degrades to a slow gate rather than a deadlocked walkthrough.
  useEffect(() => {
    if (!deployTourOpen || groups.length > 0) return;
    const t = setInterval(() => { void reloadGroups(); }, 2000);
    return () => clearInterval(t);
  }, [deployTourOpen, groups.length, reloadGroups]);
  // Keep the demo project's live mock fleet topped up to 8 L1 + 2 L2 while it's open — seeds a
  // new user's empty demo project and re-fills reaped mocks. No-op for non-demo projects / at target.
  useDemoFleetSeed();
  const [activeTab, setActiveTab]                  = useState<TabId>(() => tabFromSearch(window.location.search) ?? 'overview');
  // Per-tab reconfiguration (src/overrides): when the active tab has an
  // override registered, every default tab body stays mounted-but-hidden
  // (shownTab === null matches no toggle) and the override renders in the
  // single slot below the tab divs.
  const ActiveOverride = TAB_OVERRIDES[activeTab];
  const shownTab: TabId | null = ActiveOverride ? null : activeTab;
  // askChat() from any tab (a StatCard's query mode) is answered by the chat on
  // the Overview — ProjectChat sends it there — so bring that page up.
  useEffect(() => {
    const onAsk = () => withViewTransition(() => setActiveTab('overview'));
    window.addEventListener(ASK_CHAT_EVENT, onAsk);
    return () => window.removeEventListener(ASK_CHAT_EVENT, onAsk);
  }, []);
  // The conversation both Overview panes show: bubbles in the brain card's chat
  // half, the agent's tool transcript in the console pane. Null = the newest one
  // (ProjectChat resolves it and reports back).
  const [chatSessionId, setChatSessionId] = useState<string | null>(null);
  const [selectedDevice, setSelectedDevice]        = useState<Device | null>(null);
  const [splitPct, setSplitPct]                    = useState(72);   // % width of the tab content; console pane takes the rest
  const [dragging, setDragging]                    = useState(false);
  // The Overview's two side panels — the chat list on the left of the chat, the
  // agent console on the right of the page — are MUTUALLY EXCLUSIVE: both eat
  // width from the same row, so opening one puts the other away. null = neither,
  // and the conversation + brain get the whole width. Persisted.
  const [sidePane, setSidePane] = useState<'chats' | 'console' | null>(() => {
    const v = localStorage.getItem('nff.overviewPane');
    if (v === 'chats' || v === 'console') return v;
    if (v === '') return null;
    // First run after the merge: seed from the two per-panel keys it replaces.
    if (localStorage.getItem('nff.chatPane') === 'console') return 'console';
    return localStorage.getItem('nff.chats.collapsed') === '1' ? null : 'chats';
  });
  useEffect(() => {
    localStorage.setItem('nff.overviewPane', sidePane ?? '');
  }, [sidePane]);
  const consoleOpen = sidePane === 'console';
  // "The agent is calling a tool right now" — reported by the (always-mounted)
  // ConsoleTab; the pull-tab blinks on it so the user sees activity without opening it.
  const [consoleActive, setConsoleActive] = useState(false);
  // Query mode has no rail entry point any more (the "⊕ Query" button was removed);
  // the tabs still take the flag, so it stays a constant until a new trigger exists.
  const queryMode                                  = false;
  const [queryTarget, setQueryTarget]              = useState<QueryTarget | null>(null);
  const [feedbackOpen, setFeedbackOpen]            = useState(false);
  // null = closed; otherwise the section the account modal opens on.
  const [accountOpen, setAccountOpen]              = useState<AccountSection | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen]  = useState(false);
  const [otaFocusDeployment, setOtaFocusDeployment] = useState<string | null>(null);
  const [openGithubConnect, setOpenGithubConnect]   = useState(false);
  // Top-right warning toasts, one per fresh device crash (newest first, capped). Distinct from the
  // bottom-right FleetIncidentModal tracker — these are the loud, self-dismissing "a device broke"
  // alerts, extra-prominent in babynff mode. Fed by handleFreshCrash.
  const [crashToasts, setCrashToasts]               = useState<CrashReport[]>([]);
  // The feature whose build the floating checklist modal is tracking (set on Approve).
  // Persisted so a page reload mid-build keeps the tracker open (the build runs
  // server-side regardless); cleared only when the user dismisses it.
  const [activeBuildFeatureId, setActiveBuildFeatureId] = useState<string | null>(
    () => localStorage.getItem('nff.activeBuildFeatureId'),
  );
  useEffect(() => {
    if (activeBuildFeatureId) localStorage.setItem('nff.activeBuildFeatureId', activeBuildFeatureId);
    else localStorage.removeItem('nff.activeBuildFeatureId');
  }, [activeBuildFeatureId]);
  // The deployment whose rollout the floating upload wizard is tracking (set on ship).
  // Persisted so a reload mid-rollout keeps the tracker open (the rollout runs
  // server-side regardless); cleared only when the user dismisses it.
  const [activeOtaRolloutId, setActiveOtaRolloutId] = useState<string | null>(
    () => localStorage.getItem('nff.activeOtaRolloutId'),
  );
  useEffect(() => {
    if (activeOtaRolloutId) localStorage.setItem('nff.activeOtaRolloutId', activeOtaRolloutId);
    else localStorage.removeItem('nff.activeOtaRolloutId');
  }, [activeOtaRolloutId]);
  // Resume a wired (USB/PPPoS) link on load: if this tab flashed a device over USB, Web Serial still
  // has the granted port after a reload, so we re-open it and bring the link back with no re-flash.
  useEffect(() => { void resumeWiredLink(); }, []);
  // Dev-only: fire a fake fresh crash from the browser console — `__nffTestCrashToast()` — so the
  // top-right crash toast can be iterated on live (HMR) without waiting on the whole self-heal
  // backend chain. Not registered in normal/prod builds.
  useEffect(() => {
    if (!DEV_MODE) return;
    const w = window as unknown as { __nffTestCrashToast?: () => void };
    w.__nffTestCrashToast = () => {
      const fake: CrashReport = {
        id: `test-${Date.now()}`, deviceId: 'mock-test-01', deviceName: 'mock-test-01',
        deviceStatus: 'error', timestamp: new Date(), reason: 'null_deref', exceptionCause: 28,
        pc: '0x400d1234', uptimeMs: 4200, crashCount: 3, fwVersion: '1.0.0', buildId: 'test',
        backtrace: [{ address: '0x400d1234', resolved: 'app_main at main.c:42' }],
        rtcLog: [{ level: 'E', tag: 'APP', message: 'null pointer dereference', msBeforeCrash: 5 }],
        retained: false,
      };
      setCrashToasts(prev => [fake, ...prev.filter(c => c.id !== fake.id)].slice(0, 3));
    };
    return () => { delete (window as unknown as { __nffTestCrashToast?: unknown }).__nffTestCrashToast; };
  }, []);
  // The Builder nav line shows only while a feature is being developed or built. `builderOpen`
  // is set by "+ Develop Feature"; a running build (activeBuildFeatureId) keeps it alive across
  // reloads. Closing it (× on the line) just hides the entry — the session/build keep running.
  const [builderOpen, setBuilderOpen] = useState(false);
  // The "Self-heal demo" chat session the demo's agent runs narrate in (set when the demo
  // fires). `agentSessionRequest` is an explicit "open this session" signal (nonce so repeat
  // clicks re-fire) raised by the incident popup's "Agent →" button — kept separate from
  // demoSessionId so the Agent tab isn't yanked to it the moment a demo runs.
  const [demoSessionId, setDemoSessionId] = useState<string | null>(null);
  // The break-and-heal demo's guided-navigation state (null = no demo running). Armed by
  // beginDemoStory and advanced crash → code → recover as the story's realtime signals land, so
  // the tabs follow along automatically. A ref mirrors it for the crash callback (fired from an
  // async realtime edge, so it must read the latest phase without re-subscribing).
  const [demoStory, setDemoStory] = useState<DemoStory | null>(null);
  // Demo mode: the tab the story is "touching" right now. The Overview's brain shows that
  // tab in its side panel instead of navigating (storyNav below) — the brain stays on screen.
  const [demoPanelTab, setDemoPanelTab] = useState<TabId | null>(null);
  // Groups the user asked to see via a tab panel's ⤢ ("full screen"), for the session. They
  // beat the SOFT hidings below — the source lenses (a fresh workspace with nothing
  // connected: exactly where the brain gets explored first) and demo mode's Overview-only
  // rail — never the tenant's or the Store's. Reload resets.
  const [revealedGroups, setRevealedGroups] = useState<string[]>([]);
  const notRevealed = (id: string) => !revealedGroups.includes(id);
  const demoStoryRef = useRef(demoStory);
  useEffect(() => { demoStoryRef.current = demoStory; }, [demoStory]);
  // Which dashboard groups are visible — ONE list shared by the rail, the arrow keys and the
  // active-tab guard: tenant hiding (tenants.hidden_groups, 0105) → Store removals → lenses.
  // Lenses: a product area appears once its source is connected (the brain's Store nodes are the way
  // in). Off until the first status settles (no flicker for connected users), and off while a
  // guided flow drives those tabs itself (the Deploy walkthrough, the break-and-heal demo, which
  // borrows a pool device that may not be visible yet).
  const lensesOn = sources.ready && !deployTourOpen && !demoStory;
  const hiddenGroupIds = [
    ...(tenant?.hiddenGroups ?? []),
    ...hiddenParts,
    ...(lensesOn && !sources.devices ? DEVICES_GROUP_IDS.filter(notRevealed) : []),
    ...(lensesOn && !sources.github && connections.length === 0 ? DEV_GROUP_IDS.filter(notRevealed) : []),
    // Demo mode: Overview is the whole product — the brain and the self-heal button.
    ...(DEMO_MODE ? NAV_GROUPS.map(g => g.id).filter(id => id !== 'overview' && notRevealed(id)) : []),
  ];
  const visibleGroups = NAV_GROUPS.filter(g => !hiddenGroupIds.includes(g.id));
  // A hidden group's tab can never stay ACTIVE (e.g. via a stale saved state, or a lens
  // closing). 'overview' can never be hidden — the 0105 CHECK forbids it.
  const hiddenKey = hiddenGroupIds.join(',');
  useEffect(() => {
    if (hiddenKey.split(',').includes(groupOf(activeTab))) setActiveTab('overview');
  }, [hiddenKey, activeTab]);
  // The demo narrates its beats through a gentle "something's happening on another tab" toast
  // (see the phase handlers below). A single slot — each beat replaces the previous one.
  const [demoActivity, setDemoActivity] = useState<DemoActivity | null>(null);
  function noteActivity(message: string, targetTab: TabId, tabLabel: string, sticky = false) {
    // Demo mode: the brain's side panel narrates (TabPanel) and every target tab is
    // hidden, so the "open the X tab" toast would be a dead button.
    if (DEMO_MODE) return;
    // Stable id per beat (targetTab): each tab carries exactly one beat message, so an accidental
    // re-fire of the same beat coalesces instead of minting a new toast + resetting the dismiss
    // timer every time. Distinct beats (Code → Deploy) still change the id and reset the timer.
    setDemoActivity({ id: targetTab, message, targetTab, tabLabel, sticky });
  }
  const dismissActivity = useCallback(() => setDemoActivity(null), []);
  // Where the break-and-heal story navigates. In demo mode the page never leaves Overview
  // (the only tab there is): the beat is recorded as the "touched" tab and the brain's side
  // panel renders it (OverviewTab → BrainCard nodePanel → TabPanel), so the graph stays in view.
  const storyNav = useCallback((tab: TabId) => { if (DEMO_MODE) setDemoPanelTab(tab); else setActiveTab(tab); }, []);
  const goToActivityTab = useCallback((tab: TabId) => { storyNav(tab); setDemoActivity(null); }, [storyNav]);
  // Self-heal only (gated on demoStory, not buildStory): while the story is armed, listen for the
  // policy layer recording a transition and dramatize it in PolicyActivityToast. Date.now() in
  // render is fine — App re-renders once per second during an incident, so the TTL naturally
  // expires. Dismissal is per-observation key: a new transition re-opens the toast, but a
  // re-render can't resurrect a dismissed one.
  const policyArmed = !!demoStory && Date.now() - demoStory.armedAt < DEMO_STORY_TTL;
  // Demo mode: the side panel is the narration; no bottom-left toast on top of it.
  const policyActivation = usePolicyActivation(policyArmed && !DEMO_MODE);
  const [policyToastDismissed, setPolicyToastDismissed] = useState<string | null>(null);
  const shownPolicyActivation =
    policyActivation && policyActivation.key !== policyToastDismissed ? policyActivation : null;
  const { currentProject } = useCurrentProject();
  const { createSession } = useChatSessions();
  const markBreaking = useMarkBreaking();
  const markDemoBroken = useMarkDemoBroken();
  // The device the running demo is healing (whichever break trigger fired) — drives DemoFixWatcher.
  const demoBrokenDeviceId = useDemoBrokenDeviceId();
  // The story's honest ending. handleRecover only parks the story on 'recover' (the real OTA
  // takes minutes after the 7 s deploy beat); it is "done" once the device's heal state is no
  // longer 'healing' — recovered, expired, or idle when no marker was ever set.
  const demoHeal = useDemoHealState(demoBrokenDeviceId);
  // A start that failed server-side (e.g. no L2 mock online): the panel shows it and the
  // button comes back, instead of "Healing…" over a story that never began.
  const [demoError, setDemoError] = useState<string | null>(null);
  // Waiting on a freshly seeded L2's QEMU boot before the break can fire (local dev only).
  const [demoBooting, setDemoBooting] = useState(false);
  // Latest device list for runBreakHeal's boot wait (it polls across many realtime updates).
  const devicesRef = useRef(devices);
  useEffect(() => { devicesRef.current = devices; }, [devices]);
  const demoDone = demoError != null || (demoStory?.phase === 'recover' && demoHeal !== 'healing');
  // The brain's side column is where the Store lives: the hub opens the whole Store;
  // Admin / Dev / Finance open their own app row (StorePanel focus); the Devices node
  // shows nothing on top (its hardware actions moved to the Devices → Hardware tab).
  // Whatever sits on top stacks above the master's compact tab view (TabPanel: Devices →
  // Fleet / Crashes, Dev → Code / Deploy, each with ⤢ to the real tab). In demo mode the
  // story also selects the master it is touching (focus) and marks it (square).
  const demoPanel = DEMO_MODE
    ? { story: demoStory, done: demoDone, error: demoError, booting: demoBooting, sessionId: demoSessionId, deviceId: demoBrokenDeviceId }
    : undefined;
  // ponytail: derived-master ids; a workspace-synced master is `<proj8>-tab-devices` — match
  // by sourceRef in BrainCard if a non-fixture demo brain ever needs the focus/marker.
  const demoFocusId = DEMO_MODE && demoStory && demoPanelTab ? `tab-${railGroupOf(groupOf(demoPanelTab))}` : null;
  const demoMarkerId = demoFocusId && !demoDone ? demoFocusId : null;
  const deviceActions = {
    onFlash: () => setFlashOpen(true),
    onWifi: () => setWifiHandoffOpen(true),
    onDeployTour: () => setDeployTourOpen(true),
    onBreakHeal: runBreakHeal,
    onNavigate: handleNav,
  };
  const nodePanel = (n: AdminBrainNode) => {
    if (isHubNode(n)) return <StorePanel store={store} />;
    const focus = storeFocusOf(n.sourceRef);
    const rail = railOfNode(n);
    // Emails has no tab: its compact view is the inbox itself, under its Store row.
    const bottom = rail
      ? <TabPanel rail={rail} tab={DEMO_MODE ? demoPanelTab : null} onOpenTab={openTabFullScreen} demo={demoPanel} />
      : null;
    if (!focus && !bottom) return null;
    return (
      <>
        {/* Alone (Admin / Finance / a tool) the Store row takes the whole column and scrolls; above a compact view it is capped at half. */}
        {focus && (
          <div className={`overflow-y-auto ${bottom ? 'shrink-0 max-h-[50%] border-b border-ink' : 'min-h-0 flex-1'}`}>
            {/* Keyed: StoreSection's focus state is initial-only, and the panel stays mounted across node clicks. */}
            <StorePanel key={focus} store={store} focus={focus} />
          </div>
        )}
        {bottom && <div className="flex min-h-0 flex-1 flex-col">{bottom}</div>}
      </>
    );
  };
  // Timer for the deploy → recover beat. Held in a ref so a story reset can cancel it.
  const deployBeatRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cancel a pending beat on unmount so it can't fire after teardown.
  useEffect(() => () => {
    if (deployBeatRef.current) clearTimeout(deployBeatRef.current);
  }, []);
  const { features: builderFeatures } = useBuilderFeatures();
  const checklistFeatureId = activeBuildFeatureId;
  // Instant crash toast the moment a device is marked "breaking"/"demo-broken" client-side (the
  // break button): the self-heal demo mocks the panic, so fire immediately rather than waiting on
  // the real crash_reports row over realtime. Every break path (the Devices source card,
  // DemoChaosPanel) funnels through markBreaking/markDemoBroken, so watching that state
  // covers them all. When the real crash row lands, handleFreshCrash replaces this placeholder
  // (both dedupe by deviceId). Only demo breaks flip this state — real prod crashes still surface
  // via onFreshCrash — so nothing false-fires in normal prod operation.
  const { breaking: breakTransients, demoBroken: demoBrokenTransients } = useDeviceBreakState();
  const brokeToastSeenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const id of [...Object.keys(breakTransients), ...Object.keys(demoBrokenTransients)]) {
      if (brokeToastSeenRef.current.has(id)) continue;
      brokeToastSeenRef.current.add(id);
      const name = devices.find(d => d.id === id)?.name ?? id;
      const placeholder: CrashReport = {
        id: `break-${id}`, deviceId: id, deviceName: name, deviceStatus: 'error',
        timestamp: new Date(), reason: 'crash detected — agent diagnosing', exceptionCause: 0,
        pc: '', uptimeMs: 0, crashCount: 1, fwVersion: '', buildId: '',
        backtrace: [], rtcLog: [], retained: false,
      };
      setCrashToasts(prev => [placeholder, ...prev.filter(c => c.deviceId !== id)].slice(0, 3));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [breakTransients, demoBrokenTransients]);
  const containerRef                               = useRef<HTMLDivElement>(null);
  const hasSelectedDeviceRef                       = useRef(false);
  const lastSelectedDeviceRef                      = useRef<Device | null>(null);
  if (selectedDevice) {
    hasSelectedDeviceRef.current  = true;
    lastSelectedDeviceRef.current = selectedDevice;
  }

  function openDevice(device: Device) {
    setSelectedDevice(device);
    setActiveTab('device-detail');
  }

  function closeDevice() {
    setSelectedDevice(null);
    setActiveTab('dashboard');
  }

  // Deep-link from the GitHub tab: jump to OTA and focus the run's deployment.
  function openDeployment(deploymentId: string) {
    setOtaFocusDeployment(deploymentId);
    setActiveTab('ota');
  }

  // Sidebar navigation. The "Builder" nav item opens a fresh feature-builder interview
  // (openBuilder) ONLY when none is already underway; if a builder session/build is already
  // open, it's a plain switch to the tab. Bumping the nonce on every click would restart the
  // interview each visit — resetting the session id flashes ChatPanel's input off then back on
  // (the "blinking prompt bar") and throws away the in-progress interview. Everything else is
  // a plain tab switch.
  function handleNav(tab: TabId) {
    if (tab === 'builder') {
      if (builderOpen || activeBuildFeatureId) setActiveTab('builder');
      else openBuilder();
      return;
    }
    // Picking Fleet from the Devices panel also closes an open device (its panel entry goes).
    if (tab === 'dashboard' && selectedDevice) { closeDevice(); return; }
    setActiveTab(tab);
  }
  // Stable identities for what feeds the brain graph: App re-renders on every
  // device heartbeat, and a fresh arrow / array per render made OverviewTab's
  // `seeds` memo and BrainGraph's offIds memo (2 BFS over the graph) re-run
  // each time. handleNav itself closes over state, so it goes through a ref.
  const handleNavRef = useRef(handleNav);
  useEffect(() => { handleNavRef.current = handleNav; });
  const hiddenPartsKey = hiddenParts.join('|'); // the `= []` default is a new array per render
  // Admin / Finance have no rail: their masters dim when the Store app itself is off.
  const storeHiddenKey = (store?.hidden ?? []).join('|');
  const brainHiddenKeys = useMemo(
    () => [
      ...hiddenParts,
      ...hiddenRailIds(hiddenParts),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hiddenPartsKey, storeHiddenKey],
  );

  // A tab panel's ⤢: open the real tab. In demo mode that tab's group is hidden, so reveal it
  // first (the hidden-tab guard re-runs on the same list, so reveal + navigate is one click).
  // Both updates inside ONE view transition (flushSync commits them together, so the guard sees
  // the revealed group): the panel box (view-transition-name: tab-panel in BrainCard) grows
  // into the destination tab's wrapper, which carries the same name below.
  function openTabFullScreen(tab: TabId) {
    withViewTransition(() => {
      // The whole rail entry (Fleet + Device groups + Enroll + Crashes), so the sub-tab column
      // arrives with the tab instead of a lone one-page rail entry.
      setRevealedGroups(r => Array.from(new Set([...r, ...railMembersOf(groupOf(tab))])));
      handleNav(tab);
    });
  }

  // Arm the guided demo story + land on the Dashboard THE INSTANT a break is clicked — NOT when
  // the (slow, sometimes queued) /api/demo/selfheal call returns. Every break entry point calls
  // this synchronously on click, so the tab jumps immediately and the story is armed in time for
  // the crash edge to advance it. Idempotent: re-arming while a story runs just refreshes armedAt.
  function handleDemoStart() {
    // Cancel any pending beat from a previous cycle so it can't yank the tab mid-demo.
    if (deployBeatRef.current) { clearTimeout(deployBeatRef.current); deployBeatRef.current = null; }
    setDemoActivity(null); // clear any stale beat from a previous cycle
    setPolicyToastDismissed(null); // fresh cycle: a dismissed policy toast may show again
    setDemoError(null);
    setDemoStory({ phase: 'crash', armedAt: Date.now() });
    storyNav('dashboard');
  }

  // The demo's chat session id arrives later (on the API response); record it for the incident
  // popup's "Agent →" button and to tighten DemoCodeWatcher's session match. Arm as a safety net
  // in case the click-time arm was missed (e.g. a queued re-fire), but never yank the tab here.
  function handleDemoSession(sessionId: string) {
    setDemoSessionId(sessionId);
    setDemoStory(s => s ?? { phase: 'crash', armedAt: Date.now() });
  }

  // Step 2 — a fresh panic landed (via FleetIncidentModal's existing edge): warn loudly (top-right
  // toast, always) and, if the guided demo is armed on a mock, show the crash logs as a beat. This
  // is now ONLY an optional Crash-tab beat — the phase is driven by the reliable code stream
  // (handleCodeStart), so a missed/cross-project crash can't strand the story on 'crash'.
  function handleFreshCrash(crash: CrashReport) {
    // Loud alert for every genuine fresh crash — dedupe by device (replaces the instant break
    // placeholder for the same device with the real panic detail), newest first, cap the stack at 3.
    setCrashToasts(prev => [crash, ...prev.filter(c => c.deviceId !== crash.deviceId)].slice(0, 3));
    const s = demoStoryRef.current;
    if (s?.phase === 'crash' && Date.now() - s.armedAt < DEMO_STORY_TTL && crash.deviceId.startsWith('mock-')) {
      storyNav('crash');
    }
  }

  // Step 3 — the agent's code stream is live: jump to the Code tab and watch the firmware get
  // rewritten (watching the agent write the fix IS the beat).
  function handleCodeStart() {
    storyNav('code');
    setDemoStory(s => (s ? { phase: 'code', armedAt: Date.now() } : s));
  }

  // The Deploy leg: the compile → rollout beat, fired at the code-stream terminal edge (the agent
  // has SUBMITTED the fix; nff-ota's fix_worker compiles and rolls out afterward). A timed tab
  // hand-off Deploy → Dashboard that claims nothing about the device's health.
  function deployBeat() {
    storyNav('ota');
    if (deployBeatRef.current) clearTimeout(deployBeatRef.current);
    deployBeatRef.current = setTimeout(handleRecover, DEPLOY_BEAT_MS);
  }

  // Step 4 — the fix shipped (code stream terminal): straight to the Deploy beat.
  function handleFixShipped() {
    setDemoStory(s => (s ? { phase: 'deploy', armedAt: Date.now() } : s));
    deployBeat();
  }

  // The agent's fix failed to BUILD (nff-ota's fix_worker recorded the compile error on
  // firmware_fix_jobs). `submit_firmware_fix` only enqueues, so the code stream terminating told us
  // nothing about whether the firmware works — without this the story would sail on to "healthy
  // again 🎉" over a device that never healed. Kill the narrative beats and say what broke.
  // The dot stays red on purpose: the fix never landed, so the device really is still broken.
  function handleFixFailed(reason: string) {
    if (deployBeatRef.current) { clearTimeout(deployBeatRef.current); deployBeatRef.current = null; }
    setDemoStory(null);
    noteActivity(`The fix didn't build: ${reason}`, 'agent-management', 'Agent');
  }

  // Step 5 — off DEPLOY_BEAT_MS: navigate back to the Dashboard to watch the dot, claiming nothing.
  // The story parks on 'recover' rather than ending: the fix OTA is still minutes away, and the
  // demo panel must keep showing the fleet until the dot honestly turns green (demoDone above).
  // The next handleDemoStart re-arms it; nothing else depends on the story being null here.
  function handleRecover() {
    if (deployBeatRef.current) { clearTimeout(deployBeatRef.current); deployBeatRef.current = null; }
    storyNav('dashboard');
    setDemoStory(s => (s ? { phase: 'recover', armedAt: s.armedAt } : s));
  }

  // The break's opening beat: "a commit shipped, and it's the reason your fleet is about to fall
  // over." The commit, its merged PR and its rollout are all derived from devices.demo_fault_since
  // (data/babynffDemoGit.ts), which the server writes as it arms the fault — so narrate on THAT
  // edge, not on the click. Beating on click would point the user at a GitHub tab that is still
  // empty for the second or so the /api/demo/selfheal round-trip takes.
  //
  // A non-yanking toast: the user is already on the Dashboard watching the dot go amber, and the
  // crash beat (handleFreshCrash) lands a moment later. Gated on an armed story so a reload —
  // where demo_fault_since is still set from an old cycle — narrates nothing. Latched on the
  // timestamp so the once-a-second health tick can't re-fire it.
  const demoBrokeAt = useDemoBrokeAt();
  const breakNarratedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!demoBrokeAt || demoStory?.phase !== 'crash') return;
    const at = demoBrokeAt.getTime();
    if (breakNarratedRef.current === at) return;
    breakNarratedRef.current = at;
    noteActivity(`A new commit just shipped to your fleet: "${BREAK_TITLE}".`, 'github', 'GitHub');
  }, [demoBrokeAt, demoStory?.phase]);

  // A feature plan reached 'planned' (any origin — typed chat, CLI) and is
  // waiting for the user's Approve in the Builder tab. Sticky: nothing proceeds until they
  // act, so a timed dismissal would clear the pointer before it's read.
  function handlePlanReady() {
    noteActivity('A feature plan is ready for your review. Approve it in the Builder tab to start the build.', 'builder', 'Builder', true);
  }

  // The Devices source card's "Break a device & watch it heal": break an online mock device and
  // let nff self-heal it; handleDemoStart jumps to the Dashboard to watch.
  async function runBreakHeal() {
    // Prod is pool-only: no own L2 need be visible — the server borrows a shared pool L2 (id comes
    // back on the response). Mark a visible victim amber immediately if there is one, else the
    // borrowed device.
    let victim = pickVictim(devices);
    handleDemoStart(); // arm + jump to Dashboard immediately, before the slow self-heal call
    if (!victim && import.meta.env.DEV) {
      // Local mode breaks the project's OWN L2 (vite.config's selfheal mirror never borrows), so
      // an empty device_id would just 503. (Re)seed the demo fleet — idempotent, the controller
      // fills only the deficit — then wait for the QEMU boot (~1 min) with the panel saying so.
      setDemoBooting(true);
      const seed = await fetch('/api/demo/seed-fleet', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: currentProject.id }),
      }).then(r => r.json()).catch(() => ({}));
      victim = seed?.l2_note ? undefined : await waitForVictim(() => devicesRef.current);
      setDemoBooting(false);
      if (!victim) {
        setDemoError(seed?.l2_note ?? 'no L2 mock came online in 3 min — check the mock controller (docker logs nff-dev-nff-mock-controller-1)');
        return;
      }
    }
    if (victim) markBreaking([victim.id]);
    const res = await triggerSelfHeal(victim?.id ?? '', currentProject.id);
    if (!res.ok) setDemoError(res.error ?? 'unknown error');
    if (res.ok && res.deviceId) markBreaking([res.deviceId]);
    // Hold the dot red until the device's firmware climbs above the seeded buggy version (the
    // agent's real fix OTA landing) — a transient 'online' heartbeat between crash-loop reboots
    // would otherwise flip it green early. Firmware-anchored, same contract as DemoChaosPanel seed.
    if (res.ok && res.deviceId && res.version) markDemoBroken(res.deviceId, res.version);
    if (res.ok && res.sessionId) handleDemoSession(res.sessionId);
  }

  function handleQueryClick(anchor: { x: number; y: number }, context: QueryContext) {
    setQueryTarget({ anchor, context });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setQueryTarget(null);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Desktop keyboard nav: ←/→ jump to the previous/next sidebar group (wrapping), walking the
  // SAME filtered list the sidebar renders. Suppressed while typing, inside Monaco (its
  // read-only diff surface isn't a textarea, hence the closest() check) and while any App-owned
  // modal is up. OnboardingTour claims arrows in the capture phase, which is what the
  // defaultPrevented check honors.
  const modalOpen = !!queryTarget || feedbackOpen || accountOpen !== null || onboarding.open
    || deployTourOpen || flashOpen || wifiHandoffOpen || !!checklistFeatureId;
  useEffect(() => {
    function onArrowNav(e: KeyboardEvent) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (modalOpen) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (t?.closest?.('.monaco-editor')) return;
      const idx = visibleGroups.findIndex(g => g.id === groupOf(activeTab));
      if (idx === -1) return; // active tab's group isn't in the visible list (e.g. dev-only Security)
      const next = visibleGroups[(idx + (e.key === 'ArrowRight' ? 1 : -1) + visibleGroups.length) % visibleGroups.length];
      e.preventDefault();
      handleNav(next.defaultTab ?? next.tabs[0].id);
    }
    window.addEventListener('keydown', onArrowNav);
    return () => window.removeEventListener('keydown', onArrowNav);
  });

  const online = devices.filter(d => d.status === 'online').length;
  const total  = devices.length;
  // The rail: nav.tsx projects the visible dashboard groups (tenant → Store →
  // lenses, computed once above) onto rail groups; the active one is the rail
  // group owning the active tab's dashboard group ('settings' is pinned).
  const sections = railSections(visibleGroups);
  const activeRailId = railGroupOf(groupOf(activeTab));
  const railGroup = sections.flatMap(s => s.groups).find(g => g.id === activeRailId);
  // The panel entries for the active rail group; an open device shows up under
  // Devices as its own entry (picking Fleet closes it).
  const subTabs = [
    ...(railGroup?.tabs ?? []),
    ...(activeRailId === 'devices' && selectedDevice ? [{ id: 'device-detail' as TabId, label: selectedDevice.name }] : []),
  ];

  // Start a fresh feature interview. Builder no longer hosts its own chat — the conversation
  // runs in the shared agent panel at the bottom, so App creates the kind='builder' session (the
  // agent-worker recognises that kind and runs the feature-interview persona) and opens it there.
  function startFeatureInterview() {
    setBuilderOpen(true);
    setActiveTab('builder');
    void createSession('builder');
  }
  // Back-compat alias for existing callers (sidebar nav, Agents tab).
  const openBuilder = startFeatureInterview;

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    setDragging(true);
    function onMove(ev: MouseEvent) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct  = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(80, Math.max(20, pct)));
    }
    function onUp() {
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const tabContent = (
    <>
      {/* Override slot: the reconfigured body for the active tab, when one is
          registered (src/overrides). Mounted only while its tab is active. */}
      {ActiveOverride && (
        <div style={{ display: 'flex', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
          <ActiveOverride />
        </div>
      )}

      <div style={{ display: shownTab === 'overview' ? 'flex' : 'none', flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <OverviewTab
          // Builds the empty brain's four Store seeds (Devices / Admin / Dev / Finance) and
          // gates each one's Quickstart on a source of that app actually being connected.
          sources={sources}
          // The fleet the Devices seed spawns around itself once activated (real rows,
          // mocks included — deliberately NOT masked by onboarding mode).
          devices={devices}
          // Demo mode: the one button. runBreakHeal borrows a pool L2 (the demo project
          // owns no L2 → device_id '') and arms the story exactly like the Devices node.
          onSelfHealDemo={DEMO_MODE ? runBreakHeal : undefined}
          demoLive={!!demoStory}
          demoRunning={!!demoStory && !demoDone}
          brain={{ nodePanel, focusId: demoFocusId, markerId: demoMarkerId, hiddenKeys: brainHiddenKeys }}
          // The chat half of the brain card. Its selected thread is lifted here so
          // the console pane on the right renders the same conversation.
          chat={(
            <ProjectChat
              sessionId={chatSessionId}
              onSessionChange={setChatSessionId}
              collapsed={sidePane !== 'chats'}
              onCollapsedChange={c => setSidePane(c ? null : 'chats')}
            />
          )}
        />
      </div>

      <div style={{ display: shownTab === 'follow-us' ? 'flex' : 'none', flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <FollowUsTab />
      </div>

      <div style={{ display: shownTab === 'settings' ? 'flex' : 'none', flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <SettingsTab />
      </div>

      <div style={{ display: shownTab === 'agent-management' ? 'contents' : 'none' }}>
        <AgentManagementTab isMobile={isMobile} onOpenBuilder={openBuilder} />
      </div>

      {/* viewTransitionName: the brain's tab panel grows into this box on ⤢ (openTabFullScreen). */}
      <div style={{ display: shownTab === 'dashboard' ? 'flex' : 'none', flex: 1, minHeight: 0, overflowY: 'auto', viewTransitionName: 'tab-panel' }}>
        <div style={{ padding: 8, width: '100%' }}>
          <DeviceTable
            devices={devices}
            onOpenDevice={openDevice}
            onRenameDevice={setDeviceName}
            queryMode={queryMode}
            onQueryClick={handleQueryClick}
          />
        </div>
      </div>

      <div style={{ display: shownTab === 'crash' ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden', viewTransitionName: 'tab-panel' }}>
        <CrashTab queryMode={queryMode} onQueryClick={handleQueryClick} />
      </div>

      <div style={{ display: shownTab === 'ota' ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden', viewTransitionName: 'tab-panel' }}>
        <OtaTab
          focusDeploymentId={otaFocusDeployment}
          queryMode={queryMode}
          onQueryClick={handleQueryClick}
          onShipped={(deploymentId) => {
            setShippedUpdate(true);
            // Open the floating upload wizard on the rollout that was just created.
            setActiveOtaRolloutId(deploymentId);
          }}
        />
      </div>

      <div style={{ display: shownTab === 'groups' ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <GroupsTab queryMode={queryMode} onQueryClick={handleQueryClick} />
      </div>

      <div style={{ display: shownTab === 'enrollment' ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <EnrollmentTab queryMode={queryMode} onQueryClick={handleQueryClick} />
      </div>

      <div style={{ display: shownTab === 'hardware' ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <HardwareTab actions={deviceActions} />
      </div>

      <div style={{ display: shownTab === 'github' ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <GithubTab
          onOpenDeployment={openDeployment}
          openConnect={openGithubConnect}
          onConnectHandled={() => setOpenGithubConnect(false)}
          queryMode={queryMode}
          onQueryClick={handleQueryClick}
        />
      </div>

      {/* Mounted only while shown: a display:none BrainCard still runs its 15s
          poll, the O(n²) layout/merge memos and the glow tick, and a second
          graph doubles the main-thread cost of every App render. */}
      {shownTab === 'brain' && (
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <BrainCard source={projectBrainSource} hiddenKeys={brainHiddenKeys} nodePanel={nodePanel} />
        </div>
      )}

      <div style={{ display: shownTab === 'policy' ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <PolicyTab isMobile={isMobile} />
      </div>

      <div style={{ display: shownTab === 'builder' ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <BuilderTab
          isMobile={isMobile}
          onApproveBuild={setActiveBuildFeatureId}
          onFeatureRemoved={id => setActiveBuildFeatureId(prev => (prev === id ? null : prev))}
          onDevelopFeature={() => startFeatureInterview()}
          queryMode={queryMode}
          onQueryClick={handleQueryClick}
        />
      </div>

      <div style={{ display: shownTab === 'code' ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden', viewTransitionName: 'tab-panel' }}>
        <CodeTab />
      </div>

      {DEV_MODE && (
        <div style={{ display: shownTab === 'security' ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <SecurityTab isMobile={isMobile} />
        </div>
      )}

      {hasSelectedDeviceRef.current && (
        <div style={{ display: shownTab === 'device-detail' ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <DeviceDetailTab
            device={lastSelectedDeviceRef.current!}
            queryMode={queryMode}
            onQueryClick={handleQueryClick}
            isMobile={isMobile}
          />
        </div>
      )}
    </>
  );

  // Rail footer slot: the dashboard-only controls that nff-admin's rail has no
  // equivalent for. Desktop: icon-only in the 48px collapsed rail, labels on
  // hover (like the pinned Settings row); the phone drawer always shows labels. The rail header shows only a tenant's
  // branding (see the Sidebar's `brand` prop below); the online count is in the
  // phone header and the project switcher lives in Settings → Project.
  const railFooter = (
    <div>
      <button
        data-tour="tour-launch"
        onClick={e => { e.stopPropagation(); onboarding.start(); }}
        title="Take the product tour"
        className="mb-1 flex w-full items-center gap-1.5 whitespace-nowrap border border-ink bg-paper px-1.5 py-0.5 text-[11px] font-bold text-ink"
      >
        <CircleHelp size={16} strokeWidth={1.75} className="shrink-0 opacity-70" />
        <span className="md:hidden md:group-hover/rail:inline">Tour</span>
      </button>
      {/* Local only (DEV_MODE): pretend this workspace is brand new — empty brain,
          no sources, closed lenses — so the onboarding flow can be walked through on
          a real account. Reloads, which is what resets the tour's gates. */}
      {DEV_MODE && (
        <button
          onClick={e => { e.stopPropagation(); setOnboardingMode(!ONBOARDING_MODE); }}
          title={ONBOARDING_MODE
            ? 'Back to your real brain, sources and rail'
            : 'Local only: fake a brand-new workspace and replay onboarding'}
          className="mb-1 flex w-full items-center gap-1.5 whitespace-nowrap border border-ink bg-paper px-1.5 py-0.5 text-[11px] font-bold text-ink"
        >
          {ONBOARDING_MODE ? <Undo2 size={16} strokeWidth={1.75} className="shrink-0 opacity-70" /> : <Sprout size={16} strokeWidth={1.75} className="shrink-0 opacity-70" />}
          <span className="md:hidden md:group-hover/rail:inline">{ONBOARDING_MODE ? 'Exit onboarding' : 'Onboarding'}</span>
        </button>
      )}
      {/* Demo mode (any build): a ready-made workspace — canned brain, the account's
          mock fleet, Overview only — with one "trigger the self-heal demo" button. */}
      <button
        onClick={e => { e.stopPropagation(); setDemoMode(!DEMO_MODE); }}
        title={DEMO_MODE
          ? 'Back to your own workspace, brain and rail'
          : 'Show nff off: a ready-made workspace with a mock fleet and a one-click self-heal'}
        className="mb-1 flex w-full items-center gap-1.5 whitespace-nowrap border border-ink bg-paper px-1.5 py-0.5 text-[11px] font-bold text-ink"
      >
        {DEMO_MODE ? <Undo2 size={16} strokeWidth={1.75} className="shrink-0 opacity-70" /> : <Clapperboard size={16} strokeWidth={1.75} className="shrink-0 opacity-70" />}
        <span className="md:hidden md:group-hover/rail:inline">{DEMO_MODE ? 'Exit demo' : 'Demo'}</span>
      </button>
      <ProfileMenu
        onFeedback={() => setFeedbackOpen(f => !f)}
        onOpenAccount={() => { setAccountOpen('profile'); setMobileSidebarOpen(false); }}
      />
    </div>
  );

  return (
      <div className="flex h-full flex-col" onClick={() => setQueryTarget(null)}>
      {/* Beta notice across the whole shell, above the rail — as nff-admin does.
          A mode takes the same strip over (replaces, never stacks): it says out
          loud why the brain/rail look the way they do — the rail is 48px until
          hovered, so its Exit button alone is too easy to miss. */}
      {DEMO_MODE ? (
        <BetaBanner
          tag="DEMO"
          action={
            <button onClick={() => setDemoMode(false)} className="border border-paper px-2 py-0.5 font-bold">
              Exit
            </button>
          }
        >
          🎬 A ready-made workspace with a mock fleet. Your own workspace is untouched.
        </BetaBanner>
      ) : ONBOARDING_MODE ? (
        <BetaBanner
          tag="ONBOARDING"
          action={
            <button onClick={() => setOnboardingMode(false)} className="border border-paper px-2 py-0.5 font-bold">
              Exit
            </button>
          }
        >
          🌱 Local only. Your real brain, sources and devices are hidden, not deleted.
        </BetaBanner>
      ) : (
        <BetaBanner />
      )}
      <div className="flex min-h-0 flex-1">
      {/* The shared rail (src/core/components/Sidebar.tsx) — nff-admin's
          chrome, fed with this app's nav.tsx. Desktop: 48px icon rail that
          expands on hover; phone: a drawer opened from the header below. */}
      <Sidebar<TabId>
        sections={sections}
        activeGroupId={activeRailId}
        onChange={handleNav}
        pinned={DEMO_MODE ? [] : [SETTINGS_RAIL]}
        // The header slot carries the tenant's personalisation (custom domain →
        // its name + logo, e.g. "Gauthier" on gauthier.nanoforgeflow.com);
        // the unbranded app reads "nff-app", mirroring nff-admin's own mark.
        brand={tenant ? { name: tenant.displayName, logoUrl: tenant.logoUrl } : { name: 'nff-app' }}
        footer={railFooter}
        open={mobileSidebarOpen}
        onClose={() => setMobileSidebarOpen(false)}
        view={STANDALONE}
      />

      {/* Second sidebar: the rail is the global nav, this panel lists the
          active group's pages (desktop only). */}
      {subTabs.length > 1 && (
        <SubTabBar variant="panel" label={railGroup?.label ?? ''} tabs={subTabs} active={activeTab} onChange={handleNav} />
      )}

      {/* Main pane */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          position: 'relative',
          userSelect: dragging ? 'none' : 'auto',
        }}
      >
        {/* Phone-only slim header — desktop nav lives entirely in the rail. */}
        <header className="flex items-center gap-2 border-b border-ink px-4 py-2 md:hidden">
          <button
            onClick={e => { e.stopPropagation(); setMobileSidebarOpen(true); }}
            aria-label="Open navigation"
            className="-ml-2 flex h-10 w-10 items-center justify-center text-ink"
          >
            ☰
          </button>
          <span className="flex-1 text-sm font-bold text-ink">{tenant?.displayName ?? 'nff-app'}</span>
          <span className="text-xs text-muted">{online}/{total} online</span>
        </header>

        {/* Split row: tab content, then the console pane on the right (Overview
            only) — giving chats | conversation | brain | console, the last two
            being the same thread seen twice. */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>

        {/* Tab content area — width comes from flex; the console pane takes the rest. */}
        <div data-tour="main-content" style={{
          flex: 1, minWidth: 0,
          minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        }}>
          {/* Phone: the panel's pages as a strip under the header. */}
          {subTabs.length > 1 && (
            <SubTabBar variant="strip" label={railGroup?.label ?? ''} tabs={subTabs} active={activeTab} onChange={handleNav} />
          )}
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {tabContent}
          </div>
        </div>

        {/* Drag handle — desktop only, Overview only, console open only (it sizes the console pane) */}
        {!isMobile && activeTab === 'overview' && consoleOpen && (
          <div
            onMouseDown={startDrag}
            style={{ width: 5, flexShrink: 0, background: '#000', cursor: 'col-resize' }}
          />
        )}

        {/* Pull-tab — vertical rail on the edge of the page. */}
        {activeTab === 'overview' && (
          <button
            onClick={() => {
              const opening = sidePane !== 'console';
              // Opening the console always lands on the most recent conversation:
              // clearing the id lets ProjectChat resolve to the newest thread and
              // report it back, so both panes start on what just happened.
              if (opening) setChatSessionId(null);
              setSidePane(opening ? 'console' : null);
            }}
            aria-label={consoleOpen ? 'Hide console' : 'Show console'}
            title={consoleActive ? 'Agent is calling tools' : consoleOpen ? 'Hide the console' : 'Show the console'}
            className={`flex w-6 shrink-0 items-center justify-center border-l border-ink py-3 text-[11px] uppercase tracking-label text-ink [writing-mode:vertical-rl] hover:bg-ink hover:text-paper${consoleActive ? ' nff-blink-bw' : ''}`}
          >
            {consoleOpen ? '▸ Console' : '◂ Console'}
          </button>
        )}

        {/* Agent console — slides in on the right of the Overview, hidden by default,
            showing the tool transcript of the very conversation the chat half is
            having. Kept mounted (display:none elsewhere / while closed) so its
            scrollback/pagination survive tab switches like every other tab.
            Phone: width 100% + shrink-0 collapses the flex:1 content column to 0, so the
            console takes the screen and the rail above is the way back — no extra branch. */}
        <div data-tour="agent-panel" style={{
          // Only display:none OFF the Overview. On it the pane stays in flow at
          // width 0 so opening and closing is a plain horizontal width animation
          // — the content column (flex: 1) gives back exactly what this takes.
          // A view transition here morphed the whole page and read as diagonal.
          ...(activeTab === 'overview' ? {} : { display: 'none' }),
          flexShrink: 0,
          width: consoleOpen ? (isMobile ? '100%' : `${100 - splitPct}%`) : 0,
          borderLeft: consoleOpen ? '1px solid #000' : 'none',
          // No transition mid-drag: the handle sets the width every mousemove.
          transition: dragging ? 'none' : 'width 180ms ease-out',
          minHeight: 0, overflow: 'hidden',
        }}>
          <ConsoleTab sessionId={chatSessionId} onActiveChange={setConsoleActive} />
        </div>

        </div>
      </div>

      {queryTarget && (
        <QueryPopup
          anchor={queryTarget.anchor}
          context={queryTarget.context}
          onClose={() => setQueryTarget(null)}
        />
      )}
      {feedbackOpen && (
        <FeedbackPopup onClose={() => setFeedbackOpen(false)} />
      )}
      {accountOpen && (
        <AccountSettingsModal initialSection={accountOpen} onClose={() => setAccountOpen(null)} />
      )}
      {onboarding.open && !onboarding.path && (
        <OnboardingPathModal onPick={onboarding.choosePath} />
      )}
      {onboarding.open && onboarding.path && (
        <OnboardingTour
          steps={tourSteps}
          signals={tourSignals}
          onNavigate={setActiveTab}
          onFinish={onboarding.finish}
        />
      )}
      {deployTourOpen && (
        <OnboardingTour
          steps={DEPLOY_STEPS}
          signals={deploySignals}
          onNavigate={setActiveTab}
          onFinish={() => setDeployTourOpen(false)}
        />
      )}
      {flashOpen && (
        <WebFlashModal onClose={() => setFlashOpen(false)} projectId={currentProject.id} />
      )}
      {wifiHandoffOpen && (
        <WifiHandoffModal
          onClose={() => setWifiHandoffOpen(false)}
          onSuccess={() => {}}
        />
      )}
      {checklistFeatureId && (
        <BuildChecklistModal
          featureId={checklistFeatureId}
          onDismiss={() => setActiveBuildFeatureId(null)}
          onGoToCode={() => setActiveTab('code')}
          onGoToBuilder={() => { setBuilderOpen(true); setActiveTab('builder'); }}
        />
      )}
      {activeOtaRolloutId && (
        <OtaRolloutModal
          deploymentId={activeOtaRolloutId}
          onDismiss={() => setActiveOtaRolloutId(null)}
          onOpenOta={() => openDeployment(activeOtaRolloutId)}
          raised={!!checklistFeatureId}
        />
      )}

      {/* Guided demo: when the fix starts/finishes streaming, jump to Code / back to Dashboard.
          Headless — hosts the chatty code-stream subscription so App doesn't re-render on frames. */}
      <DemoCodeWatcher
        story={demoStory}
        sessionId={demoSessionId}
        onCodeStart={handleCodeStart}
        onFixShipped={handleFixShipped}
      />

      {/* Any-origin "plan awaiting approval" pointer: whenever a feature reaches 'planned' —
          typed chat or CLI — nudge toward the Builder tab's Approve button. */}
      <PlanReadyWatcher
        features={builderFeatures}
        suppressSessionId={null}
        activeTab={activeTab}
        onPlanReady={handlePlanReady}
      />

      {/* Guided demo: the agent's fix is compiled for real AFTER submit_firmware_fix returns, so a
          build failure only ever surfaced on firmware_fix_jobs, which nothing read. Headless. */}
      <DemoFixWatcher deviceId={demoBrokenDeviceId} onFixFailed={handleFixFailed} />

      {/* Global: loud top-right warning toast(s) the instant a device crashes. Fed by
          handleFreshCrash (the same fresh-crash edge below). */}
      <CrashToast
        toasts={crashToasts}
        onDismiss={id => setCrashToasts(prev => prev.filter(c => c.id !== id))}
        onView={() => setActiveTab('crash')}
      />

      {/* Gentle "something's happening on another tab" toast (fix failed, plan ready, the
          break's opening commit). Bottom-left, so it clears the CrashToast + FleetIncidentModal. */}
      <DemoActivityToast
        activity={demoActivity}
        onDismiss={dismissActivity}
        onGo={goToActivityTab}
      />

      {/* Self-heal demo: the policy layer just recorded a (state, action, state') transition —
          reveal the mini node chain. Stacks above DemoActivityToast when a beat is visible. */}
      <PolicyActivityToast
        activation={shownPolicyActivation}
        onDismiss={() => setPolicyToastDismissed(policyActivation?.key ?? null)}
        raised={demoActivity !== null}
      />

      {/* Global: a device just crashed (demo break/self-heal or a real panic) → surface it.
          onFreshCrash advances the guided demo to the Crash tab (gated on an active demo story). */}
      <FleetIncidentModal
        onFreshCrash={handleFreshCrash}
        onGoToCrash={() => setActiveTab('crash')}
        onGoToAgent={() => setActiveTab('overview')}
      />

      {/* Global: a deployment paused by the per-device OTA rate limit asks for a decision. */}
      <RateLimitGuard />
      </div>
      </div>
  );
}

export default App;
