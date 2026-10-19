import type React from 'react';
import { useGitGraph, type GraphBranch, type GraphCommit } from '../../hooks/useGitGraph';

// The Code-tab "Git" view: a live graph of one repo's git activity. The top shows the agent's
// ACTIVE branches (nff-feature/* from builder features, nff-fix/* repair PRs) as they're cut,
// written, and PR'd; below is the production branch's commit spine coloured by deploy status.
// Everything updates in real time off the same Realtime hooks the rest of the tab uses
// (useGitGraph composes pipeline_runs + builder_features + agent_code_streams).

const panelHeader: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid #000',
  fontSize: 12,
  fontWeight: 'bold',
  flexShrink: 0,
};

// Stage → label/colour for a branch (feature lifecycle ∪ code-stream status).
const STAGE: Record<string, { label: string; color: string }> = {
  branch_created: { label: 'branch', color: '#6b7280' },
  validating: { label: 'validating', color: '#b45309' },
  validated: { label: 'validated', color: '#0891b2' },
  pr_opened: { label: 'PR open', color: '#7c3aed' },
  merged: { label: 'merged', color: '#15803d' },
  streaming: { label: 'writing…', color: '#b45309' },
  done: { label: 'done', color: '#15803d' },
  error: { label: 'error', color: '#b91c1c' },
};

// The agent's own branches (feature/fix) are drawn in this accent so they stand out from the
// repo's plain GitHub branches when a project opts into showing all branches.
const AGENT_BRANCH_COLOR = '#7c3aed';

// Deploy status → colour for a production commit dot/pill.
const COMMIT_COLOR: Record<string, string> = {
  queued: '#6b7280',
  building: '#b45309',
  deploying: '#b45309',
  succeeded: '#15803d',
  failed: '#b91c1c',
  rolled_back: '#c2410c',
  paused: '#d97706',
};

function Pill({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ fontSize: 9, fontWeight: 'bold', color: '#fff', background: color, padding: '1px 5px', borderRadius: 2, whiteSpace: 'nowrap' }}>
      {text}
    </span>
  );
}

function BranchCard({ b }: { b: GraphBranch }) {
  const stage = STAGE[b.stage] ?? { label: String(b.stage), color: '#6b7280' };
  const isAgent = b.kind === 'feature' || b.kind === 'agent';
  const stripe = isAgent ? AGENT_BRANCH_COLOR : '#9ca3af';
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', border: '1px solid #000', background: '#fff', boxShadow: '2px 2px 0 #eee', minWidth: 0 }}>
      <div style={{ width: 4, background: stripe, flexShrink: 0 }} />
      <div style={{ padding: '5px 8px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ opacity: 0.5, flexShrink: 0, color: isAgent ? AGENT_BRANCH_COLOR : undefined }}>⑂</span>
          <span style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.label}>{b.label}</span>
          {b.live && <span style={{ fontSize: 9, fontWeight: 'bold', color: '#b45309', flexShrink: 0 }}>▶ live</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Pill text={isAgent ? stage.label : 'branch'} color={isAgent ? AGENT_BRANCH_COLOR : '#9ca3af'} />
          {isAgent && <span style={{ fontSize: 9, color: AGENT_BRANCH_COLOR, fontWeight: 'bold' }}>agent</span>}
          {b.prUrl && (
            <a href={b.prUrl} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: '#1d4ed8', fontWeight: 'bold' }}>
              PR #{b.prNumber} ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function CommitRow({ c, last }: { c: GraphCommit; last: boolean }) {
  const color = COMMIT_COLOR[c.status] ?? '#6b7280';
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, minWidth: 0 }}>
      {/* Spine: a dot on a vertical line. */}
      <div style={{ position: 'relative', width: 16, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
        {!last && <div style={{ position: 'absolute', top: 12, bottom: -4, width: 2, background: '#000' }} />}
        <div style={{ width: 11, height: 11, borderRadius: '50%', background: color, border: '2px solid #000', marginTop: 5, zIndex: 1 }} />
      </div>
      {/* Commit detail. */}
      <div style={{ flex: 1, minWidth: 0, padding: '4px 0 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <code style={{ fontSize: 10, color: '#666', flexShrink: 0 }}>{c.sha.slice(0, 7)}</code>
          <span style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.message}>{c.message}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
          <Pill text={c.status} color={color} />
          {c.prNumber != null && <span style={{ fontSize: 10, color: '#666' }}>PR #{c.prNumber}</span>}
        </div>
      </div>
    </div>
  );
}

export function CommitGraph({ repoFullName, switcher }: { repoFullName: string | null; switcher?: React.ReactNode }) {
  const { main, branches } = useGitGraph(repoFullName);

  return (
    <div style={{ width: 320, flexShrink: 0, borderLeft: '1px solid #000', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ ...panelHeader, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1 }}>Git graph</span>
        {switcher}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: 8 }}>
        {!repoFullName ? (
          <div style={{ fontSize: 11, color: '#666' }}>No repo selected.</div>
        ) : (
          <>
            {/* Branches: the agent's own (highlighted) + any real GitHub branches when opted in. */}
            <div style={{ fontSize: 10, fontWeight: 'bold', color: '#555', marginBottom: 6 }}>
              {branches.some(b => b.kind === 'github') ? 'BRANCHES' : 'ACTIVE BRANCHES'} {branches.length ? `(${branches.length})` : ''}
            </div>
            {branches.length === 0 ? (
              <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
                No open branches — the agent's feature/fix branches appear here as they're cut.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                {branches.map(b => <BranchCard key={b.key} b={b} />)}
              </div>
            )}

            {/* Production branch commit spine, coloured by deploy status. */}
            <div style={{ fontSize: 10, fontWeight: 'bold', color: '#555', margin: '4px 0 6px' }}>PRODUCTION</div>
            {main.length === 0 ? (
              <div style={{ fontSize: 11, color: '#888' }}>No deploys yet.</div>
            ) : (
              <div>
                {main.map((c, i) => <CommitRow key={c.id} c={c} last={i === main.length - 1} />)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
