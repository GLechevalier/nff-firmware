import { useEffect, useState } from 'react';
import { BRAND_ACCENT } from '../../../lib/brand';
import { useOtaJobs } from '../hooks/useOtaJobs';
import { useDeployments } from '../hooks/useDeployments';
import type { OtaJob, OtaStatus } from '../data/mockOtaJobs';

// Floating "upload wizard", docked bottom-right, that tracks one OTA rollout live:
// every device stepping queued → downloading X% → installing → rebooting → healthy.
// Mounts at App level so it survives tab switches (same pattern as BuildChecklistModal).
// Data is entirely Supabase Realtime (useOtaJobs granular row patches + useDeployments);
// the backend (progress webhook + ota_result feedback loop) drives the rows.

interface Props {
  deploymentId: string;
  onDismiss: () => void;
  onOpenOta?: () => void;
  /** Shift up so the tracker doesn't cover BuildChecklistModal when both are open. */
  raised?: boolean;
}

type StepState = 'done' | 'running' | 'failed' | 'pending';

const STEP_ICON: Record<StepState, string> = { done: '✓', running: '▶', failed: '✕', pending: '○' };
const STEP_COLOR: Record<StepState, string> = { done: '#22c55e', running: '#000', failed: '#dc2626', pending: '#ccc' };

const TERMINAL: OtaStatus[] = ['success', 'already-installed', 'committed', 'failure', 'rolled_back', 'aborted', 'timed_out', 'decommissioned'];
const FAILED: OtaStatus[] = ['failure', 'rolled_back', 'aborted', 'timed_out'];

interface DeviceStep {
  state: StepState;
  label: string;
  /** 0-100 while downloading, else null. */
  pct: number | null;
}

// One device's position in the OTA pipeline. `verifying` is a legal DB state the
// backend never emits today; it renders as installing-adjacent if it ever appears.
function deriveStep(job: OtaJob): DeviceStep {
  switch (job.status) {
    case 'pending':      return { state: 'pending', label: 'queued', pct: null };
    case 'downloading':  return { state: 'running', label: `downloading ${job.progress}%`, pct: job.progress };
    case 'verifying':    return { state: 'running', label: 'verifying', pct: null };
    case 'installing':   return { state: 'running', label: 'installing', pct: null };
    case 'rebooting':    return { state: 'running', label: 'rebooting / health check', pct: null };
    case 'success':
    case 'committed':
    case 'already-installed':
      return { state: 'done', label: 'healthy', pct: null };
    case 'decommissioned':
      return { state: 'pending', label: 'decommissioned', pct: null };
    default:
      return { state: 'failed', label: job.status === 'timed_out' ? 'timed out' : 'failed', pct: null };
  }
}

