import type React from 'react';
import { useMemo, useRef, useState } from 'react';
import { BRAND_ACCENT } from '../../../lib/brand';
import { useVulnTree } from '../hooks/useVulnTree';
import { usePanZoom, type FitBox } from '../../../hooks/usePanZoom';
import {
  condText,
  isPlanned,
  SEVERITY_COLOR,
  SEVERITY_ORDER,
  type Severity,
  type VulnNode,
} from '../data/vulnTree';

// ── Layout: radial tree. A synthetic "pentester agent" node sits at the centre
// (the origin); the chains radiate outward — depth → radius, leaf order → angle —
// echoing the Brain graph's look. ─────────────────────────────────────────────
interface Pos { x: number; y: number }
const AGENT_ID = '__agent__';
const R_STEP = 165;

function layoutRadial(nodes: VulnNode[]): {
  pos: Record<string, Pos>;
  size: Record<string, number>;
  extent: number;
} {
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const childrenOf = new Map<string, VulnNode[]>();
  const roots: VulnNode[] = [];
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      const arr = childrenOf.get(n.parentId) ?? [];
      arr.push(n);
      childrenOf.set(n.parentId, arr);
    } else {
      roots.push(n);
    }
  }

  // Leaves get the angular slots; internal nodes sit at their children's mean
  // angle. The synthetic agent owns the centre, so the chain roots start at depth 1.
  let totalLeaves = 0;
  const countLeaves = (n: VulnNode): void => {
    const kids = childrenOf.get(n.nodeId) ?? [];
    if (kids.length === 0) totalLeaves += 1;
    else kids.forEach(countLeaves);
  };
  roots.forEach(countLeaves);
  if (totalLeaves === 0) totalLeaves = 1;

  const pos: Record<string, Pos> = { [AGENT_ID]: { x: 0, y: 0 } };
  const size: Record<string, number> = {};
  let leafIdx = 0;
  let extent = 0;
  const place = (node: VulnNode, depth: number): number => {
    const kids = childrenOf.get(node.nodeId) ?? [];
    let angle: number;
    if (kids.length === 0) {
      angle = ((leafIdx + 0.5) / totalLeaves) * Math.PI * 2;
      leafIdx += 1;
    } else {
      const as = kids.map(k => place(k, depth + 1));
      angle = (as[0] + as[as.length - 1]) / 2;
    }
    const r = depth * R_STEP;
    pos[node.nodeId] = { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
    size[node.nodeId] = Math.max(8, 16 - depth * 2);
    extent = Math.max(extent, r);
    return angle;
  };
  roots.forEach(r => place(r, 1));
  return { pos, size, extent };
}

const ORIGIN_BADGE: Record<VulnNode['origin'], { label: string; color: string } | null> = {
  seed: null,
  user: { label: 'user', color: '#2563eb' },
  agent: { label: 'agent', color: '#7c3aed' },
};

interface Props { isMobile?: boolean }

