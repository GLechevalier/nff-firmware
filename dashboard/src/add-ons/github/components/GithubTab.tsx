import { useEffect, useMemo, useState } from 'react';
import { BRAND_ACCENT } from '../../../lib/brand';
import { ConnectGithubModal } from './ConnectGithubModal';
import { useGithubInstallations } from '../hooks/useGithubInstallations';
import { dashboardGithubApi } from '../lib/githubApi';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import { CopyOverlay } from './CopyOverlay';
import { useGithubConnections } from '../hooks/useGithubConnections';
import { usePipelineRuns } from '../hooks/usePipelineRuns';
import { useDeviceGroups } from '../../observability/hooks/useDeviceGroups';
import { useOtaJobs } from '../../observability/hooks/useOtaJobs';
import { useDemoPullRequests } from '../../../hooks/useDemoPullRequests';
import { useDemoPipelineRuns } from '../hooks/useDemoPipelineRuns';
import { useDemoOtaRollout } from '../../observability/hooks/useDemoOtaRollout';
import { formatRelativeTime } from '../../../utils/time';
import { lineDiff } from '../../../utils/lineDiff';
import { Queryable } from '../../../components/squeletton/Queryable';
import type { OnQueryClick } from '../../../types/query';
import type { OtaStatus } from '../../observability/data/mockOtaJobs';
import type { GithubConnection, PipelineRun, PipelineStatus } from '../types/github';
import type { DemoPullRequest } from '../../../types/demoPr';

const STATUS_COLOR: Record<PipelineStatus, string> = {
  queued:      '#aaa',
  building:    '#1d4ed8',
  deploying:   '#d97706',
  succeeded:   '#22c55e',
  failed:      '#ef4444',
  rolled_back: '#f97316',
  paused:      '#b45309',
};

const STATUS_LABEL: Record<PipelineStatus, string> = {
  queued:      'queued',
  building:    'building',
  deploying:   'deploying',
  succeeded:   'succeeded',
  failed:      'failed',
  rolled_back: 'rolled back',
  paused:      'paused',
};

const TRIGGER_LABEL: Record<PipelineRun['trigger'], string> = {
  push:     'push',
  pr_merge: 'PR merge',
  manual:   'manual',
};

const DONE_STATUSES: OtaStatus[] = [
  'committed', 'success', 'already-installed', 'failure', 'rolled_back', 'aborted', 'timed_out', 'decommissioned',
];

const panelHeader: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid #000',
  fontSize: 12,
  fontWeight: 'bold',
  flexShrink: 0,
};

function StatusPill({ status }: { status: PipelineStatus }) {
  return (
    <span style={{
      fontSize: 9, padding: '1px 5px', letterSpacing: 0.3,
      background: STATUS_COLOR[status], color: '#fff', textTransform: 'uppercase', flexShrink: 0,
    }}>
      {STATUS_LABEL[status]}
    </span>
  );
}

// The bundled demo repo (and anything derived from it) is always marked, so nothing here is ever
// mistaken for a real GitHub object.
function DemoBadge({ title }: { title: string }) {
  return (
    <span
      title={title}
      style={{ fontSize: 8, fontWeight: 'bold', letterSpacing: 0.3, padding: '1px 4px', background: '#e5e5e5', color: '#999', flexShrink: 0 }}
    >
      DEMO
    </span>
  );
}