function DeviceRow({ job }: { job: OtaJob }) {
  const step = deriveStep(job);
  return (
    <div style={{ padding: '3px 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
        <span style={{ flexShrink: 0, width: 12, color: STEP_COLOR[step.state], fontSize: 12 }}>
          {STEP_ICON[step.state]}
        </span>
        <span style={{
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: step.state === 'pending' ? '#aaa' : '#000',
          fontWeight: step.state === 'running' ? 700 : 400,
        }}>
          {job.deviceName}
        </span>
        <span style={{
          flexShrink: 0, fontSize: 10,
          color: step.state === 'failed' ? STEP_COLOR.failed : step.state === 'done' ? STEP_COLOR.done : '#666',
          fontStyle: step.state === 'running' ? 'italic' : 'normal',
        }}>
          {step.label}
        </span>
      </div>
      {step.pct !== null && (
        <div style={{ marginLeft: 19, marginTop: 2, height: 4, background: '#e5e5e5' }}>
          <div style={{ height: '100%', background: BRAND_ACCENT, width: `${step.pct}%`, transition: 'width 0.3s' }} />
        </div>
      )}
      {step.state === 'failed' && job.failureReason && (
        <div style={{ marginLeft: 19, fontSize: 10, color: STEP_COLOR.failed, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {job.failureReason}
        </div>
      )}
    </div>
  );
}

export function OtaRolloutModal({ deploymentId, onDismiss, onOpenOta, raised }: Props) {
  const { jobs } = useOtaJobs();
  const { deployments } = useDeployments();
  const [minimized, setMinimized] = useState(false);

  // Escape minimizes (never dismisses) so the tracker isn't lost by accident.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMinimized(true);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const deployment = deployments.find(d => d.id === deploymentId);
  const rolloutJobs = jobs
    .filter(j => j.deploymentId === deploymentId)
    .sort((a, b) => a.deviceName.localeCompare(b.deviceName));

  // The deployment row (created first) can arrive before its ota_jobs rows are
  // inserted — keep rendering the shell instead of vanishing.
  if (!deployment && rolloutJobs.length === 0) return null;

  const total = rolloutJobs.length;
  const terminalCount = rolloutJobs.filter(j => TERMINAL.includes(j.status)).length;
  const failedCount = rolloutJobs.filter(j => FAILED.includes(j.status)).length;
  const depTerminal = deployment?.status === 'finished' || deployment?.status === 'aborted';
  const allDone = depTerminal || (total > 0 && terminalCount === total);
  const version = deployment?.targetVersion ?? rolloutJobs[0]?.targetVersion ?? '';

  const title = allDone
    ? (failedCount > 0 ? `✕ Rolled out v${version} (${failedCount} failed)` : `✓ Rolled out v${version}`)
    : `Rolling out v${version}`;

  return (
    <div
      onClick={e => e.stopPropagation()}
      style={{
        position: 'fixed', bottom: raised ? 96 : 16, right: 16, zIndex: 9997, width: 320,
        background: '#fff', border: '1.5px solid #000', boxShadow: '4px 4px 0 #000',
        display: 'flex', flexDirection: 'column', maxHeight: '70vh',
      }}
    >
      <div
        onClick={() => setMinimized(m => !m)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
          background: BRAND_ACCENT, color: '#fff', cursor: 'pointer',
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 'bold' }}>
          {title}
        </span>
        <span style={{ fontSize: 10, color: '#ddd', flexShrink: 0 }}>{terminalCount}/{total}</span>
        <button
          onClick={e => { e.stopPropagation(); setMinimized(m => !m); }}
          title={minimized ? 'Expand' : 'Minimize'}
          style={{ border: 'none', background: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}
        >
          {minimized ? '▢' : '–'}
        </button>
        <button
          onClick={e => { e.stopPropagation(); onDismiss(); }}
          title="Dismiss (rollout keeps running)"
          style={{ border: 'none', background: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}
        >
          ×
        </button>
      </div>
      {!minimized && (
        <div style={{ padding: '8px 10px', overflowY: 'auto', fontSize: 12, lineHeight: 1.5 }}>
          {total === 0 && (
            <div style={{ color: '#888', fontSize: 11 }}>Preparing devices…</div>
          )}
          {rolloutJobs.map(j => <DeviceRow key={j.id} job={j} />)}

          {deployment?.haltedReason && (
            <div style={{ marginTop: 6, padding: '4px 6px', background: '#fef2f2', border: '1px solid #dc2626', fontSize: 11, color: '#b91c1c' }}>
              Halted: {deployment.haltedReason}
            </div>
          )}

          {onOpenOta && (
            <button
              onClick={onOpenOta}
              style={{
                marginTop: 8, width: '100%', padding: '4px 0', background: 'none',
                border: '1px solid #000', color: '#000', cursor: 'pointer', fontSize: 11,
              }}
            >
              Open in Deploy tab →
            </button>
          )}

          {allDone && (
            <div style={{ marginTop: 8, fontSize: 11, color: failedCount > 0 ? '#b91c1c' : '#15803d' }}>
              {failedCount > 0
                ? `${failedCount} of ${total} device${total === 1 ? '' : 's'} failed — see the Deploy tab.`
                : 'All devices are healthy on the new firmware.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
