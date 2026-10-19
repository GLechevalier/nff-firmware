import type React from 'react';
import { useState } from 'react';
import { BRAND_ACCENT } from '../../lib/brand';
import { useCurrentProject } from '../../context/CurrentProjectContext';
import { supabase } from '../../lib/supabase';
import { CopyButton } from './CopyButton';
import { ProjectSwitcher } from './ProjectSwitcher';
import { BrainConnect } from './BrainConnect';

const panelHeader: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid #000',
  fontSize: 12,
  fontWeight: 'bold',
  flexShrink: 0,
};

const card: React.CSSProperties = {
  border: '1px solid #000',
  background: '#fff',
  boxShadow: '2px 2px 0 #ddd',
  marginBottom: 12,
};

function Row({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: 12 }}>
      <span style={{ color: '#666', width: 110, flexShrink: 0 }}>{label}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
      {copy && <CopyButton value={value} title={`Copy ${label.toLowerCase()}`} />}
    </div>
  );
}

export function SettingsTab() {
  const { currentProject, reload } = useCurrentProject();
  const created = currentProject.created_at ? new Date(currentProject.created_at).toLocaleString() : '—';

  // "Allow nff to merge PRs": owner/admin-only (RLS rejects a member's write). Optimistic
  // local mirror so the checkbox responds instantly; reload() re-syncs from the source of truth.
  const [autoMerge, setAutoMerge] = useState(currentProject.pr_auto_merge);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canEdit = currentProject.role === 'owner' || currentProject.role === 'admin';

  // OTA rate-limit window (seconds). Empty input = null = nff-ota's global default (1h). 0 = off.
  const [rateLimit, setRateLimit] = useState<string>(
    currentProject.ota_rate_limit_seconds != null ? String(currentProject.ota_rate_limit_seconds) : '',
  );

  // Code-tab git graph branch source: 'agent' (default) vs. 'all' GitHub branches.
  const [branchSource, setBranchSource] = useState<'agent' | 'all'>(currentProject.git_graph_branch_source);

  async function saveBranchSource(next: 'agent' | 'all') {
    setBranchSource(next);
    setSaving(true);
    setError(null);
    const { error: err } = await supabase
      .from('projects')
      .update({ git_graph_branch_source: next })
      .eq('id', currentProject.id);
    setSaving(false);
    if (err) {
      setBranchSource(currentProject.git_graph_branch_source); // revert on failure
      setError(err.message);
      return;
    }
    await reload();
  }

  async function toggleAutoMerge(next: boolean) {
    setAutoMerge(next);
    setSaving(true);
    setError(null);
    const { error: err } = await supabase
      .from('projects')
      .update({ pr_auto_merge: next })
      .eq('id', currentProject.id);
    setSaving(false);
    if (err) {
      setAutoMerge(!next); // revert on failure
      setError(err.message);
      return;
    }
    await reload();
  }

  async function saveRateLimit() {
    const trimmed = rateLimit.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next != null && (!Number.isFinite(next) || next < 0)) {
      setError('OTA rate limit must be a non-negative number of seconds (or blank for the default).');
      return;
    }
    setSaving(true);
    setError(null);
    const { error: err } = await supabase
      .from('projects')
      .update({ ota_rate_limit_seconds: next })
      .eq('id', currentProject.id);
    setSaving(false);
    if (err) {
      setError(err.message);
      return;
    }
    await reload();
  }

  return (
    <div style={{ flex: 1, minWidth: 0, height: '100%', overflowY: 'auto' }}>
      <div style={panelHeader}>Settings</div>

      <div style={{ padding: 12, maxWidth: 720, margin: '0 auto' }}>
        {/* Per-user brain sync (migration 0141). No role gate and no server:
            the mint/revoke RPCs act on auth.uid() and are granted to
            `authenticated`, so the browser calls them directly. */}
        <BrainConnect />

        {/* Connectors + Store live in the brain's side panel (StorePanel.tsx, via the hub / Store nodes). */}

        {/* Project identity */}
        <div style={card}>
          <div style={panelHeader}>Project</div>
          <div>
            {/* The workspace picker (moved out of the nav rail). Switching remounts the dashboard. */}
            <div data-tour="project-switcher" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: 12 }}>
              <span style={{ color: '#666', width: 110, flexShrink: 0 }}>Workspace</span>
              <div style={{ flex: 1, minWidth: 0, marginTop: -4 }}><ProjectSwitcher /></div>
            </div>
            <Row label="Name" value={currentProject.name} />
            <Row label="Project ID" value={currentProject.id} copy />
            <Row label="Plan" value={currentProject.plan} />
            <Row label="Role" value={currentProject.role} />
            <Row label="Demo" value={currentProject.is_demo ? 'yes' : 'no'} />
            <Row label="Created" value={created} />
          </div>
        </div>

        {/* GitHub */}
        <div style={card}>
          <div style={panelHeader}>GitHub</div>
          <div style={{ padding: '10px', fontSize: 12, lineHeight: 1.5 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: canEdit ? 'pointer' : 'default' }}>
              <input
                type="checkbox"
                checked={autoMerge}
                disabled={!canEdit || saving}
                onChange={e => void toggleAutoMerge(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>
                <b>Allow nff to merge PRs (all repos)</b>
                <br />
                <span style={{ color: '#666' }}>
                  Lets nff merge its own pull requests (<code>nff-fix/*</code>, <code>nff-feature/*</code>)
                  across every repo connected to this project — both on request (the <code>merge_pr</code>
                  {' '}tool) and automatically once a PR's checks pass. Off by default.
                </span>
              </span>
            </label>
            {!canEdit && (
              <div style={{ color: '#666', marginTop: 6 }}>Only an owner or admin can change this.</div>
            )}
            {error && <div style={{ color: '#c00', marginTop: 6 }}>Could not save: {error}</div>}
          </div>
        </div>

        {/* Git graph */}
        <div style={card}>
          <div style={panelHeader}>Git graph</div>
          <div style={{ padding: '10px', fontSize: 12, lineHeight: 1.5 }}>
            <div style={{ fontWeight: 'bold', marginBottom: 4 }}>Branches shown in the Code tab</div>
            <div style={{ color: '#666', marginBottom: 8 }}>
              Choose what the Code-tab git graph lists. <b>Agent branches only</b> shows just nff's
              own <code>nff-feature/*</code> / <code>nff-fix/*</code> branches (no GitHub call).
              {' '}<b>All GitHub branches</b> also lists the repo's real branches; the agent's own
              branches stay highlighted in their colour.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select
                value={branchSource}
                disabled={!canEdit || saving}
                onChange={e => void saveBranchSource(e.target.value as 'agent' | 'all')}
                style={{ fontSize: 12, padding: '3px 6px' }}
              >
                <option value="agent">Agent branches only (default)</option>
                <option value="all">All GitHub branches</option>
              </select>
            </div>
            {!canEdit && (
              <div style={{ color: '#666', marginTop: 6 }}>Only an owner or admin can change this.</div>
            )}
          </div>
        </div>

        {/* OTA */}
        <div style={card}>
          <div style={panelHeader}>OTA</div>
          <div style={{ padding: '10px', fontSize: 12, lineHeight: 1.5 }}>
            <div style={{ fontWeight: 'bold', marginBottom: 4 }}>Per-device rate limit</div>
            <div style={{ color: '#666', marginBottom: 8 }}>
              Minimum gap between OTAs to the same device (seconds). A new release inside this
              window is held back — the deployment pauses and asks you to override or decline.
              Leave blank for the default (3600s = 1h); set <code>0</code> to disable.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number"
                min={0}
                value={rateLimit}
                placeholder="3600 (default)"
                disabled={!canEdit || saving}
                onChange={e => setRateLimit(e.target.value)}
                style={{ fontSize: 12, padding: '3px 6px', width: 160 }}
              />
              <span style={{ color: '#666' }}>seconds</span>
              {canEdit && (
                <button
                  onClick={() => void saveRateLimit()}
                  disabled={saving}
                  style={{ fontSize: 12, fontWeight: 'bold', border: '1px solid #000', background: BRAND_ACCENT, color: '#fff', cursor: saving ? 'default' : 'pointer', padding: '3px 12px', opacity: saving ? 0.5 : 1 }}
                >
                  Save
                </button>
              )}
            </div>
            {!canEdit && (
              <div style={{ color: '#666', marginTop: 6 }}>Only an owner or admin can change this.</div>
            )}
          </div>
        </div>

        {/* Secrets */}
        <div style={card}>
          <div style={panelHeader}>Secrets</div>
          <div style={{ padding: '8px 10px', fontSize: 12, color: '#666', lineHeight: 1.5 }}>
            No project secrets are stored yet. The <b>Project ID</b> above is what the
            CLI and provisioning need (e.g. <code>nff provision batch --project &lt;id&gt;</code>).
            <br />
            Device command-signing keys and the project certificate authority live on the
            fleet and are never exposed to the browser.
          </div>
        </div>
      </div>
    </div>
  );
}
