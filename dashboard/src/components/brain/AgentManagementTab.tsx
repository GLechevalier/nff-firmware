import { useEffect, useRef, useState } from 'react';
import { useAgentConfig } from '../../hooks/useAgentConfig';
import { useAgentTasks } from '../../hooks/useAgentTasks';
import { useServiceStatus, type ServiceName } from '../../hooks/useServiceStatus';
import { useGithubTunnel } from '../../hooks/useGithubTunnel';
import { AgentTokenUsage } from './AgentTokenUsage';
import { ConnectorLogo, CONNECTOR_CATALOG, type ConnectorDef, type ConnectorIconKey } from './connectorCatalog';

type ToolStatus = 'online' | 'warning' | 'error';
type EdgeDirection = 'undirected' | 'inbound' | 'outbound' | 'bidirectional';

interface Tool {
  id: string;
  name: string;
  description: string;
  status: ToolStatus;
  active: boolean;
  hidden?: boolean;        // removed from the graph (trash icon); restored via the "+ Add tool" menu
  direction?: EdgeDirection;
  accent?: string;
  icon?: ConnectorIconKey;
}

function uid() {
  return Math.random().toString(36).slice(2);
}


const STATUS_COLOR: Record<ToolStatus, string> = {
  online:  '#22c55e',
  warning: '#eab308',
  error:   '#ef4444',
};

// Each backend service surfaces in the graph through the tool node it powers,
// plus the central AGENT node (which is the nff-agent-worker process). A node is
// green only while its service is sending fresh heartbeats; otherwise it reads
// red. Tools not backed by one of these services render grey.
const SERVICE_BY_TOOL: Record<string, ServiceName> = {
  'Fleet Tool':       'nff-fleet',
  'OTA Tool':         'nff-ota',
  'GitHub Connector': 'nff-github',
  'Diagnosis Tool':   'nff-diagnosis',
  'Builder Tool':     'nff-builder',
};
const GREY = '#ccc';


interface AgentManagementTabProps {
  isMobile?: boolean;
  // Opens the Builder view (the read + light-control surface over nff-builder's feature
  // plans). Reached from here so "developing a feature" starts in Management.
  onOpenBuilder?: () => void;
}

