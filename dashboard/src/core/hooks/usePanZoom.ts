import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

// Grab-to-pan + wheel-zoom for an inline SVG canvas — ported from
// nff-dashboard's src/hooks/usePanZoom.ts (shared there by the Security and
// Brain graphs), upgraded to pointer events: one finger/mouse pans, two
// fingers pinch-zoom about the gesture midpoint, wheel zooms on desktop.
// The caller must set `touch-action: none` on the SVG or the browser steals
// touch for page scroll before pointermove fires. The content is drawn inside
// a `<g transform="translate(tx,ty) scale(scale)">`; the caller renders that
// group in its own board coordinates and (optionally) hands us the content
// bounding box so we can auto-fit it into the panel.

export interface PanZoomView {
  tx: number;
  ty: number;
  scale: number;
}

// Content extent in board coordinates (the same space the transformed <g> draws in).
export interface FitBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  // Optional point to put at the exact centre of the panel (the brain hub).
  // The frame stays symmetric around it, so the far edge sets the scale and
  // the whole box remains in view.
  focus?: { x: number; y: number };
}

export interface FrameOptions {
  padding: number;
  minScale: number;
  maxScale: number;
}

// Pure fit math: the view that shows `box` in a w×h panel. With `focus`, that
// point lands at the panel centre; otherwise the box's own centre does.
export function frameView(box: FitBox, w: number, h: number, o: FrameOptions): PanZoomView {
  const clamp = (s: number) => Math.min(o.maxScale, Math.max(o.minScale, s));
  if (box.focus) {
    const { x: fx, y: fy } = box.focus;
    const hw = Math.max(box.maxX - fx, fx - box.minX, 1);
    const hh = Math.max(box.maxY - fy, fy - box.minY, 1);
    const scale = clamp(Math.min((w / 2 - o.padding) / hw, (h / 2 - o.padding) / hh));
    return { tx: w / 2 - fx * scale, ty: h / 2 - fy * scale, scale };
  }
  const cw = Math.max(box.maxX - box.minX, 1);
  const ch = Math.max(box.maxY - box.minY, 1);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const scale = clamp(Math.min((w - 2 * o.padding) / cw, (h - 2 * o.padding) / ch));
  return { tx: w / 2 - cx * scale, ty: h / 2 - cy * scale, scale };
}

export interface UsePanZoomOptions {
  // The content bounding box to frame. When it (or `fitKey`) changes and the panel has a
  // real size, we auto-fit once. Null → no auto-fit (identity view).
  fit?: FitBox | null;
  // Re-arm the one-shot auto-fit whenever this changes (e.g. the node-id set). Keeps live
  // weight/hover updates from re-framing the graph and losing the user's pan.
  fitKey?: string;
  padding?: number;  // px of breathing room around the content when fitting
  minScale?: number;
  maxScale?: number;
  // 'always'   — any wheel zooms, and the page never scrolls under the cursor.
  //              Right for a canvas that owns its whole tab (the Brain tab).
  // 'modifier' — only ctrl/⌘+wheel zooms; a plain wheel is left alone so the
  //              PAGE scrolls. Required for a graph embedded in a scrolling
  //              page (the Overview brain card), which would otherwise trap the
  //              wheel the moment the cursor crossed it.
  wheelZoom?: 'always' | 'modifier';
}

export interface PanZoom {
  view: PanZoomView;
  panning: boolean;
  svgRef: React.RefObject<SVGSVGElement | null>;
  // True between pointerdown and pointerup once the pointer moved past a small threshold
  // (or a second finger landed) — callers guard node clicks with `if (!movedRef.current)`
  // so a drag or pinch doesn't mis-select.
  movedRef: React.MutableRefObject<boolean>;
  startPan: (e: React.PointerEvent) => void;
  resetView: () => void;
}

