import { useEffect, useState } from 'react';
import { BRAND_ACCENT } from '../../../lib/brand';
import type { DeviceGroup } from '../../observability/types/ota';
import type { DeployPolicy } from '../types/github';
import type { GithubApi } from '../lib/githubApi';

// "Connect a GitHub repo" form. Lists the repos the project's GitHub App installation can see
// (GET <api>/installation-repos) as a picker, with a typed owner/repo fallback, and POSTs to
// <api>/connect, which forwards to nff-github's /internal/connect-repo (the GitHub App key lives
// there). On success the new github_connections row arrives via Realtime, so we just close.
//
// Host-agnostic: `api` is the host's github router (dashboard /api/github, admin /api/git) and
// `deviceGroups` is optional — omitted (nff-admin's platform repos) the connection is code-only.

const labelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 'bold', color: '#666', textTransform: 'uppercase',
  letterSpacing: 0.5, marginBottom: 3, display: 'block',
};
const inputStyle: React.CSSProperties = {
  width: '100%', fontSize: 12, padding: '3px 6px',
  border: '1px solid #000', boxSizing: 'border-box',
};
const fieldStyle: React.CSSProperties = { marginBottom: 10 };

const TYPED = '__typed__';

interface InstallationRepo { full_name: string; default_branch: string; private: boolean; installation_id: number }

