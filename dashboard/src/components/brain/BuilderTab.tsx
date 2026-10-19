import { useState } from 'react';
import { BRAND_ACCENT } from '../../lib/brand';
import { Markdown } from '../squeletton/Markdown';
import { FeatureStepRow } from './FeatureStepRow';
import { useBuilderFeatures } from '../../hooks/useBuilderFeatures';
import { useDevices } from '../../add-ons/observability/hooks/useDevices';
import { Queryable } from '../squeletton/Queryable';
import type { OnQueryClick } from '../../types/query';
import {
  FEATURE_STATUSES,
  type BuilderFeature,
  type CanaryTier,
  type FeatureStatus,
} from '../../types/builderFeature';

// The Builder tab: the feature queue (left) and the live plan (right) for nff-builder.
//
// Like every other tab, Builder renders only its main content — the feature-development
// conversation happens in the shared agent panel at the bottom (App's <AgentTab>). App owns the
// interview session: "＋ Develop feature" (here) and "+ Develop Feature" (AgentManagementTab) both
// call up to App, which creates a kind='builder' session and opens it in the shared chat. The
// agent-worker recognises that kind and runs the feature-interview persona (one question at a
// time → add_feature_context → plan_feature → branch → canary; see nff-agent-worker/src/builder/
// interview.ts). The right pane renders the plan nff-builder writes (useBuilderFeatures), so the
// user watches it fill in as they answer. Picking a feature on the left shows its plan.
//
// Feature creation/editing stays the agent's job; the operator only nudges a few fields directly
// here (priority, status, canary devices).

const STATUS_COLOR: Record<FeatureStatus, string> = {
  draft:          '#999',
  planned:        '#3b82f6',
  branch_created: '#8b5cf6',
  validating:     '#eab308',
  validated:      '#22c55e',
  pr_opened:      '#7c3aed',
  merged:         '#000',
  abandoned:      '#ef4444',
};

// Mirror nff-builder's classify_device: a `mock-` id prefix is a simulated device (nff-mock);
// everything else is the user's real hardware. Both user_real and simulated can validate a
// build now (nff-mock OTA wired); only nff_real remains under construction.
function tierOf(deviceId: string): CanaryTier {
  return deviceId.startsWith('mock-') ? 'simulated' : 'user_real';
}

const panelHeader: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid #000',
  fontSize: 12,
  fontWeight: 'bold',
  flexShrink: 0,
};

function StatusBadge({ status }: { status: FeatureStatus }) {
  return (
    <span style={{
      fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.3,
      color: '#fff', background: STATUS_COLOR[status], padding: '1px 5px', flexShrink: 0,
    }}>
      {status.replace('_', ' ')}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 'bold', marginBottom: 4, textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.5, color: '#888' }}>{title}</div>
      {children}
    </div>
  );
}

