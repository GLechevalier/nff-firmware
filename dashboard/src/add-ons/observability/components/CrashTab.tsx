import { useEffect, useRef, useState } from 'react';
import type { CrashReport } from '../types/crash';
import { useCrashReports } from '../hooks/useCrashReports';
import { supabase } from '../../../lib/supabase';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import { StatusBadge } from './StatusBadge';
import { CopyButton } from '../../../components/squeletton/CopyButton';
import { formatRelativeTime } from '../../../utils/time';
import { Queryable } from '../../../components/squeletton/Queryable';
import type { OnQueryClick } from '../../../types/query';

const LEVEL_COLOR: Record<'I' | 'W' | 'E', string> = {
  I: '#555',
  W: '#d97706',
  E: '#ef4444',
};

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function isUserCode(resolved: string): boolean {
  return resolved.includes(' at src/');
}

interface CrashRowProps {
  report: CrashReport;
  selected: boolean;
  onClick: () => void;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}

function CrashRow({ report, selected, onClick, queryMode, onQueryClick }: CrashRowProps) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '8px 10px',
        borderBottom: '1px solid #eee',
        cursor: 'pointer',
        background: selected ? '#f5f5f5' : 'transparent',
        borderLeft: selected ? '3px solid #000' : '3px solid transparent',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          title={report.retained ? 'Retained on broker' : 'Not retained'}
          style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: report.retained ? '#ef4444' : '#ccc',
          }}
        />
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Device Name"
          value={report.deviceName}
          subject={`Crash on ${report.deviceName}`}
          details={{ crashId: report.id, timestamp: String(report.timestamp) }}
          style={{ fontWeight: 'bold', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {report.deviceName}
        </Queryable>
        {report.crashCount > 1 && (
          <span style={{
            fontSize: 10, fontWeight: 'bold',
            background: '#ef4444', color: '#fff',
            padding: '1px 5px', borderRadius: 8,
          }}>
            {report.crashCount}x
          </span>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 14 }}>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Crash Reason"
          value={report.reason}
          subject={`Crash on ${report.deviceName}`}
          details={{ crashId: report.id, timestamp: String(report.timestamp) }}
          style={{ fontSize: 12, color: '#555' }}
        >
          {report.reason}
        </Queryable>
        <span style={{ fontSize: 11, color: '#999' }}>{formatRelativeTime(report.timestamp)}</span>
      </div>
    </div>
  );
}

interface CrashDetailProps {
  report: CrashReport;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}

