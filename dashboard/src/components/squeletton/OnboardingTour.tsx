import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BRAND_ACCENT } from '../../lib/brand';
import type { TabId } from './TabBar';
import type { OnboardingStep, StepSignal } from './onboardingSteps';
import { useIsMobile } from '../../hooks/useIsMobile';

interface Props {
  steps: OnboardingStep[];
  onNavigate: (tab: TabId) => void;
  onFinish: () => void;
  /**
   * Live truth for steps that declare `await`. A gated step holds Next until its signal is
   * true, so the user can't read past work they haven't done. Omit for narrating tours.
   */
  signals?: Partial<Record<StepSignal, boolean>>;
}

interface Rect { top: number; left: number; width: number; height: number; }

const CARD_W = 300;
const GAP = 12;       // distance between spotlight and popover card
const PAD = 6;        // padding of the spotlight ring around each target
const MARGIN = 10;    // min distance kept from viewport edges

/**
 * Spotlight + popover onboarding tour. Dims the screen and cuts a bright ring
 * around each of the current step's `[data-tour]` targets — typically a tab's
 * switch button AND its content area, so the user sees both where to click and
 * what's inside. Steps that declare a `tab` switch the dashboard first so the
 * targets render. The card is placed beside the first target. On mobile (where
 * the sidebar is a closed drawer) it falls back to centered cards.
 *
 * Multiple holes need an SVG mask (the single-element box-shadow trick can only
 * cut one). Styling mirrors the app's hand-built modals: monospace, 1px solid
 * black borders, boxy `4px 4px 0 #000` shadow.
 *
 * A step may also `await` a signal, which holds Next until the user has really done the
 * thing (see DEPLOY_STEPS). The overlay never swallows pointer events: the user is meant to
 * be hovering and working behind it, so dismissal is Esc / Skip tour only.
 */