// The read-only plan body (steps / architecture / sub-features / user stories). Fills in
// live as nff-builder's plan_feature writes the row the interview is producing.
function FeaturePlanBody({
  feature, queryMode, onQueryClick,
}: { feature: BuilderFeature; queryMode?: boolean; onQueryClick?: OnQueryClick }) {
  const subject = `Feature ${feature.title}`;
  return (
    <>
      {feature.description && (
        <Queryable
          queryMode={queryMode} onQueryClick={onQueryClick}
          field="Description" value={feature.description} subject={subject}
          as="div" style={{ margin: '0 0 10px', color: '#333' }}
        >
          {feature.description}
        </Queryable>
      )}

      {feature.steps.length > 0 && (
        <Section title="Steps">
          {feature.steps.map((step, i) => (
            <Queryable
              key={i}
              queryMode={queryMode} onQueryClick={onQueryClick}
              field="Step" value={step.label} subject={subject}
              details={{ Status: step.status }}
              as="div" style={{ display: 'block' }}
            >
              <FeatureStepRow step={step} />
            </Queryable>
          ))}
        </Section>
      )}

      {feature.architecture && (
        <Section title="Architecture">
          <Queryable
            queryMode={queryMode} onQueryClick={onQueryClick}
            field="Architecture" value={feature.architecture} subject={subject}
            as="div" style={{ fontSize: 12, color: '#222' }}
          >
            <Markdown>{feature.architecture}</Markdown>
          </Queryable>
        </Section>
      )}

      {feature.subFeatures.length > 0 && (
        <Section title="Sub-features">
          {feature.subFeatures.map((s, i) => (
            <div key={i} style={{ padding: '3px 0', borderBottom: '1px solid #f0f0f0' }}>
              <div style={{ fontWeight: 'bold' }}>{s.title}</div>
              {s.description && (
                <div style={{ color: '#555', fontSize: 12 }}>
                  <Markdown>{s.description}</Markdown>
                </div>
              )}
            </div>
          ))}
        </Section>
      )}

      {feature.userStories.length > 0 && (
        <Section title="User stories">
          {feature.userStories.map((s, i) => (
            <div key={i} style={{ padding: '3px 0', borderBottom: '1px solid #f0f0f0', color: '#333' }}>
              As <b>{s.asA}</b>, I want <b>{s.iWant}</b>{s.soThat && <> so that <b>{s.soThat}</b></>}.
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

interface BuilderTabProps {
  isMobile?: boolean;
  // Called when the user approves a plan, so App can open the app-level build checklist
  // modal that tracks the agent's progress through branch → code → OTA → mock validation.
  onApproveBuild?: (featureId: string) => void;
  // Called after a feature row is hard-deleted, so App can drop a build-checklist modal
  // that was tracking it (activeBuildFeatureId is persisted in localStorage).
  onFeatureRemoved?: (featureId: string) => void;
  // "＋ Develop feature" — asks App to start a fresh feature interview in the shared agent
  // panel (App owns the kind='builder' session; see startFeatureInterview in App.tsx).
  onDevelopFeature?: () => void;
  // Query-mode plumbing: when on, displayed plan values become click-to-ask-the-agent.
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}

export function BuilderTab({ isMobile, onApproveBuild, onFeatureRemoved, onDevelopFeature, queryMode, onQueryClick }: BuilderTabProps = {}) {
  const {
    features, loading, error,
    setFeaturePriority, setFeatureStatus, setFeatureCanary, cancelFeature, deleteFeature,
  } = useBuilderFeatures();
  const { devices } = useDevices();

  // Which feature's plan is showing. On mobile it also drives which pane is visible: a
  // selection reveals the plan (with a ‹ back control), null shows the list.
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  // Feature id with a cancel/remove in flight — both hit GitHub, so debounce the buttons.
  const [teardownBusyId, setTeardownBusyId] = useState<string | null>(null);

  const displayedFeature = features.find(f => f.id === selectedFeatureId) ?? null;

  // Reorder by renumbering the whole list sequentially and persisting the rows that moved.
  // Keeps arrows working even when the agent left several features at the default priority.
  async function move(index: number, dir: -1 | 1) {
    const next = index + dir;
    if (next < 0 || next >= features.length) return;
    const ordered = [...features];
    [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
    await Promise.all(
      ordered
        .map((f, i) => (f.priority === i ? null : setFeaturePriority(f.id, i)))
        .filter((p): p is Promise<void> => p !== null),
    );
  }

  function openFeature(feature: BuilderFeature) {
    setSelectedFeatureId(feature.id);
  }

  async function onStatusChange(feature: BuilderFeature, status: FeatureStatus) {
    await setFeatureStatus(feature.id, status);
  }

  // Approve a planned feature: move it to branch_created (the canonical signal the worker
  // watches to proceed with the build) and open the app-level checklist modal so the user can
  // follow branch → code → OTA → mock.
  async function approve(feature: BuilderFeature) {
    onApproveBuild?.(feature.id);
    await setFeatureStatus(feature.id, 'branch_created');
  }

  // Cancel: mark abandoned and delete the GitHub branch (server-side, RLS-checked).
  // The row stays in the queue as an audit trail; Remove is the way to drop it entirely.
  async function cancel(feature: BuilderFeature) {
    const branchNote = feature.branchName
      ? ` Its branch ${feature.branchName} will be deleted from GitHub.`
      : '';
    if (!window.confirm(`Cancel "${feature.title || 'this feature'}"?${branchNote}`)) return;
    setTeardownBusyId(feature.id);
    try {
      await cancelFeature(feature);
    } catch (e) {
      window.alert(`Cancel failed: ${(e as Error).message}`);
    } finally {
      setTeardownBusyId(null);
    }
  }

  // Remove: branch cleanup (if any), then hard-delete the row. Realtime DELETE clears it
  // from every open tab; steps cascade in the DB.
  async function remove(feature: BuilderFeature) {
    const branchNote = feature.branchName
      ? ` Its branch ${feature.branchName} will be deleted from GitHub.`
      : '';
    if (!window.confirm(`Remove "${feature.title || 'this feature'}" permanently?${branchNote} This cannot be undone.`)) return;
    setTeardownBusyId(feature.id);
    try {
      await deleteFeature(feature);
      if (selectedFeatureId === feature.id) setSelectedFeatureId(null);
      onFeatureRemoved?.(feature.id);
    } catch (e) {
      window.alert(`Remove failed: ${(e as Error).message}`);
    } finally {
      setTeardownBusyId(null);
    }
  }

  async function toggleCanary(feature: BuilderFeature, deviceId: string) {
    const has = feature.canaryDeviceIds.includes(deviceId);
    const ids = has
      ? feature.canaryDeviceIds.filter(d => d !== deviceId)
      : [...feature.canaryDeviceIds, deviceId];
    await setFeatureCanary(feature.id, tierOf(deviceId), ids);
  }

  const buttonStyle: React.CSSProperties = {
    background: 'none', border: '1px solid #000', color: '#000',
    fontSize: 11, padding: '1px 6px', cursor: 'pointer', letterSpacing: 0.3,
  };

  // ─── Feature list (left) ──────────────────────────────────────────────────────
  const list = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ ...panelHeader, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1 }}>Feature Queue {features.length > 0 && `(${features.length})`}</span>
        {onDevelopFeature && (
          <button onClick={onDevelopFeature} title="Start a fresh feature interview" style={buttonStyle}>
            ＋ Develop feature
          </button>
        )}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && <div style={{ padding: 8, fontSize: 12, color: '#666' }}>Loading features…</div>}
        {error && <div style={{ padding: 8, fontSize: 12, color: '#ef4444' }}>{error}</div>}
        {!loading && !error && features.length === 0 && (
          <div style={{ padding: 12, fontSize: 12, color: '#666', lineHeight: 1.5 }}>
            No features yet. Press ＋ Develop feature and describe one in the chat below — the
            agent interviews you and the plan appears live as nff-builder writes it.
          </div>
        )}
        {features.map((f, i) => {
          const active = f.id === displayedFeature?.id;
          return (
            <div
              key={f.id}
              onClick={() => openFeature(f)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
                borderBottom: '1px solid #eee', cursor: 'pointer', fontSize: 13,
                background: active ? '#000' : 'none', color: active ? '#fff' : '#000',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
                <button
                  onClick={e => { e.stopPropagation(); void move(i, -1); }}
                  disabled={i === 0}
                  style={{ border: 'none', background: 'none', cursor: i === 0 ? 'default' : 'pointer', fontSize: 9, padding: 0, color: i === 0 ? '#ccc' : (active ? '#fff' : '#000'), lineHeight: 1 }}
                >▲</button>
                <button
                  onClick={e => { e.stopPropagation(); void move(i, 1); }}
                  disabled={i === features.length - 1}
                  style={{ border: 'none', background: 'none', cursor: i === features.length - 1 ? 'default' : 'pointer', fontSize: 9, padding: 0, color: i === features.length - 1 ? '#ccc' : (active ? '#fff' : '#000'), lineHeight: 1 }}
                >▼</button>
              </div>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.title || '(untitled)'}
              </span>
              <StatusBadge status={f.status} />
              <button
                onClick={e => { e.stopPropagation(); void remove(f); }}
                disabled={teardownBusyId === f.id}
                title="Remove this feature (deletes its branch too)"
                style={{
                  border: 'none', background: 'none', padding: 0, fontSize: 11, lineHeight: 1,
                  cursor: teardownBusyId === f.id ? 'default' : 'pointer',
                  color: teardownBusyId === f.id ? '#ccc' : (active ? '#fff' : '#999'), flexShrink: 0,
                }}
              >✕</button>
            </div>
          );
        })}
      </div>
    </div>
  );

  // ─── Live plan (right) ────────────────────────────────────────────────────────
  const plan = (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ ...panelHeader, display: 'flex', alignItems: 'center', gap: 8 }}>
        {isMobile && (
          <button onClick={() => setSelectedFeatureId(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, padding: 0 }}>‹</button>
        )}
        {displayedFeature ? (
          <Queryable
            queryMode={queryMode} onQueryClick={onQueryClick}
            field="Title" value={displayedFeature.title} subject={`Feature ${displayedFeature.title}`}
            as="span" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {displayedFeature.title || 'Feature plan'}
          </Queryable>
        ) : (
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Feature plan
          </span>
        )}
        {displayedFeature && (
          <Queryable
            queryMode={queryMode} onQueryClick={onQueryClick}
            field="Status" value={displayedFeature.status} subject={`Feature ${displayedFeature.title}`}
            as="span" style={{ display: 'inline-flex', flexShrink: 0 }}
          >
            <StatusBadge status={displayedFeature.status} />
          </Queryable>
        )}
      </div>
      {displayedFeature ? (
        <div style={{ flex: 1, overflowY: 'auto', padding: 10, fontSize: 12, lineHeight: 1.5 }}>
          {/* The agent paused the build to ask something — its question is in the chat below. */}
          {displayedFeature.awaitingInput && (
            <div style={{ marginBottom: 10, padding: '6px 8px', background: '#fef9c3', border: '1px solid #eab308' }}>
              <div style={{ fontWeight: 'bold' }}>⚠ Waiting for your answer</div>
              <div style={{ fontSize: 11, color: '#333' }}>
                {displayedFeature.pendingQuestion || 'Reply in the chat to continue the build.'}
              </div>
            </div>
          )}

          {/* Status control */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontWeight: 'bold' }}>Status</span>
            <select
              value={displayedFeature.status}
              onChange={e => void onStatusChange(displayedFeature, e.target.value as FeatureStatus)}
              style={{ fontSize: 12, padding: '2px 4px', border: '1px solid #000', background: '#fff' }}
            >
              {FEATURE_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {displayedFeature.branchName && (
              <Queryable
                queryMode={queryMode} onQueryClick={onQueryClick}
                field="Branch" value={displayedFeature.branchName} subject={`Feature ${displayedFeature.title}`}
                as="span" style={{ marginLeft: 'auto', fontSize: 11, color: '#555' }}
              >
                ⑂ {displayedFeature.branchName}
              </Queryable>
            )}
            {displayedFeature.prUrl && (
              <a
                href={displayedFeature.prUrl}
                target="_blank"
                rel="noreferrer"
                style={{ marginLeft: displayedFeature.branchName ? 8 : 'auto', fontSize: 11, color: '#1d4ed8', fontWeight: 'bold' }}
              >
                PR #{displayedFeature.prNumber} ↗
              </a>
            )}
          </div>

          {/* Approve gate: only while the plan is finalised but not yet building. Kicks off the
              branch → code → OTA → mock pipeline and opens the floating build checklist. */}
          {displayedFeature.status === 'planned' && (
            <button
              onClick={() => void approve(displayedFeature)}
              style={{
                width: '100%', marginBottom: 12, padding: '8px 0',
                background: BRAND_ACCENT, color: '#fff', border: '1px solid #000',
                fontSize: 13, fontWeight: 'bold',
                cursor: 'pointer', letterSpacing: 0.5,
              }}
            >
              ✓ Approve plan &amp; build
            </button>
          )}

          {/* Teardown: Cancel keeps the row as an abandoned audit trail; Remove drops it
              entirely. Both delete the feature's nff-feature/* branch from GitHub first. */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            {displayedFeature.status !== 'merged' && displayedFeature.status !== 'abandoned' && (
              <button
                onClick={() => void cancel(displayedFeature)}
                disabled={teardownBusyId === displayedFeature.id}
                title={displayedFeature.branchName
                  ? `Mark abandoned and delete ${displayedFeature.branchName} from GitHub`
                  : 'Mark abandoned'}
                style={{ ...buttonStyle, color: '#b91c1c', borderColor: '#b91c1c', opacity: teardownBusyId === displayedFeature.id ? 0.5 : 1 }}
              >
                ✕ Cancel feature
              </button>
            )}
            <button
              onClick={() => void remove(displayedFeature)}
              disabled={teardownBusyId === displayedFeature.id}
              title="Delete this feature (and its branch) permanently"
              style={{ ...buttonStyle, color: '#666', opacity: teardownBusyId === displayedFeature.id ? 0.5 : 1 }}
            >
              🗑 Remove
            </button>
            {teardownBusyId === displayedFeature.id && (
              <span style={{ fontSize: 11, color: '#666', alignSelf: 'center' }}>cleaning up…</span>
            )}
          </div>

          <FeaturePlanBody feature={displayedFeature} queryMode={queryMode} onQueryClick={onQueryClick} />

          {/* Canary picker */}
          <Section title="Canary devices">
            {devices.length === 0 && <div style={{ color: '#666' }}>No devices in this project.</div>}
            {devices.map(d => {
              const tier = tierOf(d.id);
              const underConstruction = tier === 'nff_real';
              const checked = displayedFeature.canaryDeviceIds.includes(d.id);
              return (
                <label
                  key={d.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', borderBottom: '1px solid #f0f0f0', color: underConstruction ? '#bbb' : '#000', cursor: underConstruction ? 'default' : 'pointer' }}
                  title={underConstruction ? `${tier} tier — under construction` : undefined}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={underConstruction}
                    onChange={() => void toggleCanary(displayedFeature, d.id)}
                    style={{ cursor: underConstruction ? 'default' : 'pointer', margin: 0, flexShrink: 0 }}
                  />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                  <span style={{ fontSize: 9, textTransform: 'uppercase', color: underConstruction ? '#ccc' : '#888' }}>
                    {tier}{underConstruction && ' · soon'}
                  </span>
                </label>
              );
            })}
          </Section>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: '#999', fontSize: 12, padding: 16 }}>
          Select a feature on the left, or ＋ Develop feature to start one — the plan appears here
          as the agent works through the interview in the chat below.
        </div>
      )}
    </div>
  );

  // ─── Layout ───────────────────────────────────────────────────────────────────
  if (isMobile) {
    // One pane at a time: the list, or a picked feature's plan.
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>
        {displayedFeature ? plan : list}
      </div>
    );
  }

  // `flex: 1` (not just height) — App mounts every tab in a row-flex wrapper, so without it
  // this box sizes to its panes' max-content instead of the page. Feature list on the left,
  // plan on the right; the shared agent console + chat sits below (App's <AgentTab>).
  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>
      <div style={{ width: 260, flexShrink: 0, borderRight: '1px solid #000', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {list}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {plan}
      </div>
    </div>
  );
}
