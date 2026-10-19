import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePolicyGraph } from '../../hooks/usePolicyGraph';
import { PolicyGraph, type PolicySelection } from './PolicyGraph';
import { layoutGraph } from '../../utils/graphLayout';
import { formatRelativeTime } from '../../utils/time';
import {
  avgShots, avgTokens, avgWallMs, edgeKey, isGoalState, shortLabel, successRate,
  type PolicyState, type PolicyTransition, type StateDimensions,
} from '../../data/policyGraph';

interface PolicyTabProps {
  isMobile?: boolean;
}

const SIG_LABELS = ['fw', 'build', 'deploy', 'group', 'type'] as const;

function DimensionsView({ dims }: { dims: StateDimensions }) {
  if (dims.procedure) {
    return (
      <div style={{ fontSize: 12 }}>
        <div style={{ color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10, marginBottom: 4 }}>
          intervention point
        </div>
        <div>procedure: <b>{dims.procedure.name}</b></div>
        <div style={{ color: '#666', marginTop: 2 }}>step: {dims.procedure.step}</div>
        <div style={{ color: '#888', marginTop: 6, fontSize: 11, lineHeight: 1.5 }}>
          A point between tools where the agent decides the next move. The outgoing actions below are
          the primary path and its fallbacks (used when a tool is down).
        </div>
      </div>
    );
  }
  if (dims.cohorts.length === 0 && !dims.infra) {
    return <div style={{ fontSize: 12, color: '#16a34a' }}>All healthy — no deviating cohorts.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {dims.infra && (
        <div style={{ fontSize: 12 }}>
          <span style={{ color: '#dc2626', fontWeight: 'bold' }}>INFRA</span> · {dims.infra.reason}
        </div>
      )}
      {dims.cohorts.map((c, i) => {
        const sig = c.sig
          .map((v, j) => (v ? `${SIG_LABELS[j]}=${v}` : null))
          .filter(Boolean)
          .join('  ');
        return (
          <div key={i} style={{ fontSize: 12, borderLeft: '2px solid #000', paddingLeft: 8 }}>
            <div><b>{c.extent}</b> · {c.fault}</div>
            {sig && <div style={{ color: '#666', fontSize: 11, marginTop: 2 }}>{sig}</div>}
          </div>
        );
      })}
    </div>
  );
}

// A one-line clickable transition row (used in a node's outgoing/incoming lists).
function EdgeRow({ t, otherLabel, onClick }: { t: PolicyTransition; otherLabel: string; onClick: () => void }) {
  const rate = Math.round(successRate(t) * 100);
  return (
    <button onClick={onClick} style={{
      background: 'none', border: 'none', padding: '2px 0', textAlign: 'left', cursor: 'pointer',
      fontSize: 12, color: '#000', display: 'flex', gap: 8, width: '100%',
    }}>
      <span style={{ textDecoration: 'underline' }}>{t.action}</span>
      <span style={{ color: '#666' }}>→ {otherLabel}</span>
      <span style={{ marginLeft: 'auto', color: '#888' }}>×{t.count} · {rate}%</span>
    </button>
  );
}

