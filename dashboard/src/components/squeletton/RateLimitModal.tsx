import type React from 'react';
import { useState } from 'react';
import { useDeployments } from '../../add-ons/observability/hooks/useDeployments';
import type { Deployment } from '../../add-ons/observability/types/ota';

// Surfaces a deployment that nff-ota paused because the target device(s) received an OTA too
// recently (the per-device rate limit). The user decides: Override (deliver now, ignoring the
// window) or Decline (abort it). Mounted globally so it appears on any tab; driven by the same
// `deployments` Realtime subscription, so it pops as soon as the pause lands and clears itself
// once the deployment leaves `paused` (override → active/finished, decline → aborted).

function isRateLimited(d: Deployment): boolean {
  return d.status === 'paused' && (d.haltedReason ?? '').startsWith('rate_limited');
}

export function RateLimitGuard() {
  const { deployments, overrideRateLimit, declineDeployment } = useDeployments();
  // Deployments the user dismissed this session (hidden until they change again).
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const target = deployments.find(d => isRateLimited(d) && !dismissed.has(d.id)) ?? null;
  if (!target) return null;

  return (
    <RateLimitModal
      deployment={target}
      onOverride={() => overrideRateLimit(target.id)}
      onDecline={() => declineDeployment(target.id)}
      onDismiss={() => setDismissed(prev => new Set(prev).add(target.id))}
    />
  );
}

function RateLimitModal({
  deployment, onOverride, onDecline, onDismiss,
}: {
  deployment: Deployment;
  onOverride: () => Promise<void>;
  onDecline: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState<null | 'override' | 'decline'>(null);
  const [err, setErr] = useState<string | null>(null);

  // The reason is "rate_limited: <human text>" — show the human part.
  const detail = (deployment.haltedReason ?? '').replace(/^rate_limited:\s*/, '');

  async function run(which: 'override' | 'decline', fn: () => Promise<void>) {
    setBusy(which);
    setErr(null);
    try {
      await fn();
      // On success the deployment leaves `paused`; the realtime update unmounts this modal.
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }

  const btn = (bg: string, disabled: boolean): React.CSSProperties => ({
    fontSize: 12, fontWeight: 'bold', border: '1px solid #000',
    background: bg, color: '#fff', cursor: disabled ? 'default' : 'pointer', padding: '4px 12px',
    opacity: disabled ? 0.5 : 1,
  });

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{ width: 440, maxWidth: '92vw', background: '#fff', border: '1.5px solid #000', boxShadow: '4px 4px 0 #000', fontSize: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderBottom: '1px solid #000', background: '#b45309', color: '#fff' }}>
          <strong>⏸ Deployment rate-limited</strong>
          <button
            onClick={() => { if (!busy) onDismiss(); }}
            style={{ background: 'none', border: 'none', color: '#fff', cursor: busy ? 'default' : 'pointer', fontSize: 14, lineHeight: 1 }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: '12px 14px', lineHeight: 1.55 }}>
          <div>
            <b>{deployment.name}</b> (<code>{deployment.targetVersion}</code>) was held back: {detail || 'a device updated too recently.'}
          </div>
          <div style={{ color: '#666', marginTop: 8 }}>
            <b>Override</b> delivers the update now, ignoring the per-device rate limit.
            <b> Decline</b> aborts this deployment. You can change the window in Settings → OTA.
          </div>
          {err && <div style={{ color: '#b91c1c', marginTop: 8 }}>Could not complete: {err}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button onClick={() => { if (!busy) onDismiss(); }} disabled={!!busy} style={{ ...btn('#fff', !!busy), color: '#000' }}>
              Later
            </button>
            <button onClick={() => void run('decline', onDecline)} disabled={!!busy} style={btn('#ef4444', !!busy)}>
              {busy === 'decline' ? '…' : 'Decline'}
            </button>
            <button onClick={() => void run('override', onOverride)} disabled={!!busy} style={btn('#000', !!busy)}>
              {busy === 'override' ? '…' : 'Override'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