export function SecurityTab({ isMobile }: Props = {}) {
  const { nodes, realTools, loading, error, appendNode } = useVulnTree();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [splitPct, setSplitPct] = useState(62);
  const [dragging, setDragging] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'graph' | 'detail'>('graph');
  const containerRef = useRef<HTMLDivElement>(null);

  const { pos, size } = useMemo(() => layoutRadial(nodes), [nodes]);
  const byId = useMemo(() => new Map(nodes.map(n => [n.nodeId, n])), [nodes]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const children = useMemo(
    () => (selectedId ? nodes.filter(n => n.parentId === selectedId) : []),
    [nodes, selectedId],
  );

  // Pan/zoom of the graph canvas (shared hook — grab to pan, scroll to zoom). The tree is
  // drawn in a <g> translated/scaled by `view`; we hand the hook the content bounding box
  // (incl. label room) so it auto-fits the whole burst on first paint.
  const fit = useMemo<FitBox | null>(() => {
    if (nodes.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of Object.keys(pos)) {
      const p = pos[id];
      const s = size[id] ?? 18;
      minX = Math.min(minX, p.x - s);
      minY = Math.min(minY, p.y - s);
      maxX = Math.max(maxX, p.x + s);
      maxY = Math.max(maxY, p.y + s + 16); // label sits below the node
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }, [pos, size, nodes.length]);
  const { view, panning, svgRef, movedRef, startPan, resetView } = usePanZoom({
    fit,
    fitKey: String(nodes.length),
    padding: 56,
    minScale: 0.25,
    maxScale: 2.5,
  });

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

  const graphPanel = (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#fff' }}>
      <svg
        ref={svgRef}
        onMouseDown={startPan}
        style={{ width: '100%', height: '100%', display: 'block', cursor: panning ? 'grabbing' : 'grab' }}
      >
        <rect x={0} y={0} width="100%" height="100%" fill="#fff" />
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
      {/* branches radiating from the centre (Brain-style lines) */}
      {nodes.map(n => {
        const from = (n.parentId && pos[n.parentId]) ? pos[n.parentId] : pos[AGENT_ID];
        const to = pos[n.nodeId];
        if (!from || !to) return null;
        const active = selectedId === n.nodeId || selectedId === n.parentId
          || hoveredId === n.nodeId || hoveredId === n.parentId;
        return (
          <line
            key={`e-${n.nodeId}`}
            x1={from.x} y1={from.y} x2={to.x} y2={to.y}
            stroke={active ? '#000' : '#bbb'}
            strokeWidth={active ? 1.5 : 1}
          />
        );
      })}
      {/* chain nodes (Brain-style squares, severity-colored core) */}
      {nodes.map(n => {
        const p = pos[n.nodeId];
        if (!p) return null;
        const isSel = n.nodeId === selectedId;
        const isHov = n.nodeId === hoveredId && !isSel;
        const s = size[n.nodeId] ?? 11;
        const color = SEVERITY_COLOR[n.severity];
        const planned = isPlanned(n, realTools);
        return (
          <g
            key={n.nodeId}
            style={{ cursor: 'pointer' }}
            onClick={() => { if (!movedRef.current) setSelectedId(n.nodeId); }}
            onMouseEnter={() => setHoveredId(n.nodeId)}
            onMouseLeave={() => setHoveredId(null)}
          >
            <rect
              x={p.x - s} y={p.y - s} width={s * 2} height={s * 2}
              fill={isSel ? '#000' : isHov ? '#f5f5f5' : '#fff'}
              stroke="#000"
              strokeWidth={isSel ? 0 : 1}
              strokeDasharray={planned ? '3 2' : undefined}
            />
            <circle
              cx={p.x} cy={p.y} r={s * 0.5}
              fill={planned ? 'none' : color}
              stroke={planned ? color : isSel ? '#fff' : 'none'}
              strokeWidth={planned ? 1.5 : 0.75}
              strokeDasharray={planned ? '2 2' : undefined}
            />
            <text
              x={p.x} y={p.y + s + 13}
              textAnchor="middle"
              fontSize={10}
             
              fontWeight={isSel ? 'bold' : 'normal'}
              fill="#000"
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >
              {n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label}
            </text>
          </g>
        );
      })}
      {/* centre node: the pentester agent */}
      {pos[AGENT_ID] && (() => {
        const c = pos[AGENT_ID];
        const a = 18;
        return (
          <g style={{ pointerEvents: 'none' }}>
            <rect x={c.x - a} y={c.y - a} width={a * 2} height={a * 2} fill="#000" stroke="#000" />
            <text x={c.x} y={c.y + 5} textAnchor="middle" fontSize={15} fill="#fff" style={{ userSelect: 'none' }}>⌖</text>
            <text x={c.x} y={c.y + a + 15} textAnchor="middle" fontSize={11} fontWeight="bold" fill="#000" style={{ userSelect: 'none' }}>pentester agent</text>
          </g>
        );
      })()}
        </g>
      </svg>
      <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 8, alignItems: 'center', fontSize: 10, color: '#666' }}>
        <button
          onClick={resetView}
          style={{ fontSize: 10, padding: '2px 8px', border: '1px solid #000', background: '#fff', cursor: 'pointer' }}
        >
          reset view
        </button>
        <span>grab to pan · scroll to zoom</span>
      </div>
    </div>
  );

  const detailPanel = (
    <div style={{
      flex: 1, minWidth: 0, background: '#fff',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      color: '#000',
    }}>
      <div style={{
        padding: '9px 16px', borderBottom: '1px solid #000',
        fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', flexShrink: 0,
      }}>
        Vulnerability Node
      </div>
      {selected ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <SevChip severity={selected.severity} />
            {ORIGIN_BADGE[selected.origin] && (
              <Badge color={ORIGIN_BADGE[selected.origin]!.color} label={ORIGIN_BADGE[selected.origin]!.label} />
            )}
            {isPlanned(selected, realTools) && <Badge color="#e0a800" label="planned tool" />}
          </div>
          <div style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #000', lineHeight: 1.3 }}>
            {selected.label}
          </div>

          {selected.tool && (
            <Field label={isPlanned(selected, realTools) ? 'planned tool' : 'confirmed by'}>
              <code style={codeStyle}>{selected.tool}</code>
            </Field>
          )}
          {selected.condition != null && (
            <Field label="condition">
              <span style={{ color: '#3a5' }}>if </span>{condText(selected.condition) || '—'}
            </Field>
          )}
          {selected.nextCheck && (
            <Field label="next check">
              ▶ run <code style={codeStyle}>{selected.nextCheck.tool}</code>
              {selected.nextCheck.reason ? ` — ${selected.nextCheck.reason}` : ''}
            </Field>
          )}
          {selected.outcome && (selected.outcome.compromised || selected.outcome.impact || selected.outcome.cvss) && (
            <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 4, background: 'rgba(229,72,77,.07)', border: '1px solid rgba(229,72,77,.3)' }}>
              {selected.outcome.compromised && (
                <div style={{ color: '#c0282d', fontWeight: 'bold', marginBottom: 4 }}>⇒ {selected.outcome.compromised}</div>
              )}
              {selected.outcome.impact && <div style={{ fontSize: 12, lineHeight: 1.6 }}>{selected.outcome.impact}</div>}
              {selected.outcome.cvss && <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>{selected.outcome.cvss}</div>}
            </div>
          )}

          {children.length > 0 && (
            <div style={{ marginTop: 18, paddingTop: 12, borderTop: '1px solid #ddd' }}>
              <div style={labelStyle}>leads to</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                {children.map(c => (
                  <button key={c.nodeId} onClick={() => setSelectedId(c.nodeId)} style={linkBtn}>
                    <span style={{ color: SEVERITY_COLOR[c.severity] }}>●</span> {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <AddChildForm parentId={selected.nodeId} onAdd={appendNode} />
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#bbb' }}>
          Select a node to inspect its condition, outcome, and chain
        </div>
      )}
    </div>
  );

  const header = (
    <div style={{ padding: '4px 8px', borderBottom: '1px solid #000', fontSize: 12, fontWeight: 'bold', flexShrink: 0, display: 'flex', gap: 10, alignItems: 'center' }}>
      <span>Security · Vulnerability Tree</span>
      <span style={{ fontWeight: 'normal', color: '#666', fontSize: 11 }}>
        {loading ? 'loading…' : error ? `error: ${error}` : `${nodes.length} nodes`}
      </span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        {SEVERITY_ORDER.map(s => (
          <span key={s} style={{ fontSize: 10, color: '#666', display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEVERITY_COLOR[s], display: 'inline-block' }} />{s}
          </span>
        ))}
      </span>
    </div>
  );

  if (isMobile) {
    const btn = (active: boolean, last?: boolean): React.CSSProperties => ({
      flex: 1, padding: '6px 0', fontSize: 12,
      border: 'none', borderRight: last ? 'none' : '1px solid #000',
      background: active ? '#000' : '#fff', color: active ? '#fff' : '#000', cursor: 'pointer',
    });
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
        {header}
        <div style={{ display: 'flex', flexShrink: 0, borderBottom: '1px solid #000' }}>
          <button onClick={() => setMobilePanel('graph')} style={btn(mobilePanel === 'graph')}>◉ Graph</button>
          <button onClick={() => setMobilePanel('detail')} style={btn(mobilePanel === 'detail', true)}>▦ Detail</button>
        </div>
        <div style={{ display: mobilePanel === 'graph' ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden', background: '#fff' }}>{graphPanel}</div>
        <div style={{ display: mobilePanel === 'detail' ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden' }}>{detailPanel}</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%' }}>
      {header}
      <div ref={containerRef} style={{ display: 'flex', flex: 1, minHeight: 0, userSelect: dragging ? 'none' : 'auto' }}>
        <div style={{ width: `${splitPct}%`, minWidth: 0, overflow: 'hidden', background: '#fff', borderRight: '1px solid #000' }}>
          {graphPanel}
        </div>
        <div onMouseDown={startDrag} style={{ width: 4, flexShrink: 0, background: '#f0f0f0', cursor: 'col-resize' }} />
        {detailPanel}
      </div>
    </div>
  );
}

// ── small pieces ─────────────────────────────────────────────────────────────
const labelStyle: React.CSSProperties = { fontSize: 10, color: '#888', letterSpacing: 1, textTransform: 'uppercase' };
const codeStyle: React.CSSProperties = { background: '#f3f3f3', padding: '1px 5px', borderRadius: 3 };
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: '1px 0', textAlign: 'left', cursor: 'pointer', fontSize: 12, color: '#000' };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={labelStyle}>{label}</div>
      <div style={{ fontSize: 12, lineHeight: 1.6, marginTop: 3 }}>{children}</div>
    </div>
  );
}

function SevChip({ severity }: { severity: Severity }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 0.5, color: '#fff', background: SEVERITY_COLOR[severity], padding: '1px 6px', borderRadius: 3 }}>
      {severity}
    </span>
  );
}