export function PolicyTab({ isMobile }: PolicyTabProps = {}) {
  const { states, transitions } = usePolicyGraph();
  const [selected, setSelected] = useState<PolicySelection | null>(null);
  const [hovered, setHovered] = useState<PolicySelection | null>(null);
  const [splitPct, setSplitPct] = useState(62);
  const [dragging, setDragging] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'graph' | 'detail'>('graph');
  const containerRef = useRef<HTMLDivElement>(null);
  const didAutoSelect = useRef(false);

  const stateMap = useMemo(() => Object.fromEntries(states.map((s) => [s.id, s])), [states]);

  // Layout only depends on the graph TOPOLOGY (which nodes/edges exist), not on the
  // weights — so live count updates refresh the edges without re-laying-out / jittering.
  const topoSig = useMemo(
    () =>
      states.map((s) => s.id).sort().join(',') +
      '::' +
      transitions.map((t) => `${t.from}>${t.to}`).sort().join(','),
    [states, transitions],
  );
  const positions = useMemo(
    () => layoutGraph(states.map((s) => s.id), transitions.map((t) => ({ from: t.from, to: t.to }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topoSig],
  );

  // Auto-select the busiest state on first load so the panel isn't empty.
  useEffect(() => {
    if (didAutoSelect.current || selected || states.length === 0) return;
    const hub = [...states].sort((a, b) => b.visitCount - a.visitCount)[0];
    if (hub) {
      setSelected({ kind: 'node', id: hub.id });
      didAutoSelect.current = true;
    }
  }, [states, selected]);

  const selectedNode: PolicyState | null =
    selected?.kind === 'node' ? stateMap[selected.id] ?? null : null;
  const selectedEdge: PolicyTransition | null =
    selected?.kind === 'edge' ? transitions.find((t) => edgeKey(t) === selected.id) ?? null : null;

  const graphPanel = (
    <PolicyGraph
      states={states}
      transitions={transitions}
      positions={positions}
      selected={selected}
      hovered={hovered}
      onSelect={setSelected}
      onHover={setHovered}
      emptyState={
        <div style={{ textAlign: 'center', color: '#888', fontSize: 12, maxWidth: 320, lineHeight: 1.7 }}>
          No policy transitions recorded yet.<br />
          Run the agent with <code style={{ background: '#f0f0f0', padding: '1px 4px' }}>AGENT_POLICY=shadow</code> to
          accumulate the cost-aware state→action graph.
        </div>
      }
    />
  );

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    setDragging(true);
    function onMove(ev: MouseEvent) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(75, Math.max(30, pct)));
    }
    function onUp() {
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const detailPanel = (
    <div style={{ flex: 1, minWidth: 0, background: '#fff', display: 'flex', flexDirection: 'column', overflow: 'hidden', color: '#000' }}>
      <div style={{ padding: '9px 16px', borderBottom: '1px solid #000', fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', flexShrink: 0 }}>
        {selectedEdge ? 'Transition' : 'State'}
      </div>

      {selectedNode && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px' }}>
          <div style={{ fontSize: 10, color: '#888', marginBottom: 10, letterSpacing: 0.5 }}>
            {selectedNode.id} &nbsp;·&nbsp; {selectedNode.visitCount} visits &nbsp;·&nbsp; seen {formatRelativeTime(selectedNode.lastSeen)}
          </div>
          <div style={{ fontSize: 17, fontWeight: 'bold', marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #000', lineHeight: 1.3, color: isGoalState(selectedNode) ? '#16a34a' : '#000' }}>
            {shortLabel(selectedNode)}
          </div>
          <DimensionsView dims={selectedNode.dimensions} />

          {(() => {
            const outgoing = transitions.filter((t) => t.from === selectedNode.id);
            const incoming = transitions.filter((t) => t.to === selectedNode.id && t.from !== t.to);
            return (
              <>
                {outgoing.length > 0 && (
                  <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px solid #ddd' }}>
                    <div style={{ fontSize: 10, color: '#888', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>Actions from here</div>
                    {outgoing.map((t) => (
                      <EdgeRow key={edgeKey(t)} t={t}
                        otherLabel={t.to === t.from ? '(self)' : shortLabel(stateMap[t.to])}
                        onClick={() => setSelected({ kind: 'edge', id: edgeKey(t) })} />
                    ))}
                  </div>
                )}
                {incoming.length > 0 && (
                  <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #ddd' }}>
                    <div style={{ fontSize: 10, color: '#888', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>Reached by</div>
                    {incoming.map((t) => (
                      <EdgeRow key={edgeKey(t)} t={t}
                        otherLabel={shortLabel(stateMap[t.from])}
                        onClick={() => setSelected({ kind: 'edge', id: edgeKey(t) })} />
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {selectedEdge && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px' }}>
          <div style={{ fontSize: 10, color: '#888', marginBottom: 10, letterSpacing: 0.5 }}>
            EDGE &nbsp;·&nbsp; seen {formatRelativeTime(selectedEdge.lastSeen)}
          </div>
          <div style={{ fontSize: 17, fontWeight: 'bold', marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #000', lineHeight: 1.3 }}>
            {selectedEdge.action}
          </div>
          <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={() => setSelected({ kind: 'node', id: selectedEdge.from })}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, textDecoration: 'underline', color: '#000' }}>
                {shortLabel(stateMap[selectedEdge.from])}
              </button>
              <span>→</span>
              <button onClick={() => setSelected({ kind: 'node', id: selectedEdge.to })}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12, textDecoration: 'underline', color: '#000' }}>
                {selectedEdge.to === selectedEdge.from ? '(self)' : shortLabel(stateMap[selectedEdge.to])}
              </button>
            </div>
            <Stat label="taken" value={`${selectedEdge.count}×`} />
            <Stat label="success" value={`${selectedEdge.successCount}/${selectedEdge.count} (${Math.round(successRate(selectedEdge) * 100)}%)`} />
            <Stat label="refuted" value={`${selectedEdge.refutedCount}`} />
            <Stat label="avg cost" value={`${avgTokens(selectedEdge)} tok · ${avgWallMs(selectedEdge)} ms · ${avgShots(selectedEdge).toFixed(1)} shots`} />
            <Stat label="wasted steps" value={`${selectedEdge.sumWastedSteps} total`} />
          </div>
        </div>
      )}

      {!selectedNode && !selectedEdge && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#bbb', textAlign: 'center', padding: 20 }}>
          Select a state or a transition to inspect it.
        </div>
      )}
    </div>
  );

  if (isMobile) {
    const btnStyle = (active: boolean, last?: boolean): React.CSSProperties => ({
      flex: 1, padding: '6px 0', fontSize: 12,
      border: 'none', borderRight: last ? 'none' : '1px solid #000',
      background: active ? '#000' : '#fff', color: active ? '#fff' : '#000', cursor: 'pointer',
    });
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
        <div style={{ display: 'flex', flexShrink: 0, borderBottom: '1px solid #000' }}>
          <button onClick={() => setMobilePanel('graph')} style={btnStyle(mobilePanel === 'graph')}>◉ Graph</button>
          <button onClick={() => setMobilePanel('detail')} style={btnStyle(mobilePanel === 'detail', true)}>▦ Detail</button>
        </div>
        <div style={{ display: mobilePanel === 'graph' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden', background: '#fff' }}>
          {graphPanel}
        </div>
        <div style={{ display: mobilePanel === 'detail' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          {detailPanel}
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ display: 'flex', flex: 1, width: '100%', height: '100%', minWidth: 0, userSelect: dragging ? 'none' : 'auto' }}>
      <div style={{ width: `${splitPct}%`, minWidth: 0, overflow: 'hidden', background: '#fff', borderRight: '1px solid #000' }}>
        {graphPanel}
      </div>
      <div onMouseDown={startDrag} style={{ width: 4, flexShrink: 0, background: '#f0f0f0', cursor: 'col-resize' }} />
      {detailPanel}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ color: '#888', minWidth: 92, display: 'inline-block' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