export function ConnectGithubModal({ projectId, api, deviceGroups, onClose }: {
  projectId: string | null;
  api: GithubApi;
  deviceGroups?: DeviceGroup[];
  onClose: () => void;
}) {
  const [repos, setRepos] = useState<InstallationRepo[] | null>(null); // null = loading
  const [picked, setPicked] = useState<string>(TYPED);
  const [repoFullName, setRepoFullName] = useState('');
  const [deviceGroupId, setDeviceGroupId] = useState('');
  const [deviceTypes, setDeviceTypes] = useState('esp32');
  const [productionBranch, setProductionBranch] = useState('main');
  const [deployPolicy, setDeployPolicy] = useState<DeployPolicy>('auto');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [fqbn, setFqbn] = useState('esp32:esp32:esp32');
  const [sketchPath, setSketchPath] = useState('.');
  const [maxInFlight, setMaxInFlight] = useState(10);
  const [retries, setRetries] = useState(3);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Repos visible to the project's installation(s). Any failure just leaves the typed fallback.
  useEffect(() => {
    let cancelled = false;
    if (!projectId) { setRepos([]); return; }
    api.get<{ repos?: InstallationRepo[] }>(`/installation-repos?project_id=${encodeURIComponent(projectId)}`)
      .then(r => { if (!cancelled) { const list = r.repos ?? []; setRepos(list); if (list.length > 0) pickRepo(list[0]); } })
      .catch(() => { if (!cancelled) setRepos([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function pickRepo(r: InstallationRepo) {
    setPicked(r.full_name);
    setRepoFullName(r.full_name);
    setProductionBranch(r.default_branch || 'main');
  }

  const withGroups = deviceGroups !== undefined;
  const parsedTypes = deviceTypes.split(',').map(s => s.trim()).filter(Boolean);
  const hasTarget = withGroups && deviceGroupId !== '';
  const canSubmit = repoFullName.trim() !== '' && (!hasTarget || parsedTypes.length > 0) && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    const pickedRepo = repos?.find(r => r.full_name === picked);
    try {
      await api.post('/connect', {
        repo_full_name: repoFullName.trim(),
        device_group_id: hasTarget ? deviceGroupId : null,
        installation_id: pickedRepo?.installation_id,
        project_id: projectId,
        device_types: hasTarget ? parsedTypes : [],
        production_branch: productionBranch.trim() || 'main',
        deploy_policy: hasTarget ? deployPolicy : 'manual',
        fqbn: fqbn.trim(),
        sketch_path: sketchPath.trim() || '.',
        max_devices_in_flight: maxInFlight,
        retries,
      });
      onClose(); // Realtime surfaces the new connection
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 420, maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto',
          background: '#fff', border: '1.5px solid #000', boxShadow: '4px 4px 0 #000',
          display: 'flex', flexDirection: 'column', fontSize: 12,
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderBottom: '1px solid #000', background: BRAND_ACCENT, color: '#fff' }}>
          <strong style={{ letterSpacing: 0.3 }}>⑂ Connect GitHub repo</strong>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}>×</button>
        </div>

        <div style={{ padding: '12px 14px' }}>
          <div style={fieldStyle}>
            <label style={labelStyle}>Repository</label>
            {repos === null && <div style={{ fontSize: 10, color: '#999', marginBottom: 4 }}>Loading repositories…</div>}
            {repos && repos.length > 0 && (
              <select
                value={picked}
                onChange={e => {
                  const r = repos.find(x => x.full_name === e.target.value);
                  if (r) pickRepo(r); else { setPicked(TYPED); setRepoFullName(''); }
                }}
                disabled={busy}
                style={{ ...inputStyle, marginBottom: 4 }}
              >
                {repos.map(r => (
                  <option key={r.full_name} value={r.full_name}>{r.full_name}{r.private ? ' (private)' : ''}</option>
                ))}
                <option value={TYPED}>Type owner/repo…</option>
              </select>
            )}
            {(picked === TYPED || (repos && repos.length === 0)) && (
              <input
                value={repoFullName}
                onChange={e => setRepoFullName(e.target.value)}
                placeholder="owner/repo"
                disabled={busy}
                autoFocus
                style={inputStyle}
              />
            )}
            {repos && repos.length === 0 && (
              <div style={{ marginTop: 4, fontSize: 10, color: '#999' }}>
                No repositories from the GitHub App yet — install it (Connect GitHub) to pick from a list, or type the repo.
              </div>
            )}
          </div>

          {withGroups && (
            <div style={fieldStyle}>
              <label style={labelStyle}>Device group</label>
              <select
                value={deviceGroupId}
                onChange={e => setDeviceGroupId(e.target.value)}
                disabled={busy}
                style={inputStyle}
              >
                <option value="">— none (code only, never deploys) —</option>
                {deviceGroups.map(g => (
                  <option key={g.id} value={g.id}>{g.name} ({g.memberCount})</option>
                ))}
              </select>
              {deviceGroups.length === 0 && (
                <div style={{ marginTop: 4, fontSize: 10, color: '#999' }}>
                  No device groups yet — create one in the Groups tab to deploy from this repo.
                </div>
              )}
            </div>
          )}

          {hasTarget && (
            <div style={fieldStyle}>
              <label style={labelStyle}>Device types</label>
              <input
                value={deviceTypes}
                onChange={e => setDeviceTypes(e.target.value)}
                placeholder="esp32"
                disabled={busy}
                style={inputStyle}
              />
              <div style={{ marginTop: 3, fontSize: 10, color: '#999' }}>Comma-separated, e.g. esp32, esp32s3</div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ ...fieldStyle, flex: 1 }}>
              <label style={labelStyle}>Production branch</label>
              <input
                value={productionBranch}
                onChange={e => setProductionBranch(e.target.value)}
                placeholder="main"
                disabled={busy}
                style={inputStyle}
              />
            </div>
            {hasTarget && (
              <div style={{ ...fieldStyle, flex: 1 }}>
                <label style={labelStyle}>Deploy policy</label>
                <select
                  value={deployPolicy}
                  onChange={e => setDeployPolicy(e.target.value as DeployPolicy)}
                  disabled={busy}
                  style={inputStyle}
                >
                  <option value="auto">auto (push → rollout)</option>
                  <option value="manual">manual</option>
                </select>
              </div>
            )}
          </div>

          {/* Advanced */}
          {hasTarget && (
            <button
              onClick={() => setShowAdvanced(s => !s)}
              style={{ marginTop: 2, marginBottom: showAdvanced ? 10 : 0, border: 'none', background: 'none', cursor: 'pointer', fontSize: 11, color: '#1d4ed8', padding: 0 }}
            >
              {showAdvanced ? '▾ Advanced' : '▸ Advanced'}
            </button>
          )}

          {hasTarget && showAdvanced && (
            <>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ ...fieldStyle, flex: 1 }}>
                  <label style={labelStyle}>FQBN</label>
                  <input value={fqbn} onChange={e => setFqbn(e.target.value)} disabled={busy} style={inputStyle} />
                </div>
                <div style={{ ...fieldStyle, flex: 1 }}>
                  <label style={labelStyle}>Sketch path</label>
                  <input value={sketchPath} onChange={e => setSketchPath(e.target.value)} disabled={busy} style={inputStyle} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ ...fieldStyle, flex: 1 }}>
                  <label style={labelStyle}>Max devices in flight</label>
                  <input
                    type="number" min={1} value={maxInFlight}
                    onChange={e => setMaxInFlight(Math.max(1, Number(e.target.value) || 1))}
                    disabled={busy} style={inputStyle}
                  />
                </div>
                <div style={{ ...fieldStyle, flex: 1 }}>
                  <label style={labelStyle}>Retries</label>
                  <input
                    type="number" min={0} value={retries}
                    onChange={e => setRetries(Math.max(0, Number(e.target.value) || 0))}
                    disabled={busy} style={inputStyle}
                  />
                </div>
              </div>
            </>
          )}

          {err && <div style={{ marginTop: 4, marginBottom: 8, fontSize: 11, color: '#ef4444', wordBreak: 'break-word' }}>{err}</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
            <button
              onClick={onClose}
              disabled={busy}
              style={{ fontSize: 12, border: '1px solid #000', background: '#fff', cursor: busy ? 'default' : 'pointer', padding: '3px 12px' }}
            >
              Cancel
            </button>
            <button
              onClick={() => void submit()}
              disabled={!canSubmit}
              style={{ fontSize: 12, fontWeight: 'bold', border: '1px solid #000', background: BRAND_ACCENT, color: '#fff', cursor: canSubmit ? 'pointer' : 'default', padding: '3px 14px', opacity: canSubmit ? 1 : 0.5 }}
            >
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
