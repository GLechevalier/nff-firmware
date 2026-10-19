import type { TabId } from './TabBar';
import type { OnboardingPath } from '../../hooks/useOnboarding';

/**
 * Live conditions a step can wait on, evaluated by whoever renders the tour against real
 * app state — so a gated step is satisfied by the user actually doing the thing, never by
 * clicking Next.
 */
export type StepSignal =
  | 'group-exists' | 'repo-connected' | 'deployment-created'   // DEPLOY_STEPS
  | 'hub-revealed' | 'target-selected'                          // onboardingSteps: the brain beats
  | 'any-source' | 'second-source' | 'nodes-added' | 'chat-replied'; // onboardingSteps

export interface OnboardingStep {
  /**
   * data-tour attribute value(s) of the element(s) to spotlight. Provide several
   * to highlight more than one region at once — e.g. the tab's switch button AND
   * its content area, so the user sees both where to click and what's inside.
   * Omit for a centered card.
   */
  anchor?: string | string[];
  /** Switch the dashboard to this tab before showing the step, so the anchor is visible. */
  tab?: TabId;
  title: string;
  body: string;
  /** Hold Next (and the arrow keys) until this signal turns true. */
  await?: StepSignal;
  /** Offer an explicit "Skip this step" escape while gated — for genuinely optional work. */
  skippable?: boolean;
  /** Shown under the body while gated, in place of the generic "waiting" line. */
  waitingHint?: string;
  /** Move on by itself the moment `await` turns true (a "hover this" / "click that" beat). */
  autoAdvance?: boolean;
}

/**
 * The brain node each onboarding path walks the user to first: the seed satellite's id
 * (`tab-<rail>`, brainMasters.deriveSeedGraph — the same id the client-derived master has
 * once the brain is populated) and its title as the graph shows it.
 */
export const TOUR_TARGET: Record<OnboardingPath, { id: string; title: string; body: string }> = {
  'dev-physical': {
    id: 'tab-devices', title: 'Devices',
    body: 'Click Devices. Your fleet lives here: every board you flash or enroll, with its health, crashes and OTA updates.',
  },
  'dev-soft': {
    id: 'tab-dev', title: 'Dev',
    body: 'Click Dev. Everything that builds and ships the product lives here: repos, pipelines, deployments and cloud projects.',
  },
};

/**
 * "Grow your brain": the tour is the loop, not a slideshow. Every gated step waits on the
 * user really doing the thing (App feeds `signals` from useSourceStatus + the sync/chat
 * events), and every gate is skippable so nobody is ever stuck behind a connector they
 * don't have. The three brain beats after the intro auto-advance: hover the core
 * (`brain-hub`), click the path's node (`brain-node-<id>`, BrainGraph.tsx), then the side
 * panel that opened (`brain-side-panel`, BrainCard.tsx). Other overview steps anchor the
 * graph box itself (`brain-graph`); the chat step anchors `main-content`.
 */