export function OnboardingTour({ steps, onNavigate, onFinish, signals }: Props) {
  const isMobile = useIsMobile();
  const [i, setI] = useState(0);
  const [rects, setRects] = useState<Rect[]>([]);
  const step = steps[i];
  const isFirst = i === 0;
  const isLast = i === steps.length - 1;
  const gated = step.await != null && !signals?.[step.await];

  // Switch tab when entering a step that targets one. Runs before paint so the
  // measurement below sees the new tab's DOM.
  useLayoutEffect(() => {
    if (step.tab) onNavigate(step.tab);
  }, [i, step.tab, onNavigate]);

  const measure = useCallback(() => {
    if (isMobile || !step.anchor) { setRects([]); return; }
    const anchors = Array.isArray(step.anchor) ? step.anchor : [step.anchor];
    const found: Rect[] = [];
    for (const a of anchors) {
      const el = document.querySelector(`[data-tour="${a}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        found.push({ top: r.top, left: r.left, width: r.width, height: r.height });
      }
    }
    // Same rects → same state object, so a scroll that moved nothing does not repaint the mask.
    setRects(prev => sameRects(prev, found) ? prev : found);
  }, [isMobile, step.anchor]);

  // Re-measure every frame: the anchors move — brain nodes slide out of the core on 400ms CSS
  // transitions, the side panel eases open, the page scrolls — and the ring must ride on them,
  // not catch up. One getBoundingClientRect per anchor per frame is cheap; the mask only
  // re-renders on frames where something actually moved (sameRects), so an idle tour costs
  // nothing. Covers resize and scroll too, so no listeners.
  useEffect(() => {
    let raf = requestAnimationFrame(function loop() { measure(); raf = requestAnimationFrame(loop); });
    return () => cancelAnimationFrame(raf);
  }, [measure]);

  // `advance` bypasses the gate — it backs the explicit "Skip this step" button only.
  const advance = useCallback(() => {
    if (isLast) onFinish(); else setI(n => n + 1);
  }, [isLast, onFinish]);

  // A step that says "hover this" / "click that" moves on by itself the moment it is done —
  // the next spotlight IS the feedback, no Next click in between. Only when the gate opens
  // WHILE the user is on the step: entered with its signal already true (Back onto it, or the
  // thing was done earlier) it waits for Next, or Back would bounce straight forward again.
  const armed = useRef(false);
  useEffect(() => { armed.current = false; }, [i]);
  useEffect(() => {
    if (!step.autoAdvance) return;
    if (gated) armed.current = true;
    else if (armed.current) advance();
  }, [i, step.autoAdvance, gated, advance]);
  const next = useCallback(() => { if (!gated) advance(); }, [gated, advance]);
  const back = useCallback(() => setI(n => Math.max(0, n - 1)), []);

  // Dismissing the whole tour. A gated step must survive a stray Esc or backdrop click:
  // the user is working behind the overlay, and losing the walkthrough mid-task is worse
  // than having to reach for Skip.
  const dismiss = useCallback(() => { if (!gated) onFinish(); }, [gated, onFinish]);

  // Keyboard: Esc skips, arrows move. Capture phase so it wins over tab handlers.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [next, back, dismiss]);

  const card = (
    <div
      style={{
        width: CARD_W, maxWidth: '90vw',
        background: '#fff', border: '1px solid #000', boxShadow: '4px 4px 0 #000',
        boxSizing: 'border-box',
        pointerEvents: 'auto',   // the overlay goes click-through while gated; the card must not
      }}
      onClick={e => e.stopPropagation()}
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: BRAND_ACCENT, color: '#fff', padding: '6px 10px', fontSize: 12, fontWeight: 'bold',
      }}>
        <span>{step.title}</span>
        <span style={{ fontSize: 11, opacity: 0.7 }}>{i + 1} / {steps.length}</span>
      </div>

      <div style={{ padding: '12px 12px 6px', fontSize: 12, color: '#333', lineHeight: 1.6 }}>
        {step.body}
      </div>

      {gated && (
        <div style={{ padding: '2px 12px 0', fontSize: 11, color: '#666', display: 'flex', gap: 6 }}>
          <span aria-hidden>⧗</span>
          <span>{step.waitingHint ?? 'Complete this step to continue.'}</span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px 12px' }}>
        <button onClick={onFinish} style={linkBtn}>Skip tour</button>
        <div style={{ flex: 1 }} />
        {gated && step.skippable && (
          <button onClick={advance} style={ghostBtn}>Skip this step</button>
        )}
        {!isFirst && <button onClick={back} style={ghostBtn}>Back</button>}
        <button
          onClick={next}
          disabled={gated}
          style={gated ? disabledBtn : primaryBtn}
        >
          {isLast ? 'Done' : 'Next →'}
        </button>
      </div>
    </div>
  );

  // Centered card: welcome/closing steps, anchorless steps, or mobile.
  if (rects.length === 0) {
    return (
      <div style={overlay}>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)' }} />
        <div style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1,
        }}>
          {card}
        </div>
      </div>
    );
  }

  // Spotlight: dim the screen with an SVG mask that punches a hole for every
  // target rect, draw a black ring around each, and place the card beside the
  // first target (the switch button) so it points into the highlighted content.
  const holes = rects.map(r => ({
    top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2,
  }));
  const pos = placeCard(holes[0]);

  return (
    <div style={overlay}>
      <svg style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
        <defs>
          <mask id="nff-tour-mask">
            <rect x={0} y={0} width="100%" height="100%" fill="#fff" />
            {holes.map((h, k) => (
              <rect key={k} x={h.left} y={h.top} width={h.width} height={h.height} rx={2} fill="#000" />
            ))}
          </mask>
        </defs>
        <rect x={0} y={0} width="100%" height="100%" fill="rgba(0,0,0,0.55)" mask="url(#nff-tour-mask)" />
      </svg>

      {holes.map((h, k) => (
        <div key={k} style={{
          position: 'fixed', top: h.top, left: h.left, width: h.width, height: h.height,
          border: '2px solid #000', borderRadius: 2, boxSizing: 'border-box', pointerEvents: 'none',
        }} />
      ))}

      {/* The ring tracks the target per frame; the card only glides after it. */}
      <div style={{ position: 'fixed', top: pos.top, left: pos.left, transition: 'top 200ms ease, left 200ms ease' }}>
        {card}
      </div>
    </div>
  );
}

/** Place the card to the right of the spotlight if it fits, else left, else clamp to viewport. */
function placeCard(spot: Rect): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const estH = 180; // approximate card height for vertical clamping

  let left = spot.left + spot.width + GAP;
  if (left + CARD_W + MARGIN > vw) {
    const leftSide = spot.left - GAP - CARD_W;
    left = leftSide >= MARGIN ? leftSide : Math.max(MARGIN, vw - CARD_W - MARGIN);
  }
  let top = spot.top;
  top = Math.min(top, vh - estH - MARGIN);
  top = Math.max(MARGIN, top);
  return { top, left };
}

function sameRects(a: Rect[], b: Rect[]): boolean {
  return a.length === b.length && a.every((r, k) =>
    r.top === b[k].top && r.left === b[k].left && r.width === b[k].width && r.height === b[k].height);
}

// Click-through on every step: the spotlit element (the brain graph, a form) must stay
// hoverable and clickable behind the dim — steps literally say "hover the core". Dismissal is
// Esc / Skip tour / Done; the card re-enables pointer events on itself.
// will-change: the body does not scroll, so Chrome would not give this fixed overlay its own
// layer — the graph's infinite CSS animations underneath would then re-rasterise the
// full-viewport SVG mask every frame. Promoting it keeps the mask static on the GPU.
const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 9998, pointerEvents: 'none', willChange: 'transform',
};

const baseBtn: React.CSSProperties = {
  fontSize: 11, padding: '4px 10px', cursor: 'pointer',
  border: '1px solid #000',
};
const primaryBtn: React.CSSProperties = { ...baseBtn, background: BRAND_ACCENT, color: '#fff' };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: '#fff', color: '#000' };
const disabledBtn: React.CSSProperties = {
  ...baseBtn, background: '#eee', color: '#999', borderColor: '#ccc', cursor: 'not-allowed',
};
const linkBtn: React.CSSProperties = {
  fontSize: 11, padding: '4px 2px', cursor: 'pointer',
  border: 'none', background: 'none', color: '#666',
};