function ConnectionRow({ conn, groupName, selected, onClick, onDisconnect, queryMode, onQueryClick }: {
  conn: GithubConnection;
  groupName: string;
  selected: boolean;
  onClick: () => void;
  onDisconnect: (repoFullName: string, productionBranch: string) => Promise<void>;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function doDisconnect(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(true);
    setErr(null);
    try {
      await onDisconnect(conn.repoFullName, conn.productionBranch);
      // Realtime DELETE removes the row; nothing else to do on success.
    } catch (ex) {
      setErr((ex as Error).message);
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div
      onClick={onClick}
      style={{
        padding: '8px 10px',
        borderBottom: '1px solid #eee',
        cursor: 'pointer',
        background: selected ? '#f5f5f5' : 'transparent',
        borderLeft: selected ? '3px solid #000' : '3px solid transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Repository"
          value={conn.repoFullName}
          subject={conn.repoFullName}
          details={{ deployPolicy: conn.deployPolicy, productionBranch: conn.productionBranch }}
          style={{ fontWeight: 'bold', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {conn.repoFullName}
        </Queryable>
        <span
          title={queryMode ? undefined : `Click to switch to ${conn.deployPolicy === 'auto' ? 'manual' : 'auto'} deploys`}
          onClick={(e) => {
            if (queryMode) return; // Queryable owns clicks in query mode
            e.stopPropagation();
            // Realtime on github_connections repaints the badge once nff-github writes the row.
            void fetch('/api/github/set-deploy-policy', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                repo_full_name: conn.repoFullName,
                production_branch: conn.productionBranch,
                deploy_policy: conn.deployPolicy === 'auto' ? 'manual' : 'auto',
              }),
            });
          }}
          style={{ marginLeft: 'auto', cursor: queryMode ? undefined : 'pointer' }}
        >
          <Queryable
            queryMode={queryMode}
            onQueryClick={onQueryClick}
            field="Deploy Policy"
            value={conn.deployPolicy}
            subject={conn.repoFullName}
            style={{
              fontSize: 8, padding: '1px 4px', letterSpacing: 0.3,
              background: conn.deployPolicy === 'auto' ? '#000' : '#e5e5e5',
              color: conn.deployPolicy === 'auto' ? '#fff' : '#999',
            }}
          >
            {conn.deployPolicy.toUpperCase()}
          </Queryable>
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          <Queryable
            queryMode={queryMode}
            onQueryClick={onQueryClick}
            field="Production Branch"
            value={conn.productionBranch}
            subject={conn.repoFullName}
            details={{ deviceGroup: groupName }}
          >
            {conn.productionBranch}
          </Queryable> → {groupName}
        </span>
        {conn.virtual ? (
          <DemoBadge title="Bundled demo repo — connect your own repo to replace it" />
        ) : confirming ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <button
              onClick={doDisconnect}
              disabled={busy}
              title="Confirm disconnect"
              style={{ fontSize: 9, fontWeight: 'bold', border: '1px solid #ef4444', background: '#ef4444', color: '#fff', cursor: busy ? 'default' : 'pointer', padding: '1px 5px', opacity: busy ? 0.5 : 1 }}
            >
              {busy ? '…' : 'Sure?'}
            </button>
            <button
              onClick={e => { e.stopPropagation(); setConfirming(false); }}
              disabled={busy}
              title="Cancel"
              style={{ fontSize: 9, border: '1px solid #000', background: '#fff', color: '#000', cursor: busy ? 'default' : 'pointer', padding: '1px 5px' }}
            >
              No
            </button>
          </span>
        ) : (
          <button
            onClick={e => { e.stopPropagation(); setConfirming(true); }}
            title="Disconnect this repo (stops auto-deploys; pipeline history is kept)"
            style={{ fontSize: 9, border: '1px solid #ccc', background: '#fff', color: '#999', cursor: 'pointer', padding: '1px 5px', flexShrink: 0 }}
          >
            Disconnect
          </button>
        )}
      </div>
      {err && <div style={{ marginTop: 3, fontSize: 9, color: '#ef4444', wordBreak: 'break-word' }}>{err}</div>}
    </div>
  );
}

// Human-facing run title = the commit subject (first line), like Vercel. Falls back to
// the firmware version, then repo@sha, for runs pushed before commit messages were captured.
function runTitle(run: PipelineRun, repoName: string): string {
  const subject = run.commitMessage?.split('\n')[0].trim();
  return subject || run.firmwareVersion || `${repoName}@${run.commitSha.slice(0, 7)}`;
}

function RunRow({ run, repoName, rollout, selected, onSelect, onOpenDeployment, queryMode, onQueryClick }: {
  run: PipelineRun;
  repoName: string;
  rollout: { done: number; total: number } | null;
  selected: boolean;
  onSelect: () => void;
  onOpenDeployment: (deploymentId: string) => void;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}) {
  const title = runTitle(run, repoName);
  const runSubject = run.commitMessage ?? run.firmwareVersion ?? repoName ?? `Run ${run.id}`;
  return (
    <div
      onClick={onSelect}
      style={{
        padding: '6px 10px',
        borderBottom: '1px solid #eee',
        cursor: 'pointer',
        background: selected ? '#f5f5f5' : 'transparent',
        borderLeft: selected ? '3px solid #000' : '3px solid transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Status"
          value={STATUS_LABEL[run.status]}
          subject={runSubject}
          details={{ runId: run.id }}
          style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
        >
          <StatusPill status={run.status} />
        </Queryable>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Commit"
          value={run.commitMessage ?? title}
          subject={runSubject}
          details={{ runId: run.id, commitSha: run.commitSha }}
          style={{ fontSize: 12, fontWeight: 'bold', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {title}
        </Queryable>
        {run.deploymentId && (
          <button
            onClick={e => { e.stopPropagation(); onOpenDeployment(run.deploymentId!); }}
            title="Open this rollout in the OTA tab"
            style={{ fontSize: 10, border: 'none', background: 'none', color: '#1d4ed8', cursor: 'pointer', padding: 0, textDecoration: 'underline', flexShrink: 0 }}
          >
            → OTA
          </button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, fontSize: 10, color: '#888', paddingLeft: 1 }}>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Commit SHA"
          value={run.commitSha}
          subject={runSubject}
          details={{ runId: run.id }}
          style={{ display: 'inline-flex', alignItems: 'center' }}
        >
          <span title={run.commitSha}>{run.commitSha.slice(0, 7)}</span>
        </Queryable>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Trigger"
          value={TRIGGER_LABEL[run.trigger]}
          subject={runSubject}
          details={{ runId: run.id }}
          style={{ display: 'inline-flex', alignItems: 'center' }}
        >
          <span>{TRIGGER_LABEL[run.trigger]}</span>
        </Queryable>
        {run.prNumber != null && (
          <Queryable
            queryMode={queryMode}
            onQueryClick={onQueryClick}
            field="PR Number"
            value={String(run.prNumber)}
            subject={runSubject}
            details={{ runId: run.id }}
            style={{ display: 'inline-flex', alignItems: 'center' }}
          >
            <span>#{run.prNumber}</span>
          </Queryable>
        )}
        {rollout && rollout.total > 0 && (
          <span style={{ color: STATUS_COLOR[run.status] }}>rollout {rollout.done}/{rollout.total}</span>
        )}
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Updated"
          value={run.updatedAt.toLocaleString()}
          subject={runSubject}
          details={{ runId: run.id }}
          style={{ display: 'inline-flex', alignItems: 'center', marginLeft: 'auto', color: '#bbb' }}
        >
          <span>{formatRelativeTime(run.updatedAt)}</span>
        </Queryable>
      </div>
      {run.error && (
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Error"
          value={run.error}
          subject={runSubject}
          details={{ runId: run.id }}
          as="div"
          style={{ fontSize: 10, color: '#ef4444', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          <span title={run.error}>{run.error}</span>
        </Queryable>
      )}
    </div>
  );
}

function MetaRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 11, marginBottom: 3 }}>
      <span style={{ color: '#888', flexShrink: 0, width: 64 }}>{label}</span>
      <span title={title ?? value} style={{ color: '#222', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

const sectionTitle: React.CSSProperties = {
  fontSize: 10, fontWeight: 'bold', letterSpacing: 0.3,
  textTransform: 'uppercase', color: '#555', margin: '12px 0 4px',
};

const logPre: React.CSSProperties = {
  margin: 0, padding: 8, fontSize: 10, lineHeight: 1.45,
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: '1px solid #ddd', background: '#fafafa',
};

function RunDetail({ run, repoName, groupName, isDemo, onClose, onOpenDeployment, onRedeploy }: {
  run: PipelineRun;
  repoName: string;
  groupName: string;
  isDemo: boolean;
  onClose: () => void;
  onOpenDeployment: (deploymentId: string) => void;
  onRedeploy: () => Promise<void>;
}) {
  const title = runTitle(run, repoName);
  const [redeploying, setRedeploying] = useState(false);
  const [redeployMsg, setRedeployMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function doRedeploy() {
    setRedeploying(true);
    setRedeployMsg(null);
    try {
      await onRedeploy();
      setRedeployMsg({ ok: true, text: 'Rebuild queued — watch for a new run above.' });
    } catch (e) {
      setRedeployMsg({ ok: false, text: (e as Error).message });
    } finally {
      setRedeploying(false);
    }
  }
  return (
    <div style={{ width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #000', overflow: 'hidden' }}>
      <div style={{ ...panelHeader, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Run detail</span>
        <button
          onClick={onClose}
          title="Close"
          style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px', color: '#000' }}
        >
          ×
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <StatusPill status={run.status} />
          <span style={{ fontSize: 12, fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {title}
          </span>
          {/* The bundled demo repo has no GitHub App to rebuild against, so a demo deploy can't be
              redeployed — mark it DEMO instead of offering a button that would only error. */}
          {isDemo ? (
            <DemoBadge title="Derived from the self-heal demo — no GitHub repo to rebuild" />
          ) : (
            <button
              onClick={doRedeploy}
              disabled={redeploying}
              title="Rebuild this commit and roll it out again"
              style={{
                fontSize: 11, fontWeight: 'bold', flexShrink: 0,
                border: '1px solid #000', background: redeploying ? '#eee' : '#000',
                color: redeploying ? '#999' : '#fff', cursor: redeploying ? 'default' : 'pointer', padding: '2px 8px',
              }}
            >
              {redeploying ? '…' : '↻ Redeploy'}
            </button>
          )}
        </div>
        {redeployMsg && (
          <div style={{ fontSize: 10, color: redeployMsg.ok ? '#15803d' : '#ef4444', marginBottom: 8, wordBreak: 'break-word' }}>
            {redeployMsg.text}
          </div>
        )}

        <MetaRow label="Repo" value={repoName} />
        <MetaRow label="Commit" value={run.commitSha} />
        <MetaRow label="Trigger" value={TRIGGER_LABEL[run.trigger]} />
        {run.prNumber != null && <MetaRow label="PR" value={`#${run.prNumber}`} />}
        <MetaRow label="Group" value={groupName} />
        {run.firmwareVersion && <MetaRow label="Firmware" value={run.firmwareVersion} />}
        <MetaRow label="Started" value={run.createdAt.toLocaleString()} />
        <MetaRow label="Updated" value={run.updatedAt.toLocaleString()} />

        {run.deploymentId && (
          <button
            onClick={() => onOpenDeployment(run.deploymentId!)}
            style={{
              marginTop: 8, fontSize: 11, fontWeight: 'bold',
              border: '1px solid #000', background: '#fff', color: '#1d4ed8',
              cursor: 'pointer', padding: '3px 10px',
            }}
          >
            → Open rollout in OTA tab
          </button>
        )}

        {run.error && (
          <>
            <div style={sectionTitle}>Error</div>
            <CopyOverlay value={run.error} title="Copy error">
              <pre style={{ ...logPre, color: '#b91c1c', borderColor: '#f0c9c9', background: '#fff5f5' }}>{run.error}</pre>
            </CopyOverlay>
          </>
        )}

        {run.logs && (
          <>
            <div style={sectionTitle}>Build log</div>
            <CopyOverlay value={run.logs} title="Copy build log">
              <pre style={logPre}>{run.logs}</pre>
            </CopyOverlay>
          </>
        )}

        {!run.error && !run.logs && (
          <div style={{ marginTop: 12, fontSize: 11, color: '#aaa' }}>
            No error or build log recorded for this run.
          </div>
        )}
      </div>
    </div>
  );
}

// ── demo pull requests ──────────────────────────────────────────────────────────────
// The break-and-heal demo's fix, presented as a PR (see hooks/useDemoPullRequests). It is derived
// from the agent's real code stream, not from GitHub, so it is badged DEMO and carries no link —
// the diff is shown in-dashboard instead of pointing at a github.com URL that doesn't exist.

const PR_COLOR: Record<DemoPullRequest['status'], string> = { open: '#22c55e', merged: '#8250df' };

function PrPill({ status }: { status: DemoPullRequest['status'] }) {
  return (
    <span style={{
      fontSize: 9, padding: '1px 5px', letterSpacing: 0.3,
      background: PR_COLOR[status], color: '#fff', textTransform: 'uppercase', flexShrink: 0,
    }}>
      {status}
    </span>
  );
}

function PrRow({ pr, added, removed, selected, onSelect }: {
  pr: DemoPullRequest;
  added: number;
  removed: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      style={{
        padding: '6px 10px',
        borderBottom: '1px solid #eee',
        cursor: 'pointer',
        background: selected ? '#f5f5f5' : 'transparent',
        borderLeft: selected ? '3px solid #000' : '3px solid transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <PrPill status={pr.status} />
        <span style={{ fontSize: 10, color: '#888', flexShrink: 0 }}>#{pr.number}</span>
        <span style={{ fontSize: 12, fontWeight: 'bold', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {pr.title}
        </span>
        <span style={{ fontSize: 10, color: '#bbb', flexShrink: 0 }}>
          {formatRelativeTime(pr.openedAt)}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: '#888', paddingLeft: 1 }}>
        <span>{pr.headBranch} → {pr.baseBranch}</span>
        <DemoBadge title="Derived from the agent's real fix — this demo repo has no GitHub PR" />
        <span>
          <span style={{ color: '#22c55e' }}>+{added}</span>{' '}
          <span style={{ color: '#ef4444' }}>−{removed}</span>{' '}
          {pr.path}
        </span>
      </div>
    </div>
  );
}

const DIFF_BG: Record<string, string> = { add: '#e6ffed', del: '#ffeef0', ctx: 'transparent', hunk: '#f1f5f9' };
const DIFF_FG: Record<string, string> = { add: '#116329', del: '#82071e', ctx: '#444', hunk: '#94a3b8' };
const DIFF_SIGN: Record<string, string> = { add: '+', del: '−', ctx: ' ', hunk: '' };

function DemoPrDetail({ pr, onClose }: { pr: DemoPullRequest; onClose: () => void }) {
  const diff = lineDiff(pr.base, pr.head);
  return (
    <div style={{ width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid #000', overflow: 'hidden' }}>
      <div style={{ ...panelHeader, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Pull request detail</span>
        <button
          onClick={onClose}
          title="Close"
          style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px', color: '#000' }}
        >
          ×
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <PrPill status={pr.status} />
          <span style={{ fontSize: 12, fontWeight: 'bold', flex: 1 }}>
            #{pr.number} {pr.title}
          </span>
        </div>

        <MetaRow label="Repo" value={pr.repoFullName} />
        <MetaRow label="Branch" value={`${pr.headBranch} → ${pr.baseBranch}`} />
        <MetaRow label="File" value={pr.path} />
        <MetaRow label="Opened" value={pr.openedAt.toLocaleString()} />

        <div style={sectionTitle}>Diff</div>
        <pre style={{ ...logPre, padding: 0 }}>
          {diff.lines.map((l, i) => (
            <div key={i} style={{ background: DIFF_BG[l.kind], color: DIFF_FG[l.kind], padding: '0 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {DIFF_SIGN[l.kind]}{l.kind === 'hunk' ? ' ⋯' : l.text}
            </div>
          ))}
        </pre>

        <div style={{ marginTop: 12, fontSize: 10, color: '#aaa', lineHeight: 1.5 }}>
          This is the bundled demo repo, so there is no GitHub pull request to open — the agent's fix
          was compiled and rolled out to your device over OTA. Connect your own repo to have nff open
          real PRs.
        </div>
      </div>
    </div>
  );
}

export function GithubTab({ onOpenDeployment, openConnect, onConnectHandled, queryMode, onQueryClick }: {
  onOpenDeployment: (deploymentId: string) => void;
  openConnect?: boolean;
  onConnectHandled?: () => void;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}) {
  const { currentProjectId } = useCurrentProject();
  const { connections } = useGithubConnections();
  const { installations } = useGithubInstallations(currentProjectId);
  const { runs, requestRedeploy } = usePipelineRuns();
  const { groups }      = useDeviceGroups();
  const { jobs }        = useOtaJobs();
  const demoPrs         = useDemoPullRequests();
  const demoRuns        = useDemoPipelineRuns();
  const demoRollout     = useDemoOtaRollout();
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null); // connection id, null = all
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedPrRun, setSelectedPrRun] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  // Landing back from the GitHub App Setup URL with a failure (api/github?action=installed).
  const [githubError, setGithubError] = useState<string | null>(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get('github_error');
  });
  const installed = installations.length > 0;

  // "Connect GitHub": install the nff GitHub App on the user's account/org. The server signs the
  // install URL's state with the project id; GitHub bounces back through /api/github/installed.
  async function connectGithub() {
    if (!currentProjectId || connectBusy) return;
    setConnectBusy(true);
    setGithubError(null);
    try {
      const r = await dashboardGithubApi.get<{ url: string }>(`/install-url?project_id=${encodeURIComponent(currentProjectId)}`);
      window.location.assign(r.url);
    } catch (e) {
      setGithubError((e as Error).message);
      setConnectBusy(false);
    }
  }
  const onConnectClick = installed ? () => setShowConnect(true) : () => void connectGithub();
  const connectLabel = installed ? '+ Connect' : connectBusy ? 'Opening GitHub…' : 'Connect GitHub';

  // Open the modal when navigated here from the Overview tab's "Connect →" button.
  useEffect(() => {
    if (openConnect) {
      setShowConnect(true);
      onConnectHandled?.();
    }
  }, [openConnect, onConnectHandled]);

  // A repo may connect several branches, each to its own device group. Name the branch so
  // unlinking one target doesn't take the repo's other targets down with it.
  async function disconnectRepo(repoFullName: string, productionBranch: string) {
    const resp = await fetch('/api/github/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_full_name: repoFullName, production_branch: productionBranch }),
    });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok || !result.ok) {
      throw new Error(result.error ?? `disconnect failed (${resp.status})`);
    }
    // The Realtime DELETE event in useGithubConnections drops the row from the list.
    setSelectedRepo(curr => {
      const sel = curr && connections.find(c => c.id === curr);
      const gone = sel && sel.repoFullName === repoFullName && sel.productionBranch === productionBranch;
      return gone ? null : curr;
    });
  }

  // Re-run a deploy: queue a fresh build+rollout of the run's exact commit. This is a
  // plain Supabase row write (requestRedeploy inserts a queued pipeline_runs row);
  // nff-github's build worker picks it up. The new run streams into the list above.
  async function redeployRun(run: PipelineRun) {
    await requestRedeploy(run);
  }

  const groupNameById = new Map(groups.map(g => [g.id, g.name]));
  const repoNameById  = new Map(connections.map(c => [c.id, c.repoFullName]));

  // done/total per deployment from the live ota_jobs subscription (a count, not the
  // per-device grid — that lives in the OTA tab, one click away). The demo's derived heal/break
  // jobs are folded in too, so a demo deploy row shows the same rollout count the OTA tab does.
  const rolloutByDeployment = new Map<string, { done: number; total: number }>();
  for (const job of [...demoRollout.jobs, ...jobs]) {
    if (!job.deploymentId) continue;
    const agg = rolloutByDeployment.get(job.deploymentId) ?? { done: 0, total: 0 };
    agg.total += 1;
    if (DONE_STATUSES.includes(job.status)) agg.done += 1;
    rolloutByDeployment.set(job.deploymentId, agg);
  }

  // The demo's break/heal deploys are derived, not pipeline_runs rows; merge them in and sort
  // newest-first, the order usePipelineRuns already returns. They carry the virtual connection's
  // id, so the selectedRepo filter below scopes them exactly like the real runs.
  const allRuns = useMemo(
    () => [...demoRuns, ...runs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    [demoRuns, runs],
  );

  const visibleRuns = selectedRepo ? allRuns.filter(r => r.connectionId === selectedRepo) : allRuns;
  const selectedRun = selectedRunId ? allRuns.find(r => r.id === selectedRunId) ?? null : null;

  // Demo PRs belong to the virtual demo connection; hide them when a specific real repo is filtered.
  const demoConnId = connections.find(c => c.virtual)?.id ?? null;
  const visiblePrs = !selectedRepo || selectedRepo === demoConnId ? demoPrs : [];
  const selectedPr = selectedPrRun ? demoPrs.find(p => p.runId === selectedPrRun) ?? null : null;

  // One detail panel at a time — picking a PR closes an open run detail and vice versa.
  function selectPr(runId: string) {
    setSelectedRunId(null);
    setSelectedPrRun(id => (id === runId ? null : runId));
  }
  function selectRun(id: string) {
    setSelectedPrRun(null);
    setSelectedRunId(curr => (curr === id ? null : id));
  }

  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>

      {/* Left: connected repositories */}
      <div style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #000', overflow: 'hidden' }}>
        <div style={{ ...panelHeader, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <span>Repositories</span>
          <button
            data-tour="github-connect"
            onClick={onConnectClick}
            title={installed ? 'Connect a GitHub repo' : 'Install the nff GitHub App on your account or organization'}
            style={{ fontSize: 11, fontWeight: 'bold', border: '1px solid #000', background: BRAND_ACCENT, color: '#fff', cursor: 'pointer', padding: '1px 8px', whiteSpace: 'nowrap' }}
          >
            {connectLabel}
          </button>
        </div>
        {installed && (
          <div style={{ padding: '4px 10px', borderBottom: '1px solid #eee', fontSize: 10, color: '#555', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#22c55e' }}>●</span>
            {installations.map(i => `@${i.accountLogin}`).join(', ')}
            <button
              onClick={() => void connectGithub()}
              title="Add another GitHub account or organization"
              style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', fontSize: 10, color: '#1d4ed8', padding: 0 }}
            >
              + account
            </button>
          </div>
        )}
        {githubError && (
          <div style={{ padding: '4px 10px', borderBottom: '1px solid #eee', fontSize: 10, color: '#ef4444', wordBreak: 'break-word' }}>
            GitHub: {githubError}
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div
            onClick={() => setSelectedRepo(null)}
            style={{
              padding: '6px 10px', borderBottom: '1px solid #eee', cursor: 'pointer',
              fontSize: 11, color: '#555',
              background: selectedRepo === null ? '#f5f5f5' : 'transparent',
              borderLeft: selectedRepo === null ? '3px solid #000' : '3px solid transparent',
            }}
          >
            All deploys
          </div>
          {connections.length === 0 && (
            <div style={{ padding: 10, fontSize: 11, color: '#aaa' }}>
              {installed ? 'No connected repos yet.' : 'Connect your GitHub account to pick a repo.'}
              <button
                onClick={onConnectClick}
                style={{ display: 'block', marginTop: 6, fontSize: 11, fontWeight: 'bold', border: '1px solid #000', background: '#fff', color: '#000', cursor: 'pointer', padding: '2px 8px' }}
              >
                {installed ? '+ Connect a repo' : connectLabel}
              </button>
            </div>
          )}
          {connections.map(conn => (
            <ConnectionRow
              key={conn.id}
              conn={conn}
              groupName={conn.deviceGroupId ? (groupNameById.get(conn.deviceGroupId) ?? conn.deviceGroupId.slice(0, 8)) : 'code only'}
              selected={selectedRepo === conn.id}
              onClick={() => setSelectedRepo(conn.id)}
              onDisconnect={disconnectRepo}
              queryMode={queryMode}
              onQueryClick={onQueryClick}
            />
          ))}
        </div>
      </div>

      {/* Main: demo pull requests (when the bundled repo is present), then pipeline runs (deploys) */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {visiblePrs.length > 0 && (
          <div style={{ flexShrink: 0, maxHeight: '45%', display: 'flex', flexDirection: 'column', borderBottom: '1px solid #000' }}>
            <div style={panelHeader}>Pull requests</div>
            <div style={{ overflowY: 'auto' }}>
              {/* Newest PR at the top, oldest at the bottom — numbers stay stable (assigned
                  chronologically in useDemoPullRequests), so reverse a copy for display only. */}
              {[...visiblePrs].reverse().map(pr => {
                const { added, removed } = lineDiff(pr.base, pr.head);
                return (
                  <PrRow
                    key={pr.runId}
                    pr={pr}
                    added={added}
                    removed={removed}
                    selected={selectedPrRun === pr.runId}
                    onSelect={() => selectPr(pr.runId)}
                  />
                );
              })}
            </div>
          </div>
        )}
        <div style={panelHeader}>Deploys</div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {visibleRuns.length === 0 && (
            <div style={{ padding: 10, fontSize: 11, color: '#aaa' }}>No deploys yet — push to a connected repo.</div>
          )}
          {visibleRuns.map(run => (
            <RunRow
              key={run.id}
              run={run}
              repoName={repoNameById.get(run.connectionId) ?? 'repo'}
              rollout={run.deploymentId ? rolloutByDeployment.get(run.deploymentId) ?? null : null}
              selected={selectedRunId === run.id}
              onSelect={() => selectRun(run.id)}
              onOpenDeployment={onOpenDeployment}
              queryMode={queryMode}
              onQueryClick={onQueryClick}
            />
          ))}
        </div>
      </div>

      {/* Right: selected demo PR — the agent's fix, as a diff */}
      {selectedPr && <DemoPrDetail pr={selectedPr} onClose={() => setSelectedPrRun(null)} />}

      {/* Right: selected run detail — full error + build log */}
      {selectedRun && (
        <RunDetail
          run={selectedRun}
          repoName={repoNameById.get(selectedRun.connectionId) ?? 'repo'}
          isDemo={selectedRun.connectionId === demoConnId}
          groupName={(() => {
            const conn = connections.find(c => c.id === selectedRun.connectionId);
            return conn?.deviceGroupId ? (groupNameById.get(conn.deviceGroupId) ?? conn.deviceGroupId.slice(0, 8)) : '—';
          })()}
          onClose={() => setSelectedRunId(null)}
          onOpenDeployment={onOpenDeployment}
          onRedeploy={() => redeployRun(selectedRun)}
        />
      )}

      {showConnect && <ConnectGithubModal projectId={currentProjectId} api={dashboardGithubApi} deviceGroups={groups} onClose={() => setShowConnect(false)} />}
    </div>
  );
}