function Badge({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ fontSize: 10, color, border: `1px solid ${color}`, padding: '0 5px', borderRadius: 8 }}>{label}</span>
  );
}

function AddChildForm({ parentId, onAdd }: { parentId: string; onAdd: (i: { parentId: string; label: string; severity: Severity; tool?: string; impact?: string }) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [severity, setSeverity] = useState<Severity>('medium');
  const [tool, setTool] = useState('');
  const [impact, setImpact] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!label.trim()) { setErr('Label is required'); return; }
    setBusy(true); setErr(null);
    try {
      await onAdd({ parentId, label: label.trim(), severity, tool: tool.trim() || undefined, impact: impact.trim() || undefined });
      setLabel(''); setTool(''); setImpact(''); setSeverity('medium'); setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const input: React.CSSProperties = { width: '100%', fontSize: 12, padding: '4px 6px', border: '1px solid #ccc', boxSizing: 'border-box' };

  return (
    <div style={{ marginTop: 20, paddingTop: 12, borderTop: '1px solid #000' }}>
      {!open ? (
        <button onClick={() => setOpen(true)} style={{ ...linkBtn, fontWeight: 'bold' }}>➕ Add child node</button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={labelStyle}>new child of this node</div>
          <input style={input} placeholder="label" value={label} onChange={e => setLabel(e.target.value)} />
          <select style={input} value={severity} onChange={e => setSeverity(e.target.value as Severity)}>
            {SEVERITY_ORDER.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <input style={input} placeholder="tool (optional, e.g. ssh_brute)" value={tool} onChange={e => setTool(e.target.value)} />
          <textarea style={{ ...input, minHeight: 44, resize: 'vertical' }} placeholder="impact / notes (optional)" value={impact} onChange={e => setImpact(e.target.value)} />
          {err && <div style={{ color: '#c0282d', fontSize: 11 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={submit} disabled={busy} style={{ fontSize: 12, padding: '4px 12px', border: '1px solid #000', background: BRAND_ACCENT, color: '#fff', cursor: busy ? 'default' : 'pointer' }}>
              {busy ? 'saving…' : 'Add'}
            </button>
            <button onClick={() => { setOpen(false); setErr(null); }} style={{ fontSize: 12, padding: '4px 12px', border: '1px solid #000', background: '#fff', cursor: 'pointer' }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