export function onboardingSteps(path: OnboardingPath): OnboardingStep[] {
  const target = TOUR_TARGET[path];
  return [
  {
    tab: 'overview',
    anchor: 'brain-graph',
    title: 'This is your brain',
    body: 'This graph is your company brain — everything nff knows about your devices, code, cloud, money and mail, as nodes the agent reasons over. It starts as one blinking core, and it grows from the sources you pick. Let\'s grow it.',
  },
  {
    tab: 'overview',
    anchor: 'brain-hub',
    await: 'hub-revealed',
    autoAdvance: true,
    skippable: true,
    waitingHint: 'Hover the core to open it.',
    title: 'Hover the core',
    body: 'This is the agent\'s core. Hover it: it opens into the apps it can connect to.',
  },
  {
    tab: 'overview',
    anchor: `brain-node-${target.id}`,
    await: 'target-selected',
    autoAdvance: true,
    skippable: true,
    waitingHint: `Click ${target.title} to open it.`,
    title: `Open ${target.title}`,
    body: target.body,
  },
  {
    tab: 'overview',
    anchor: 'brain-side-panel',
    await: 'any-source',
    skippable: true,
    waitingHint: 'Waiting for a source to connect — or skip and keep looking around.',
    title: 'Connect one source',
    body: `This is ${target.title}'s panel. Activate it, and its part of the Store opens here — each row says what it adds to your brain and what you'll be able to ask. Connect one source, and product areas appear on the rail as it comes online.`,
  },
  {
    tab: 'overview',
    anchor: 'brain-graph',
    await: 'nodes-added',
    skippable: true,
    waitingHint: 'Syncing your source into the brain…',
    title: 'Watch it grow',
    body: 'The moment a source connects, nff mirrors it in: a master node per source, a node per repo, deployment, device or transaction, placed beside whatever it already relates to. The glowing nodes are the ones that just arrived. The ⟳ Sync database button on the rail does the same on demand.',
  },
  {
    tab: 'overview',
    anchor: 'main-content',
    await: 'chat-replied',
    skippable: true,
    waitingHint: 'Ask the agent anything — one reply completes this step.',
    title: 'Ask it something',
    body: 'Ask a question only your source can answer — "what shipped this week?", "which devices crashed?". The agent answers from the brain and acts through your connected tools; the graph beside the chat lights up the nodes it touches, and pulling ◂ Console open shows every tool it runs. What it learns along the way becomes new nodes.',
  },
  {
    tab: 'overview',
    anchor: 'brain-graph',
    await: 'second-source',
    skippable: true,
    waitingHint: 'Waiting for a second source — or skip.',
    title: 'Add a second source',
    body: 'Click the core for the whole Store, or another of its children. One source is a list. Two is a graph: nff links related nodes across sources — the repo to the rollout it shipped, the deployment to the device that crashed on it, the invoice to the supplier. This is where the brain starts paying for itself.',
  },
  {
    tab: 'overview',
    anchor: 'brain-graph',
    title: 'Keep growing',
    body: 'Hardware is a source like any other: the Devices node flashes an ESP32 over USB, enrolls it, moves it to WiFi and ships firmware to it — then nff watches it, and heals it when it crashes. Every new source unlocks its area on the rail. Replay this tour any time from "? Tour" at the bottom of the rail.',
  },
  ];
}

/**
 * The Deploy walkthrough, launched from the Devices source card's "Ship firmware". Unlike the
 * tour above — which narrates — this one makes the user *do* the loop: create a group, point
 * a repo at it, and ship. Every step after the first waits on a real signal, so it cannot be
 * clicked through. Connecting a repo is the one optional step: skip it and the demo repo stands in.
 */
export const DEPLOY_STEPS: OnboardingStep[] = [
  {
    tab: 'groups',
    anchor: ['subtab-groups', 'subtab-github', 'subtab-ota'],
    title: 'Deploy has three parts',
    body: 'Groups say WHICH devices get an update. GitHub says WHERE the firmware comes from. Releases is where an update actually goes out. We\'ll do all three, in order.',
  },
  {
    tab: 'groups',
    anchor: 'groups-create',
    await: 'group-exists',
    waitingHint: 'Waiting for you to create your first group…',
    title: 'Create a group',
    body: 'A group is how nff knows which devices an update is for. You wire each one to a branch: a "canary" group on your staging branch hits a handful of lab devices you can physically reach, so a bad build stops there. A "whole_fleet" group on main hits everything. Name and create your first group to continue.',
  },
  {
    tab: 'github',
    anchor: 'github-connect',
    await: 'repo-connected',
    skippable: true,
    waitingHint: 'Waiting for you to connect a repo — or skip and keep the demo one.',
    title: 'Connect a repo',
    body: 'Point nff at a GitHub repo and a branch, and pick the group that branch deploys to. From then on, pushing to that branch builds the firmware and rolls it out — there is no CI to configure. No repo handy right now? Skip this and we\'ll keep using the demo repo.',
  },
  {
    tab: 'ota',
    anchor: 'ota-trigger',
    await: 'deployment-created',
    waitingHint: 'Waiting for you to trigger the update…',
    title: 'Ship it',
    body: 'This is the moment everything else was for. Trigger an update to the group you just made, and watch each device download, verify, install and reboot onto the new firmware — live.',
  },
];