export function usePanZoom(opts: UsePanZoomOptions = {}): PanZoom {
  const {
    fit = null,
    fitKey = '',
    padding = 48,
    minScale = 0.2,
    maxScale = 2.5,
    wheelZoom = 'always',
  } = opts;

  const [view, setView] = useState<PanZoomView>({ tx: 0, ty: 0, scale: 1 });
  const [panning, setPanning] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const movedRef = useRef(false);

  // Latest values for use inside long-lived closures / observers.
  const viewRef = useRef(view);
  viewRef.current = view;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const fittedKeyRef = useRef<string | null>(null);

  // Live pointers (element coords) and the current gesture. A gesture is (re)baselined
  // from viewRef whenever its shape changes: 1st touch → pan, 2nd touch upgrades to
  // pinch, lifting back to one finger re-baselines as a fresh pan.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureRef = useRef<
    | { mode: 'pan'; base: PanZoomView; startX: number; startY: number }
    | { mode: 'pinch'; base: PanZoomView; startDist: number; startMidX: number; startMidY: number }
    | null
  >(null);
  const listenersOnRef = useRef(false);

  // Grab-to-pan / pinch-zoom: pointerdown → document pointermove/up/cancel so the
  // gesture survives leaving the SVG. Handlers live in refs so add/remove pair up.
  const onMoveRef = useRef<(ev: PointerEvent) => void>(() => {});
  const onUpRef = useRef<(ev: PointerEvent) => void>(() => {});

  // Pan/pinch fold their pointermoves into ONE setView per animation frame —
  // same reason as the wheel handler below: every view change re-renders the
  // whole graph, and a mouse fires far more moves than there are frames. The
  // last position is flushed synchronously when the gesture ends.
  const pendingRef = useRef<PanZoomView | null>(null);
  const rafRef = useRef(0);
  const flushView = useCallback(() => {
    rafRef.current = 0;
    const next = pendingRef.current;
    pendingRef.current = null;
    if (next) setView(next);
  }, []);
  const queueView = (next: PanZoomView) => {
    pendingRef.current = next;
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flushView);
  };
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  onMoveRef.current = (ev: PointerEvent) => {
    if (!pointersRef.current.has(ev.pointerId)) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    pointersRef.current.set(ev.pointerId, { x: ev.clientX - rect.left, y: ev.clientY - rect.top });
    const g = gestureRef.current;
    if (!g) return;
    if (g.mode === 'pan') {
      const p = pointersRef.current.get(ev.pointerId)!;
      const dx = p.x - g.startX;
      const dy = p.y - g.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true;
      queueView({ ...g.base, tx: g.base.tx + dx, ty: g.base.ty + dy });
    } else {
      const [a, b] = [...pointersRef.current.values()];
      if (!b) return;
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const scale = Math.min(maxScale, Math.max(minScale, g.base.scale * (dist / g.startDist)));
      const k = scale / g.base.scale;
      // Pin the board point that sat under the start-midpoint to the live midpoint —
      // one formula covers both pinch-zoom and two-finger pan.
      queueView({ scale, tx: mx - (g.startMidX - g.base.tx) * k, ty: my - (g.startMidY - g.base.ty) * k });
    }
  };

  onUpRef.current = (ev: PointerEvent) => {
    if (!pointersRef.current.delete(ev.pointerId)) return;
    const remaining = [...pointersRef.current.values()];
    if (remaining.length === 1) {
      gestureRef.current = {
        mode: 'pan',
        base: pendingRef.current ?? viewRef.current,
        startX: remaining[0].x,
        startY: remaining[0].y,
      };
    } else if (remaining.length === 0) {
      // Commit the last queued position now — don't leave it to a frame that
      // may never come (hidden tab) or land after the next gesture starts.
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      flushView();
      gestureRef.current = null;
      setPanning(false);
      listenersOnRef.current = false;
      document.removeEventListener('pointermove', docMove);
      document.removeEventListener('pointerup', docUp);
      document.removeEventListener('pointercancel', docUp);
    }
  };

  const docMove = useCallback((ev: PointerEvent) => onMoveRef.current(ev), []);
  const docUp = useCallback((ev: PointerEvent) => onUpRef.current(ev), []);

  const startPan = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.preventDefault();
    // No explicit setPointerCapture: it would retarget the eventual `click` to the
    // SVG and break node selection. Touch pointers get implicit capture on their
    // target anyway, and the document listeners below track mouse drags.
    pointersRef.current.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });

    const pts = [...pointersRef.current.values()];
    if (pts.length === 1) {
      movedRef.current = false;
      gestureRef.current = { mode: 'pan', base: pendingRef.current ?? viewRef.current, startX: pts[0].x, startY: pts[0].y };
    } else if (pts.length === 2) {
      movedRef.current = true; // a pinch must never count as a node click
      const [a, b] = pts;
      gestureRef.current = {
        mode: 'pinch',
        base: pendingRef.current ?? viewRef.current,
        startDist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        startMidX: (a.x + b.x) / 2,
        startMidY: (a.y + b.y) / 2,
      };
    } // 3rd+ pointer: ignore, keep the current gesture
    setPanning(true);

    if (!listenersOnRef.current) {
      listenersOnRef.current = true;
      document.addEventListener('pointermove', docMove);
      document.addEventListener('pointerup', docUp);
      document.addEventListener('pointercancel', docUp);
    }
  }, [docMove, docUp]);

  // Wheel-zoom about the cursor. Non-passive so we can preventDefault the page scroll
  // (React's onWheel is passive by default).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    // Trackpads fire several wheel events per frame and every scale change is
    // a real re-layout for the graph's overlap merging, so the ticks are
    // folded into one setView per animation frame (factors multiply).
    let pending: { px: number; py: number; factor: number } | null = null;
    let raf = 0;
    function onWheel(e: WheelEvent) {
      // Under 'modifier', a bare wheel belongs to the page — don't consume it.
      // (Browsers already send ctrlKey for a trackpad pinch, so pinch-to-zoom
      // keeps working without a keyboard.)
      if (wheelZoom === 'modifier' && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      pending = { px: e.clientX - rect.left, py: e.clientY - rect.top, factor: (pending?.factor ?? 1) * f };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const { px, py, factor } = pending!;
        pending = null;
        setView(v => {
          const scale = Math.min(maxScale, Math.max(minScale, v.scale * factor));
          const k = scale / v.scale;
          return { scale, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
        });
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [minScale, maxScale, wheelZoom]);

  // Frame the content box in the current panel size (centres its focus or its
  // bbox, scales to fit) — see frameView.
  const fitNow = useCallback(() => {
    const box = fitRef.current;
    const r = svgRef.current?.getBoundingClientRect();
    const w = r?.width ?? 800;
    const h = r?.height ?? 600;
    if (!box) {
      setView({ tx: 0, ty: 0, scale: 1 });
      return;
    }
    setView(frameView(box, w, h, { padding, minScale, maxScale }));
  }, [padding, minScale, maxScale]);

  const resetView = useCallback(() => fitNow(), [fitNow]);

  // Auto-fit once per fitKey — re-arm on a fresh node-id set (merge/reduce), not
  // on every position tweak, so hovering doesn't re-frame a pan the user made.
  // The panel can mount hidden (display:none → 0×0), so the first fit waits for
  // a non-zero size — rAF covers "visible on load". After that, the same
  // ResizeObserver keeps recentring on real size changes (e.g. the selected-node
  // sidebar toggling on/off shrinks/grows the box) — it only fires when the
  // observed box's actual size changes, so this doesn't fight a manual pan/zoom.
  useEffect(() => {
    if (!fit) return;
    const el = svgRef.current;
    if (!el) return;
    const tryInitialFit = () => {
      if (fittedKeyRef.current === fitKey) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        fittedKeyRef.current = fitKey;
        fitNow();
      }
    };
    const id = requestAnimationFrame(tryInitialFit);
    const ro = new ResizeObserver(() => {
      if (fittedKeyRef.current !== fitKey) { tryInitialFit(); return; }
      // Collapsing to 0×0 (the tab went display:none) is not a resize worth
      // fitting: a fit against a zero box flips the scale, which re-merges
      // every density blob and churns `absorbing` across the whole graph —
      // a multi-second render storm on a few hundred nodes, and a view the
      // user never sees. The next real size restores the frame.
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) fitNow();
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(id);
      ro.disconnect();
    };
  }, [fit, fitKey, fitNow]);

  return { view, panning, svgRef, movedRef, startPan, resetView };
}
