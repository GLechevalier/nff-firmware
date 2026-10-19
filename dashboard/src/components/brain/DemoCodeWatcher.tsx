import { useEffect } from 'react';
import { useCodeStream } from '../../hooks/useCodeStream';

// The break-and-heal demo's guided-navigation state machine. Armed when a break is fired
// (App.beginDemoStory) and advanced by realtime signals as the story unfolds:
//   crash   → waiting for the panic report          → (optional) beat on the Crash tab
//   code    → the agent's code stream is live        → jump to the Code tab (watch the fix)
//   deploy  → the fix shipped                        → beat on the Deploy/OTA tab
//   recover → the OTA is rolling out                 → back to the Dashboard (watch it heal green)
// The Code leg is driven by the (reliable, caller-project) code stream — NOT the fragile
// cross-project crash edge — so a missed crash can't strand the story on 'crash'.
export type DemoPhase = 'crash' | 'code' | 'deploy' | 'recover';
export interface DemoStory {
  phase: DemoPhase;
  armedAt: number; // epoch ms; navs never fire past DEMO_STORY_TTL so a stale story can't yank a tab
}

// Safety cap on the whole story — generous enough to cover a COLD L2 real-compile + OTA recovery
// (a cold compile can take several minutes before the device even crashes), but bounded so an
// abandoned demo (crash that never came, fix that never finished) can't auto-navigate later.
export const DEMO_STORY_TTL = 20 * 60_000;

interface Props {
  story: DemoStory | null;
  sessionId: string | null; // the demo's chat session; matches LiveCodeSession.sessionId
  onCodeStart: () => void;   // agent began writing the fix → Code tab (code phase)
  onFixShipped: () => void;  // code stream terminal → fix submitted → Deploy beat (deploy phase)
}

// Headless: consumes the (chatty) code-stream subscription here so App doesn't re-render on every
// reasoning delta, and drives the code-phase legs of the demo story. Crash detection is handled
// separately by FleetIncidentModal's existing fresh-crash edge (see App wiring).
export function DemoCodeWatcher({ story, sessionId, onCodeStart, onFixShipped }: Props) {
  const { live } = useCodeStream();
  useEffect(() => {
    if (!story || Date.now() - story.armedAt > DEMO_STORY_TTL) return;
    // Match the demo's own run (sessionId), so an unrelated code run never triggers navigation.
    const s = live.find(x => (sessionId ? x.sessionId === sessionId : true));
    if (!s) return;
    // Code leg is EDGE-TRIGGERED on 'crash' only: the code stream (reliable, caller-project) is the
    // driver, so a missed crash edge can't strand the story before the Code tab. It must NOT also
    // match 'code' — the stream stays 'streaming' for the whole (multi-minute) fix and re-runs this
    // effect on every reasoning-delta frame, so re-firing onCodeStart there floods the narration
    // toast (a fresh-id toast per frame, which also defeats its auto-dismiss). onCodeStart moves the
    // story to 'code', so firing on 'crash' alone runs it exactly once.
    if (story.phase === 'crash' && s.status === 'streaming') {
      onCodeStart();
    } else if (
      story.phase === 'code' &&
      (s.status === 'done' || s.status === 'pr_opened' || s.status === 'error' || !s.live)
    ) {
      onFixShipped();
    }
    // Phase transitions are the guard: onCodeStart moves the story to 'code', and onFixShipped
    // moves it to 'deploy', so the branches stop matching and each leg fires once without edge refs.
  }, [story, sessionId, live, onCodeStart, onFixShipped]);
  return null;
}
