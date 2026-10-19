import { useEffect, useRef, useState } from 'react';
import { BRAND_ACCENT } from '../../lib/brand';
import { useBuilderFeatures } from '../../hooks/useBuilderFeatures';
import { useCodeStream } from '../../hooks/useCodeStream';
import { FeatureStepRow } from './FeatureStepRow';
import { FEATURE_STATUSES, type BuilderFeature, type FeatureStatus } from '../../types/builderFeature';

// Floating "build checklist", docked bottom-right, that tracks an approved feature through the
// pipeline the agent drives: branch → code (streamed to the Code tab) → OTA → mock validation.
// Mounts at App level so it survives tab switches (the user jumps to the Code tab to watch the
// firmware stream while this keeps following progress). Data is live: builder_features +
// builder_feature_steps over Realtime (useBuilderFeatures) and the code-run status (useCodeStream).

interface Props {
  featureId: string;
  onDismiss: () => void;
  onGoToCode?: () => void;
  onGoToBuilder?: () => void;
}

type PhaseState = 'done' | 'running' | 'pending';

const PHASE_ICON: Record<PhaseState, string> = { done: '✓', running: '▶', pending: '○' };
const PHASE_COLOR: Record<PhaseState, string> = { done: '#22c55e', running: '#000', pending: '#ccc' };

// Order index of a status in the lifecycle, so "have we reached at least X" is a comparison.
function rank(status: FeatureStatus): number {
  return FEATURE_STATUSES.indexOf(status);
}

interface Phase {
  key: string;
  label: string;
  state: PhaseState;
  hint?: string;
}

function derivePhases(feature: BuilderFeature, codeStreaming: boolean, codeFileCount: number): Phase[] {
  const r = rank(feature.status);
  const planned = rank('planned');
  const branch = rank('branch_created');
  const validating = rank('validating');
  const validated = rank('validated');
  const abandoned = feature.status === 'abandoned';

  // Code phase: running while a code-run is live for this project, done once we've moved past
  // branch_created toward validating (code committed) — or when files have streamed.
  const codeState: PhaseState =
    r >= validating ? 'done'
    : codeStreaming ? 'running'
    : r >= branch && codeFileCount > 0 ? 'done'
    : r >= branch ? 'running'
    : 'pending';

  return [
    {
      key: 'approved',
      label: 'Plan approved',
      state: r > planned || r >= branch ? 'done' : r === planned ? 'running' : 'pending',
    },
    {
      key: 'branch',
      label: 'Branch created',
      state: feature.branchName ? 'done' : r >= branch ? 'running' : 'pending',
      hint: feature.branchName ?? undefined,
    },
    {
      key: 'code',
      label: 'Firmware written',
      state: abandoned ? 'pending' : codeState,
      hint: codeFileCount > 0 ? `${codeFileCount} file${codeFileCount === 1 ? '' : 's'}` : undefined,
    },
    {
      key: 'ota',
      label: 'OTA sent',
      state: r >= validated ? 'done' : r >= validating ? 'running' : 'pending',
    },
    {
      key: 'validated',
      label: 'Mock validated',
      state: r >= validated ? 'done' : 'pending',
    },
  ];
}

function PhaseRow({ phase }: { phase: Phase }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, padding: '3px 0' }}>
      <span style={{
        flexShrink: 0, width: 12, color: PHASE_COLOR[phase.state], fontSize: 12,
      }}>
        {PHASE_ICON[phase.state]}
      </span>
      <span style={{
        color: phase.state === 'pending' ? '#aaa' : '#000',
        fontWeight: phase.state === 'running' ? 700 : 400,
        fontStyle: phase.state === 'running' ? 'italic' : 'normal',
      }}>
        {phase.label}
      </span>
      {phase.hint && (
        <span style={{ marginLeft: 'auto', color: '#888', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>
          {phase.hint}
        </span>
      )}
    </div>
  );
}