export function AgentManagementTab({ isMobile, onOpenBuilder }: AgentManagementTabProps = {}) {
  const { priorities, tools, setPriorities, setTools } = useAgentConfig();
  const { task: dbTask }                               = useAgentTasks();
  const { isOnline }                                   = useServiceStatus();
  const { tunnelOnline }                               = useGithubTunnel();
  const task = dbTask ?? { title: '—', steps: [] };

  // nff-github is the one service reached only through its public tunnel, so its
  // heartbeat (posted from inside the box) isn't enough: a fresh beat with a dead
  // tunnel is unreachable. Require online AND the tunnel probe before calling it up.
  const serviceUp = (svc: ServiceName): boolean =>
    isOnline(svc) && (svc !== 'nff-github' || tunnelOnline);

  // The central AGENT node represents the nff-agent-worker; its color reflects
  // that service's live heartbeat.
  const workerOnline = isOnline('nff-agent-worker');
  const agentColor   = workerOnline ? STATUS_COLOR.online : STATUS_COLOR.error;

  // Display color/label is derived from each service's live heartbeat: a
  // service-backed tool is green/red by its service's status, everything else
  // is grey.
  const toolColor = (t: Tool): string => {
    if (!t.active) return GREY;
    const svc = SERVICE_BY_TOOL[t.name];
    if (svc) return serviceUp(svc) ? STATUS_COLOR.online : STATUS_COLOR.error;
    return GREY;
  };
  const toolLabel = (t: Tool): string => {
    if (!t.active) return 'offline';
    const svc = SERVICE_BY_TOOL[t.name];
    if (svc) return serviceUp(svc) ? 'online' : 'offline';
    return 'idle';
  };
  const [splitPct, setSplitPct]     = useState(40);
  const [leftSplitPct, setLeftSplitPct] = useState(55);
  const [dragging, setDragging]     = useState(false);
  const [newPriorityLabel, setNewPriorityLabel] = useState('');
  const [addingPriority, setAddingPriority]     = useState(false);
  const [addingTool, setAddingTool]             = useState(false);
  // Which tool node the cursor is over — its 🗑 hide button shows only on hover (desktop radial).
  const [hoveredToolId, setHoveredToolId]       = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'priorities' | 'tasks' | 'tools'>('priorities');
  const containerRef = useRef<HTMLDivElement>(null);
  const leftRef      = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (!canvasRef.current) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setCanvasSize({ w: width, h: height });
    });
    ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!isMobile || mobilePanel !== 'tools') return;
    const frame = requestAnimationFrame(() => {
      if (!canvasRef.current) return;
      const { width, height } = canvasRef.current.getBoundingClientRect();
      if (width > 0 && height > 0) setCanvasSize({ w: width, h: height });
    });
    return () => cancelAnimationFrame(frame);
  }, [isMobile, mobilePanel]);

  // Close the connector menu on Escape.
  useEffect(() => {
    if (!addingTool) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setAddingTool(false); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [addingTool]);

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    setDragging(true);
    function onMove(ev: MouseEvent) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(70, Math.max(20, pct)));
    }
    function onUp() {
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function startLeftDrag(e: React.MouseEvent) {
    e.preventDefault();
    function onMove(ev: MouseEvent) {
      if (!leftRef.current) return;
      const rect = leftRef.current.getBoundingClientRect();
      const pct = ((ev.clientY - rect.top) / rect.height) * 100;
      setLeftSplitPct(Math.min(80, Math.max(20, pct)));
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function togglePriority(id: string) {
    setPriorities(prev => prev.map(p => p.id === id ? { ...p, enabled: !p.enabled } : p));
  }

  function movePriority(id: string, dir: -1 | 1) {
    setPriorities(prev => {
      const idx = prev.findIndex(p => p.id === id);
      const next = idx + dir;
      if (next < 0 || next >= prev.length) return prev;
      const arr = [...prev];
      [arr[idx], arr[next]] = [arr[next], arr[idx]];
      return arr;
    });
  }

  function updatePriorityLabel(id: string, label: string) {
    setPriorities(prev => prev.map(p => p.id === id ? { ...p, label } : p));
  }

  function commitNewPriority() {
    const label = newPriorityLabel.trim();
    if (label) setPriorities(prev => [...prev, { id: uid(), label, enabled: true }]);
    setNewPriorityLabel('');
    setAddingPriority(false);
  }

  function toggleToolActive(id: string) {
    setTools(prev => prev.map(t => t.id === id ? { ...t, active: !t.active } : t));
  }

  // Trash icon → remove a tool from the graph; restored from the connector menu's Hidden section.
  function hideTool(id: string) {
    setTools(prev => prev.map(t => t.id === id ? { ...t, hidden: true } : t));
  }
  function unhideTool(id: string) {
    setTools(prev => prev.map(t => t.id === id ? { ...t, hidden: false } : t));
  }

  // The tools actually drawn in the radial/list views (hidden ones are removed until restored).
  const visibleTools = tools.filter(t => !t.hidden);
  const hiddenTools = tools.filter(t => t.hidden);

  // The curated connector menu only offers the five external services in
  // CONNECTOR_CATALOG. Selecting one appends a Tool node (UI/config layer only;
  // backend wiring is the separate nff-connect work). Dedupe by name so a
  // connector can't be added twice — already-added rows render disabled instead.
  const connectedNames = new Set(tools.map(t => t.name));

  function addConnector(def: ConnectorDef) {
    if (connectedNames.has(def.name)) return;
    setTools(prev => [...prev, {
      id: uid(),
      name: def.name,
      description: def.description,
      status: 'online',
      active: true,
      direction: def.direction,
      accent: def.accent,
      icon: def.icon,
    }]);
    setAddingTool(false);
  }

  // Shared connector picker: a list where each row shows the connector's SVG
  // logo on the left (on its accent chip) + name/description. Used by both the
  // desktop overlay and the mobile stacked panel. Already-connected rows are
  // disabled and marked ✓.
  const connectorMenu = (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 230, maxWidth: 300 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px', borderBottom: '1px solid #000', fontSize: 11, fontWeight: 'bold' }}>
        <span>Connect a tool</span>
        <button onClick={() => setAddingTool(false)} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: '#999', padding: 0, lineHeight: 1 }}>✕</button>
      </div>
      {CONNECTOR_CATALOG.map(def => {
        const connected = connectedNames.has(def.name);
        return (
          <button
            key={def.icon}
            onClick={() => addConnector(def)}
            disabled={connected}
            title={connected ? `${def.name} already connected` : `Connect ${def.name}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
              padding: '6px 8px', border: 'none', borderBottom: '1px solid #eee',
              background: connected ? '#fafafa' : '#fff', cursor: connected ? 'default' : 'pointer',
              opacity: connected ? 0.55 : 1,
            }}
          >
            <span style={{ width: 24, height: 24, flexShrink: 0, background: def.accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <ConnectorLogo icon={def.icon} size={15} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 12, fontWeight: 'bold', color: '#000' }}>{def.name}</span>
              <span style={{ display: 'block', fontSize: 9, color: '#888', lineHeight: 1.3, whiteSpace: 'normal' }}>{def.description}</span>
            </span>
            {connected && <span style={{ fontSize: 10, color: '#22c55e', flexShrink: 0 }}>✓ connected</span>}
          </button>
        );
      })}
      {hiddenTools.length > 0 && (
        <>
          <div style={{ padding: '4px 8px', borderTop: '1px solid #000', borderBottom: '1px solid #eee', fontSize: 11, fontWeight: 'bold', color: '#555' }}>
            Hidden tools
          </div>
          {hiddenTools.map(t => (
            <button
              key={t.id}
              onClick={() => unhideTool(t.id)}
              title={`Restore ${t.name}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                padding: '6px 8px', border: 'none', borderBottom: '1px solid #eee', background: '#fff', cursor: 'pointer',
              }}
            >
              {t.icon ? (
                <span style={{ width: 24, height: 24, flexShrink: 0, background: t.accent ?? '#aaa', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <ConnectorLogo icon={t.icon} size={15} />
                </span>
              ) : (
                <span style={{ width: 24, height: 24, flexShrink: 0, background: '#eee', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#888' }}>⌗</span>
              )}
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 'bold', color: '#000' }}>{t.name}</span>
                <span style={{ display: 'block', fontSize: 9, color: '#888', lineHeight: 1.3, whiteSpace: 'normal' }}>{t.description}</span>
              </span>
              <span style={{ fontSize: 10, color: '#1d4ed8', flexShrink: 0 }}>+ restore</span>
            </button>
          ))}
        </>
      )}
    </div>
  );

  const panelHeader = (_label: string): React.CSSProperties => ({
    padding: '4px 8px',
    borderBottom: '1px solid #000',
    fontSize: 12,
    fontWeight: 'bold',
    flexShrink: 0,
  });

  const prioritiesContent = (
    <>
      <div style={panelHeader('Agent Priorities')}>Agent Priorities</div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {priorities.map((p, i) => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: '1px solid #eee', fontSize: 13 }}>
            <span style={{ color: '#999', fontSize: 11, cursor: 'default', flexShrink: 0 }}>↕</span>
            <input type="checkbox" checked={p.enabled} onChange={() => togglePriority(p.id)} style={{ flexShrink: 0, cursor: 'pointer' }} />
            <input
              value={p.label}
              onChange={e => updatePriorityLabel(p.id, e.target.value)}
              style={{ flex: 1, border: 'none', outline: 'none', fontSize: 13, background: 'transparent', fontFamily: 'inherit', color: p.enabled ? '#000' : '#999', minWidth: 0 }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
              <button onClick={() => movePriority(p.id, -1)} disabled={i === 0}
                style={{ border: 'none', background: 'none', cursor: i === 0 ? 'default' : 'pointer', fontSize: 9, padding: 0, color: i === 0 ? '#ccc' : '#000', lineHeight: 1 }}>▲</button>
              <button onClick={() => movePriority(p.id, 1)} disabled={i === priorities.length - 1}
                style={{ border: 'none', background: 'none', cursor: i === priorities.length - 1 ? 'default' : 'pointer', fontSize: 9, padding: 0, color: i === priorities.length - 1 ? '#ccc' : '#000', lineHeight: 1 }}>▼</button>
            </div>
          </div>
        ))}
        {addingPriority ? (
          <div style={{ display: 'flex', gap: 6, padding: '4px 8px', alignItems: 'center' }}>
            <input autoFocus value={newPriorityLabel} onChange={e => setNewPriorityLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commitNewPriority(); if (e.key === 'Escape') setAddingPriority(false); }}
              placeholder="Priority label…"
              style={{ flex: 1, fontSize: 13, border: '1px solid #ccc', padding: '2px 4px', outline: 'none', fontFamily: 'inherit' }}
            />
            <button onClick={commitNewPriority} style={{ fontSize: 12, border: '1px solid #000', background: 'none', cursor: 'pointer', padding: '1px 6px' }}>Add</button>
            <button onClick={() => setAddingPriority(false)} style={{ fontSize: 12, border: 'none', background: 'none', cursor: 'pointer', color: '#999' }}>✕</button>
          </div>
        ) : (
          <button onClick={() => setAddingPriority(true)}
            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: '#555' }}>
            + Add priority
          </button>
        )}
      </div>
    </>
  );

  const tasksContent = (
    <>
      <div style={{ ...panelHeader('Current Task'), display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1 }}>Current Task</span>
        {onOpenBuilder && (
          <button
            onClick={onOpenBuilder}
            title="Plan and track a new firmware feature"
            style={{ border: '1px solid #000', background: '#fff', color: '#000', cursor: 'pointer', fontSize: 10, fontWeight: 'bold', letterSpacing: 0.3, padding: '2px 6px' }}
          >
            + Develop Feature
          </button>
        )}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
        {(() => {
          // Render the descending breadcrumb path: mission › target › action, the
          // live leaf (current tool call) emphasized, ancestors muted. `task.steps`
          // is the spine the worker maintains; an empty spine means no tool call is
          // in flight, so the worker is idle.
          const hasActive = task.steps.length > 0;
          if (!hasActive) {
            return (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ccc', flexShrink: 0, marginRight: 2 }} />
                <span style={{ color: '#888', fontStyle: 'italic' }}>worker idle</span>
              </div>
            );
          }
          const segments = [task.title, ...task.steps.map(s => s.label)];
          return (
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, fontSize: 12, lineHeight: 1.7 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', flexShrink: 0, marginRight: 2 }} />
              {segments.map((seg, i) => {
                const isLeaf = i === segments.length - 1;
                return (
                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {i > 0 && <span style={{ color: '#bbb' }}>›</span>}
                    <span style={{ color: isLeaf ? '#000' : '#888', fontWeight: isLeaf ? 'bold' : 'normal', fontStyle: isLeaf ? 'italic' : 'normal' }}>
                      {seg}
                    </span>
                  </span>
                );
              })}
            </div>
          );
        })()}
      </div>
      <AgentTokenUsage />
    </>
  );

  const toolsContent = (
    <>
      <div style={panelHeader('Hooked Tools')}>Hooked Tools</div>
      <div ref={canvasRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {canvasSize.w > 0 && canvasSize.h > 0 && (() => {
          const cx = canvasSize.w / 2;
          const cy = canvasSize.h / 2;
          const radius = Math.max(80, Math.min(cx, cy) * 0.62);
          const N = visibleTools.length;
          const BOX_W = 120;
          const HALF_W = BOX_W / 2;
          const HALF_H = 44;

          return (
            <>
              <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
                {visibleTools.map((t, i) => {
                  const angle = (2 * Math.PI * i) / N - Math.PI / 2;
                  const bx = cx + radius * Math.cos(angle);
                  const by = cy + radius * Math.sin(angle);
                  const dir = t.direction ?? 'undirected';
                  const color = toolColor(t);
                  const ux = Math.cos(angle), uy = Math.sin(angle);
                  const ax = cx + ux * 28, ay = cy + uy * 28;
                  const au = Math.abs(ux), av = Math.abs(uy);
                  const tClear = av < 0.001 ? HALF_W / au : au < 0.001 ? HALF_H / av : Math.min(HALF_W / au, HALF_H / av);
                  const tx = bx - ux * tClear, ty = by - uy * tClear;
                  const A = 7;
                  const OFF = 6;
                  const perpX = -uy * OFF, perpY = ux * OFF;
                  const dashes = t.active ? undefined : '4 3';
                  const arrowHead = (x1: number, y1: number, x2: number, y2: number) => {
                    const ddx = x2 - x1, ddy = y2 - y1;
                    const ll = Math.sqrt(ddx * ddx + ddy * ddy);
                    if (ll < 1) return null;
                    const uux = ddx / ll, uuy = ddy / ll;
                    const ppx = -uuy * (A * 0.45), ppy = uux * (A * 0.45);
                    const bx2 = x2 - uux * A, by2 = y2 - uuy * A;
                    return <polygon points={`${x2},${y2} ${bx2 + ppx},${by2 + ppy} ${bx2 - ppx},${by2 - ppy}`} fill={color} />;
                  };
                  if (dir === 'bidirectional') {
                    return (
                      <g key={t.id}>
                        <line x1={ax + perpX} y1={ay + perpY} x2={tx + perpX - ux * A} y2={ty + perpY - uy * A} stroke={color} strokeWidth={1.5} strokeDasharray={dashes} />
                        {arrowHead(ax + perpX, ay + perpY, tx + perpX, ty + perpY)}
                        <line x1={tx - perpX} y1={ty - perpY} x2={ax - perpX + ux * A} y2={ay - perpY + uy * A} stroke={color} strokeWidth={1.5} strokeDasharray={dashes} />
                        {arrowHead(tx - perpX, ty - perpY, ax - perpX, ay - perpY)}
                      </g>
                    );
                  }
                  if (dir === 'inbound') {
                    return (
                      <g key={t.id}>
                        <line x1={tx} y1={ty} x2={ax + ux * A} y2={ay + uy * A} stroke={color} strokeWidth={1.5} strokeDasharray={dashes} />
                        {arrowHead(tx, ty, ax, ay)}
                      </g>
                    );
                  }
                  return (
                    <g key={t.id}>
                      <line x1={ax} y1={ay} x2={tx - ux * A} y2={ty - uy * A} stroke={color} strokeWidth={1.5} strokeDasharray={dashes} />
                      {arrowHead(ax, ay, tx, ty)}
                    </g>
                  );
                })}
              </svg>
              <div title={`nff-agent-worker: ${workerOnline ? 'online' : 'offline'}`} style={{ position: 'absolute', left: cx, top: cy, transform: 'translate(-50%, -50%)', width: 52, height: 52, border: `2px solid ${agentColor}`, background: '#000', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 'bold', letterSpacing: 0.5, boxSizing: 'border-box', zIndex: 1 }}>
                AGENT
              </div>
              {visibleTools.map((t, i) => {
                const angle = (2 * Math.PI * i) / N - Math.PI / 2;
                const bx = cx + radius * Math.cos(angle);
                const by = cy + radius * Math.sin(angle);
                const borderColor = toolColor(t);
                return (
                  <div
                    key={t.id}
                    onMouseEnter={() => setHoveredToolId(t.id)}
                    onMouseLeave={() => setHoveredToolId(prev => (prev === t.id ? null : prev))}
                    style={{ position: 'absolute', left: bx, top: by, transform: 'translate(-50%, -50%)', width: BOX_W, border: `2px solid ${borderColor}`, background: '#fff', boxSizing: 'border-box', padding: '4px 6px', display: 'flex', flexDirection: 'column', gap: 3, zIndex: hoveredToolId === t.id ? 2 : 1 }}
                  >
                    {t.icon && (
                      <div style={{ position: 'absolute', top: -12, left: -12, width: 24, height: 24, background: toolColor(t) === GREY ? '#aaa' : toolColor(t), display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2 }}>
                        <ConnectorLogo icon={t.icon} size={16} />
                      </div>
                    )}
                    <button
                      onClick={() => hideTool(t.id)}
                      title="Hide tool"
                      style={{ position: 'absolute', top: -10, right: -10, width: 20, height: 20, border: '1px solid #000', background: '#fff', color: '#b91c1c', cursor: 'pointer', fontSize: 11, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, zIndex: 3, opacity: hoveredToolId === t.id ? 1 : 0, pointerEvents: hoveredToolId === t.id ? 'auto' : 'none', transition: 'opacity .12s' }}
                    >
                      🗑
                    </button>
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                      <div style={{ flex: 1 }} />
                      <span style={{ flex: 1, textAlign: 'center', fontSize: 9, cursor: 'default', color: toolColor(t), textTransform: 'uppercase', letterSpacing: 0.3 }}>
                        {toolLabel(t)}
                      </span>
                      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                        {t.direction && t.direction !== 'undirected' && (
                          <span style={{ fontSize: 10, color: toolColor(t) }}>
                            {t.direction === 'bidirectional' ? '⇄' : t.direction === 'inbound' ? '←' : '→'}
                          </span>
                        )}
                        <input type="checkbox" checked={t.active} onChange={() => toggleToolActive(t.id)} style={{ cursor: 'pointer', margin: 0 }} />
                      </div>
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 'bold', wordBreak: 'break-word' }}>{t.name}</div>
                    <div style={{ fontSize: 9, color: '#888', lineHeight: 1.3 }}>{t.description}</div>
                  </div>
                );
              })}
              <button onClick={() => setAddingTool(v => !v)} style={{ position: 'absolute', bottom: 8, right: 8, fontSize: 11, border: '1px solid #000', background: addingTool ? '#000' : 'none', color: addingTool ? '#fff' : '#000', cursor: 'pointer', padding: '2px 8px', zIndex: 3 }}>
                + Add tool
              </button>
              {addingTool && (
                <>
                  {/* outside-click backdrop */}
                  <div onClick={() => setAddingTool(false)} style={{ position: 'absolute', inset: 0, zIndex: 2 }} />
                  <div style={{ position: 'absolute', bottom: 36, right: 8, background: '#fff', border: '1px solid #000', boxShadow: '0 2px 8px rgba(0,0,0,0.15)', zIndex: 3, maxHeight: '80%', overflowY: 'auto' }}>
                    {connectorMenu}
                  </div>
                </>
              )}
            </>
          );
        })()}
      </div>
    </>
  );

  const mobileToolsContent = (
    <>
      <div style={panelHeader('Hooked Tools')}>Hooked Tools</div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 6, boxSizing: 'border-box' }}>
        <div title={`nff-agent-worker: ${workerOnline ? 'online' : 'offline'}`} style={{ padding: '3px 8px', background: '#000', color: '#fff', border: `2px solid ${agentColor}`, fontSize: 10, fontWeight: 'bold', letterSpacing: 0.5, alignSelf: 'flex-start', marginBottom: 2 }}>
          AGENT
        </div>
        {visibleTools.map(t => {
          const borderColor = toolColor(t);
          return (
            <div key={t.id} style={{ border: `2px solid ${borderColor}`, padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 8, boxSizing: 'border-box' }}>
              {t.icon ? (
                <span style={{ width: 20, height: 20, flexShrink: 0, background: borderColor === GREY ? '#aaa' : borderColor, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <ConnectorLogo icon={t.icon} size={13} />
                </span>
              ) : (
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: borderColor, flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</div>
                <div style={{ fontSize: 9, color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.description}</div>
              </div>
              {t.direction && t.direction !== 'undirected' && (
                <span style={{ fontSize: 12, color: toolColor(t), flexShrink: 0 }}>
                  {t.direction === 'bidirectional' ? '⇄' : t.direction === 'inbound' ? '←' : '→'}
                </span>
              )}
              <span style={{ fontSize: 9, cursor: 'default', color: toolColor(t), textTransform: 'uppercase', flexShrink: 0 }}>
                {toolLabel(t)}
              </span>
              <input type="checkbox" checked={t.active} onChange={() => toggleToolActive(t.id)} style={{ cursor: 'pointer', margin: 0, flexShrink: 0 }} />
              {/* Mobile/touch has no hover, so the hide button stays always-visible here. */}
              <button onClick={() => hideTool(t.id)} title="Hide tool" style={{ border: 'none', background: 'none', color: '#b91c1c', cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1, flexShrink: 0 }}>🗑</button>
            </div>
          );
        })}
        {!addingTool ? (
          <button onClick={() => setAddingTool(true)} style={{ alignSelf: 'flex-start', fontSize: 11, border: '1px solid #000', background: 'none', cursor: 'pointer', padding: '2px 8px' }}>
            + Add tool
          </button>
        ) : (
          <div style={{ border: '1px solid #000', alignSelf: 'stretch' }}>
            {connectorMenu}
          </div>
        )}
      </div>
    </>
  );

  if (isMobile) {
    const btnStyle = (active: boolean, last?: boolean): React.CSSProperties => ({
      flex: 1, padding: '6px 0', fontSize: 11,
      border: 'none', borderRight: last ? 'none' : '1px solid #000',
      background: active ? '#000' : '#fff', color: active ? '#fff' : '#000', cursor: 'pointer',
    });
    return (
      <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ display: 'flex', flexShrink: 0, borderBottom: '1px solid #000' }}>
          <button onClick={() => setMobilePanel('priorities')} style={btnStyle(mobilePanel === 'priorities')}>Priorities</button>
          <button onClick={() => setMobilePanel('tasks')} style={btnStyle(mobilePanel === 'tasks')}>Tasks</button>
          <button onClick={() => setMobilePanel('tools')} style={btnStyle(mobilePanel === 'tools', true)}>Tools</button>
        </div>
        <div style={{ display: mobilePanel === 'priorities' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          {prioritiesContent}
        </div>
        <div style={{ display: mobilePanel === 'tasks' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          {tasksContent}
        </div>
        <div style={{ display: mobilePanel === 'tools' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          {mobileToolsContent}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ display: 'flex', height: '100%', userSelect: dragging ? 'none' : 'auto' }}
    >
      <div ref={leftRef} style={{ width: `${splitPct}%`, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ height: `${leftSplitPct}%`, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {prioritiesContent}
        </div>
        <div onMouseDown={startLeftDrag} style={{ height: 5, flexShrink: 0, background: '#000', cursor: 'row-resize' }} />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {tasksContent}
        </div>
      </div>
      <div onMouseDown={startDrag} style={{ width: 5, flexShrink: 0, background: '#000', cursor: 'col-resize' }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {toolsContent}
      </div>
    </div>
  );
}
