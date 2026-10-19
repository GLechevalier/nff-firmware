import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

// Grab-to-pan + wheel-zoom for an inline SVG canvas, lifted out of SecurityTab so the
// Security and Brain graphs share ONE implementation. The content is drawn inside a
// `<g transform="translate(tx,ty) scale(scale)">`; the caller renders that group in its
// own board coordinates and (optionally) hands us the content bounding box so we can
// auto-fit it into the panel.
//
// Fixes the one bug the inline version carried: `startPan` reads the latest view via a
// ref, so a pan begun AFTER a zoom no longer snaps back to the pre-zoom origin.

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
}

export interface PanZoom {
  view: PanZoomView;
  panning: boolean;
  svgRef: React.RefObject<SVGSVGElement | null>;
  // True between mousedown and mouseup once the pointer moved past a small threshold —
  // callers guard node clicks with `if (!movedRef.current)` so a drag doesn't mis-select.
  movedRef: React.MutableRefObject<boolean>;
  startPan: (e: React.MouseEvent) => void;
  resetView: () => void;
}

export function usePanZoom(opts: UsePanZoomOptions = {}): PanZoom {
  const { fit = null, fitKey = '', padding = 48, minScale = 0.2, maxScale = 2.5 } = opts;

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

  // Grab-to-pan: mousedown → document mousemove/up so the drag survives leaving the SVG.
  const startPan = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setPanning(true);
    movedRef.current = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const base = viewRef.current; // latest view, not a stale render-scope capture
    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true;
      setView(v => ({ ...v, tx: base.tx + dx, ty: base.ty + dy }));
    }
    function onUp() {
      setPanning(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // Wheel-zoom about the cursor. Non-passive so we can preventDefault the page scroll
  // (React's onWheel is passive by default).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView(v => {
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const scale = Math.min(maxScale, Math.max(minScale, v.scale * factor));
        const k = scale / v.scale;
        return { scale, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [minScale, maxScale]);

  // Frame the content box in the current panel size (centres its bbox, scales to fit).
  const fitNow = useCallback(() => {
    const box = fitRef.current;
    const r = svgRef.current?.getBoundingClientRect();
    const w = r?.width ?? 800;
    const h = r?.height ?? 600;
    if (!box) {
      setView({ tx: 0, ty: 0, scale: 1 });
      return;
    }
    const cw = Math.max(box.maxX - box.minX, 1);
    const ch = Math.max(box.maxY - box.minY, 1);
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    const scale = Math.min(
      maxScale,
      Math.max(minScale, Math.min((w - 2 * padding) / cw, (h - 2 * padding) / ch)),
    );
    setView({ tx: w / 2 - cx * scale, ty: h / 2 - cy * scale, scale });
  }, [padding, minScale, maxScale]);

  const resetView = useCallback(() => fitNow(), [fitNow]);

  // Auto-fit ONCE per fitKey, when the panel actually has a size. The tab can mount hidden
  // (display:none → 0×0), so we can't measure on mount; fit on the first non-zero size —
  // rAF covers "visible on load", the ResizeObserver covers "shown later / resized".
  useEffect(() => {
    if (!fit) return;
    if (fittedKeyRef.current === fitKey) return;
    const el = svgRef.current;
    if (!el) return;
    const tryFit = () => {
      if (fittedKeyRef.current === fitKey) return;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        fittedKeyRef.current = fitKey;
        fitNow();
      }
    };
    const id = requestAnimationFrame(tryFit);
    const ro = new ResizeObserver(tryFit);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(id);
      ro.disconnect();
    };
  }, [fit, fitKey, fitNow]);

  return { view, panning, svgRef, movedRef, startPan, resetView };
}