export function BuildChecklistModal({ featureId, onDismiss, onGoToCode, onGoToBuilder }: Props) {
  const { features } = useBuilderFeatures();
  const { live } = useCodeStream();
  const [minimized, setMinimized] = useState(false);

  // Escape minimizes (never dismisses) so the tracker isn't lost by accident.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMinimized(true);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const feature = features.find(f => f.id === featureId);
  const awaitingInput = feature?.awaitingInput ?? false;

  // Pop the modal open on the rising edge of a new question so the nudge isn't hidden behind a
  // minimized header. A ref keeps it edge-triggered — re-minimizing while still waiting sticks.
  const wasAwaitingRef = useRef(false);
  useEffect(() => {
    if (awaitingInput && !wasAwaitingRef.current) setMinimized(false);
    wasAwaitingRef.current = awaitingInput;
  }, [awaitingInput]);

  if (!feature) return null;

  // The newest live code-run for this project (code-runs are project-keyed, not feature-keyed).
  const liveRun = live.find(s => s.live && s.status === 'streaming')
    ?? live.slice().sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  const codeStreaming = !!liveRun && liveRun.live && liveRun.status === 'streaming';
  const codeFileCount = liveRun?.files.length ?? 0;

  const phases = derivePhases(feature, codeStreaming, codeFileCount);
  const doneCount = phases.filter(p => p.state === 'done').length;
  const terminal = feature.status === 'validated' || feature.status === 'merged' || feature.status === 'abandoned';

  const headerBar = (
    <div
      onClick={() => setMinimized(m => !m)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
        background: BRAND_ACCENT, color: '#fff', cursor: 'pointer',
      }}
    >
      {awaitingInput && <span style={{ color: '#eab308', flexShrink: 0 }} title="The agent has a question">⚠</span>}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 'bold' }}>
        {feature.status === 'validated' ? '✓ Built: ' : feature.status === 'abandoned' ? '✕ Abandoned: ' : 'Building: '}
        {feature.title || '(untitled)'}
      </span>
      <span style={{ fontSize: 10, color: '#aaa', flexShrink: 0 }}>{doneCount}/{phases.length}</span>
      <button
        onClick={e => { e.stopPropagation(); setMinimized(m => !m); }}
        title={minimized ? 'Expand' : 'Minimize'}
        style={{ border: 'none', background: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}
      >
        {minimized ? '▢' : '–'}
      </button>
      <button
        onClick={e => { e.stopPropagation(); onDismiss(); }}
        title="Dismiss (build keeps running)"
        style={{ border: 'none', background: 'none', color: '#fff', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px' }}
      >
        ×
      </button>
    </div>
  );

  return (
    <div
      onClick={e => e.stopPropagation()}
      style={{
        position: 'fixed', bottom: 16, right: 16, zIndex: 9998, width: 320,
        background: '#fff', border: '1.5px solid #000', boxShadow: '4px 4px 0 #000',
        display: 'flex', flexDirection: 'column', maxHeight: '70vh',
      }}
    >
      {headerBar}
      {!minimized && (
        <div style={{ padding: '8px 10px', overflowY: 'auto', fontSize: 12, lineHeight: 1.5 }}>
          {/* The agent paused the build to ask a question — point the user to the Builder tab. */}
          {awaitingInput && (
            <div style={{ marginBottom: 8, padding: '6px 8px', background: '#fef9c3', border: '1px solid #eab308' }}>
              <div style={{ fontWeight: 'bold', marginBottom: 2 }}>⚠ The agent has a question</div>
              <div style={{ fontSize: 11, color: '#333' }}>
                {feature.pendingQuestion
                  ? feature.pendingQuestion
                  : 'Answer it in the Builder tab to continue the build.'}
              </div>
              {onGoToBuilder && (
                <button
                  onClick={onGoToBuilder}
                  style={{
                    marginTop: 6, width: '100%', padding: '4px 0', background: BRAND_ACCENT,
                    border: '1px solid #000', color: '#fff', cursor: 'pointer',
                    fontSize: 11, fontWeight: 'bold',
                  }}
                >
                  Go to Builder tab →
                </button>
              )}
            </div>
          )}

          {/* High-level lifecycle phases */}
          {phases.map(p => <PhaseRow key={p.key} phase={p} />)}

          {/* The agent's own ordered plan steps, if any */}
          {feature.steps.length > 0 && (
            <div style={{ marginTop: 8, borderTop: '1px solid #eee', paddingTop: 6 }}>
              <div style={{ fontSize: 9, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 0.5, color: '#888', marginBottom: 2 }}>
                Steps
              </div>
              {feature.steps.map((s, i) => <FeatureStepRow key={i} step={s} />)}
            </div>
          )}

          {/* Hand-off to the Code tab to watch the firmware stream live */}
          {onGoToCode && (codeStreaming || codeFileCount > 0) && (
            <button
              onClick={onGoToCode}
              style={{
                marginTop: 8, width: '100%', padding: '4px 0', background: 'none',
                border: '1px solid #000', color: '#000', cursor: 'pointer', fontSize: 11,
              }}
            >
              View in Code tab →
            </button>
          )}

          {terminal && (
            <div style={{ marginTop: 8, fontSize: 11, color: feature.status === 'abandoned' ? '#b91c1c' : '#15803d' }}>
              {feature.status === 'validated' ? 'Validated on the canary device.'
                : feature.status === 'merged' ? 'Merged into production.'
                : 'Feature abandoned.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