function CrashDetail({ report, queryMode, onQueryClick }: CrashDetailProps) {
  const { currentProjectId } = useCurrentProject();
  const [repairState, setRepairState] = useState<'idle' | 'sent'>('idle');

  async function repairWithAgent() {
    if (!currentProjectId) return;
    // Hand off to nff-agent-worker exactly like nff-github's repair.py: a session-less
    // role='user' row the worker picks up. The agent diagnoses and (for a firmware bug)
    // opens a fix PR; its run streams live in the Agent tab.
    const prompt =
      `Device \`${report.deviceId}\` (${report.deviceName}) reported a crash: ` +
      `${report.reason} (exception_cause ${report.exceptionCause}, pc ${report.pc}), ` +
      `firmware ${report.fwVersion}, build ${report.buildId}, ${report.crashCount} crash(es). ` +
      `Diagnose it with fleet_get_crash + diagnose_serial and repair it: reboot if it's a ` +
      `transient fault, or open a fix PR (then OTA) if it's a firmware bug. Confirm recovery.`;
    await supabase.from('agent_messages').insert({
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt,
      ts: new Date().toISOString(),
      session_id: null,
      project_id: currentProjectId,
    });
    setRepairState('sent');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #000', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <StatusBadge status={report.deviceStatus} deviceId={report.deviceId} />
          <strong style={{ fontSize: 14 }}>{report.deviceName}</strong>
          {report.retained && (
            <span style={{ fontSize: 10, color: '#ef4444', border: '1px solid #ef4444', padding: '1px 5px' }}>
              RETAINED
            </span>
          )}
          <button
            onClick={repairWithAgent}
            disabled={repairState === 'sent'}
            title="Hand this crash to the agent to diagnose and repair"
            style={{
              marginLeft: 'auto', fontSize: 11,
              padding: '3px 9px', cursor: repairState === 'sent' ? 'default' : 'pointer',
              border: '1px solid #000', background: repairState === 'sent' ? '#eee' : '#000',
              color: repairState === 'sent' ? '#888' : '#fff',
            }}
          >
            {repairState === 'sent' ? 'Repair requested ↗' : 'Repair with agent'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 24, fontSize: 12, flexWrap: 'wrap' }}>
          <span><span style={{ color: '#888' }}>fw </span>
            <Queryable
              queryMode={queryMode}
              onQueryClick={onQueryClick}
              field="Firmware Version"
              value={report.fwVersion}
              subject={`Crash on ${report.deviceName}`}
              details={{ crashId: report.id, timestamp: String(report.timestamp) }}
            >
              {report.fwVersion}
            </Queryable>
          </span>
          <span><span style={{ color: '#888' }}>build </span>
            <Queryable
              queryMode={queryMode}
              onQueryClick={onQueryClick}
              field="Build ID"
              value={report.buildId}
              subject={`Crash on ${report.deviceName}`}
              details={{ crashId: report.id, timestamp: String(report.timestamp) }}
            >
              {report.buildId}
            </Queryable>
          </span>
          <span><span style={{ color: '#888' }}>pc </span>
            <Queryable
              queryMode={queryMode}
              onQueryClick={onQueryClick}
              field="Program Counter"
              value={report.pc}
              subject={`Crash on ${report.deviceName}`}
              details={{ crashId: report.id, timestamp: String(report.timestamp) }}
            >
              {report.pc}
            </Queryable>
          </span>
          <span><span style={{ color: '#888' }}>cause </span>
            <Queryable
              queryMode={queryMode}
              onQueryClick={onQueryClick}
              field="Exception Cause"
              value={String(report.exceptionCause)}
              subject={`Crash on ${report.deviceName}`}
              details={{ crashId: report.id, timestamp: String(report.timestamp) }}
            >
              {report.exceptionCause}
            </Queryable>
          </span>
          <span><span style={{ color: '#888' }}>uptime </span>
            <Queryable
              queryMode={queryMode}
              onQueryClick={onQueryClick}
              field="Uptime at Crash"
              value={String(report.uptimeMs)}
              subject={`Crash on ${report.deviceName}`}
              details={{ crashId: report.id, timestamp: String(report.timestamp) }}
            >
              {formatUptime(report.uptimeMs)}
            </Queryable>
          </span>
          <span><span style={{ color: '#888' }}>crashes </span>
            <Queryable
              queryMode={queryMode}
              onQueryClick={onQueryClick}
              field="Crash Count"
              value={String(report.crashCount)}
              subject={`Crash on ${report.deviceName}`}
              details={{ crashId: report.id, timestamp: String(report.timestamp) }}
              style={{ color: report.crashCount > 1 ? '#ef4444' : '#000', fontWeight: report.crashCount > 1 ? 'bold' : 'normal' }}
            >
              {report.crashCount}
            </Queryable>
          </span>
        </div>
      </div>

      {/* Backtrace */}
      <div style={{ flexShrink: 0, borderBottom: '1px solid #ddd' }}>
        <div style={{ padding: '4px 14px', borderBottom: '1px solid #eee', fontSize: 11, fontWeight: 'bold', color: '#555', textTransform: 'uppercase', letterSpacing: 0.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Backtrace</span>
          <CopyButton
            variant="icon"
            title="Copy backtrace"
            value={() => report.backtrace
              .map((f, i) => `${i}  ${f.address}  ${f.resolved ?? '(no symbol)'}`)
              .join('\n')}
          />
        </div>
        <div style={{ overflowY: 'auto', maxHeight: 190, padding: '4px 0' }}>
          {report.backtrace.map((frame, i) => (
            <div key={i} style={{ display: 'flex', gap: 0, padding: '2px 14px', fontSize: 12, lineHeight: 1.6 }}>
              <span style={{ color: '#aaa', width: 20, flexShrink: 0, fontSize: 11, paddingTop: 1 }}>{i}</span>
              <span style={{ color: '#888', flexShrink: 0, marginRight: 12 }}>{frame.address}</span>
              <Queryable
                queryMode={queryMode}
                onQueryClick={onQueryClick}
                field="Backtrace Frame"
                value={frame.resolved ?? frame.address}
                subject={`Crash on ${report.deviceName}`}
                details={{ crashId: report.id, timestamp: String(report.timestamp), address: frame.address }}
              >
                {frame.resolved ? (
                  <span style={{ color: isUserCode(frame.resolved) ? '#000' : '#aaa', fontWeight: isUserCode(frame.resolved) ? 'bold' : 'normal' }}>
                    {frame.resolved}
                  </span>
                ) : (
                  <span style={{ color: '#d97706' }}>(no symbol)</span>
                )}
              </Queryable>
            </div>
          ))}
        </div>
      </div>

      {/* Pre-crash RTC log */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '4px 14px', borderBottom: '1px solid #eee', fontSize: 11, fontWeight: 'bold', color: '#555', textTransform: 'uppercase', letterSpacing: 0.5, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Pre-crash log (RTC memory)</span>
          <CopyButton
            variant="icon"
            title="Copy pre-crash log"
            value={() => [...report.rtcLog].reverse()
              .map(l => `[${String(l.msBeforeCrash).padStart(5)}ms] ${l.level}/${l.tag.padEnd(8)}: ${l.message}`)
              .join('\n')}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 14px', fontSize: 12, lineHeight: 1.7, background: '#000' }}>
          {[...report.rtcLog].reverse().map((line, i) => (
            <div key={i} style={{ whiteSpace: 'pre', color: LEVEL_COLOR[line.level] }}>
              <span style={{ color: '#444' }}>[{String(line.msBeforeCrash).padStart(5)}ms] </span>
              <span style={{ color: line.level === 'E' ? '#ef4444' : line.level === 'W' ? '#d97706' : '#555' }}>{line.level}/</span>
              <span style={{ color: '#888' }}>{line.tag.padEnd(8)}</span>
              {': '}
              <Queryable
                queryMode={queryMode}
                onQueryClick={onQueryClick}
                field="Pre-crash Log"
                value={line.message}
                subject={`Crash on ${report.deviceName}`}
                details={{ crashId: report.id, timestamp: String(report.timestamp), level: line.level, tag: line.tag }}
                style={{ color: LEVEL_COLOR[line.level] }}
              >
                {line.message}
              </Queryable>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface CrashTabProps {
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}

export function CrashTab({ queryMode, onQueryClick }: CrashTabProps) {
  const { crashes, loading }      = useCrashReports();
  const [selected, setSelected]   = useState<CrashReport | null>(null);
  const [splitPct, setSplitPct]   = useState(28);
  const [dragging, setDragging]   = useState(false);
  const containerRef              = useRef<HTMLDivElement>(null);


  useEffect(() => {
    if (!loading && crashes.length > 0) setSelected(prev => prev ?? crashes[0]);
  }, [loading, crashes]);

  const panelHeader = (_label: string): React.CSSProperties => ({
    padding: '4px 8px',
    borderBottom: '1px solid #000',
    fontSize: 12,
    fontWeight: 'bold',
    flexShrink: 0,
  });

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    setDragging(true);
    function onMove(ev: MouseEvent) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct  = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.min(50, Math.max(18, pct)));
    }
    function onUp() {
      setDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  const sorted = crashes;

  return (
    <div
      ref={containerRef}
      style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%', userSelect: dragging ? 'none' : 'auto' }}
    >
      {/* Left: crash list */}
      <div style={{ width: `${splitPct}%`, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={panelHeader('Crashes')}>Crashes</div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {sorted.map(report => (
            <CrashRow
              key={report.id}
              report={report}
              selected={selected?.id === report.id}
              onClick={() => setSelected(report)}
              queryMode={queryMode}
              onQueryClick={onQueryClick}
            />
          ))}
          {sorted.length === 0 && (
            <div style={{ padding: 16, color: '#999', fontSize: 13 }}>No crash reports in broker</div>
          )}
        </div>
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={startDrag}
        style={{ width: 5, flexShrink: 0, background: '#000', cursor: 'col-resize' }}
      />

      {/* Right: crash detail */}
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        {selected ? (
          <CrashDetail key={selected.id} report={selected} queryMode={queryMode} onQueryClick={onQueryClick} />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#aaa', fontSize: 13 }}>
            Select a crash report
          </div>
        )}
      </div>
    </div>
  );
}
