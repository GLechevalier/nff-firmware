import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PolicyActivation, PolicyActivationNode } from '../../hooks/usePolicyActivation';
import { BRAND_ACCENT } from '../../lib/brand';

// A small bottom-left toast that dramatizes the policy layer learning during the self-heal
// demo: when the worker records a (state, action, state') transition (usePolicyActivation),
// the mini chain reveals sequentially — pre-state node → action edge → post-state node →
// recorded footer — with the active node's dot pulsing. Same brutalist family as
// DemoActivityToast; stacked ABOVE it (raised) whenever a narration beat is visible.

// Longer than DemoActivityToast's 12s: the sequential reveal itself eats ~2s.
const AUTO_DISMISS_MS = 15000;

// Reveal stages: 0 = pre-node, 1 = edge, 2 = post-node, 3 = footer (settled).
const STAGE_DELAYS_MS = [0, 700, 1400, 2100];

interface Props {
  activation: PolicyActivation | null;
  onDismiss: () => void;
  // True while DemoActivityToast occupies bottom-left — slide up to clear its worst case.
  raised: boolean;
}

function NodeRow({ node, active, revealed }: { node: PolicyActivationNode | null; active: boolean; revealed: boolean }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'baseline', gap: 8,
        visibility: revealed ? 'visible' : 'hidden',
        animation: revealed ? 'nff-node-in 0.3s ease-out' : undefined,
      }}
    >
      <span
        style={{
          width: 10, height: 10, borderRadius: '50%', background: '#000', flexShrink: 0,
          alignSelf: 'center',
          animation: active ? 'nff-dot-pulse 1s ease-in-out infinite' : undefined,
        }}
      />
      <span style={{ fontSize: 12, fontWeight: 700 }}>{node?.label ?? '…'}</span>
      {node && node.summary ? (
        <span
          style={{
            fontSize: 10, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', minWidth: 0,
          }}
        >
          ×{node.visitCount} visits · {node.summary}
        </span>
      ) : null}
    </div>
  );
}

export function PolicyActivityToast({ activation, onDismiss, raised }: Props) {
  const key = activation?.key;

  // Held in a ref so the dismiss timer keys ONLY off the observation. While an incident runs,
  // DeviceHealthContext re-renders the tree once per second; with onDismiss in the deps its
  // fresh closure identity would restart the timer every tick, so it would never fire.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => { onDismissRef.current = onDismiss; });
  useEffect(() => {
    if (!key) return;
    const t = setTimeout(() => onDismissRef.current(), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [key]);

  // Sequential reveal, restarted whenever a new observation lands (key changes). Label
  // patches on the SAME key update in place without restarting the animation.
  const [stage, setStage] = useState(0);
  useEffect(() => {
    if (!key) return;
    setStage(0);
    const timers = STAGE_DELAYS_MS.slice(1).map((ms, i) => setTimeout(() => setStage(i + 1), ms));
    return () => timers.forEach(clearTimeout);
  }, [key]);

  if (!activation) return null;

  return createPortal(
    <div
      style={{
        position: 'fixed', left: 16, bottom: raised ? 200 : 16, zIndex: 10000,
        pointerEvents: 'none', transition: 'bottom 0.25s ease',
      }}
    >
      <div
        role="status"
        style={{
          width: 320, background: '#fff', color: '#000',
          border: '2px solid #000', boxShadow: '5px 5px 0 #000',
          pointerEvents: 'auto', animation: 'nff-toast-in 0.28s ease-out',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: BRAND_ACCENT, color: '#fff' }}>
          <span style={{ fontSize: 15, lineHeight: 1 }}>◈</span>
          <span style={{ flex: 1, fontSize: 12, fontWeight: 700 }}>policy graph learning</span>
          <button
            onClick={onDismiss}
            title="Dismiss"
            style={{ border: 'none', background: 'none', color: '#fff', cursor: 'pointer', fontSize: 11, lineHeight: 1, padding: 0, textDecoration: 'underline' }}
          >
            dismiss
          </button>
        </div>
        <div style={{ padding: '10px', display: 'flex', flexDirection: 'column' }}>
          <NodeRow node={activation.from} active={stage === 0} revealed={stage >= 0} />
          <div
            style={{
              margin: '2px 0 2px 4px', paddingLeft: 12, borderLeft: '2px solid #000',
              height: 18, display: 'flex', alignItems: 'center',
              fontSize: 11, fontWeight: 700,
              visibility: stage >= 1 ? 'visible' : 'hidden',
              animation: stage >= 1 ? 'nff-node-in 0.3s ease-out' : undefined,
            }}
          >
            ↓ {activation.action}
          </div>
          <NodeRow node={activation.to} active={stage >= 1 && stage < 3} revealed={stage >= 2} />
          <div
            style={{
              marginTop: 8, fontSize: 10, color: '#555',
              visibility: stage >= 3 ? 'visible' : 'hidden',
              animation: stage >= 3 ? 'nff-node-in 0.3s ease-out' : undefined,
            }}
          >
            recorded · seen {activation.count}× · {activation.successCount} ok
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
