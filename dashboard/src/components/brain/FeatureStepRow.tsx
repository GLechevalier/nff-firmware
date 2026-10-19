import type { FeatureStep, StepStatus } from '../../types/builderFeature';

// Shared renderer for one ordered plan step. Used by the live plan pane (BuilderTab's
// FeaturePlanBody) and the floating build checklist (BuildChecklistModal) so a step looks
// identical wherever it shows. Steps come from builder_feature_steps over Realtime.

export const STEP_ICON: Record<StepStatus, string> = { done: '✓', running: '▶', pending: '○' };
export const STEP_ICON_COLOR: Record<StepStatus, string> = { done: '#22c55e', running: '#000', pending: '#ccc' };

export function FeatureStepRow({ step }: { step: FeatureStep }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, padding: '3px 0', borderBottom: '1px solid #f0f0f0' }}>
      <span style={{ flexShrink: 0, marginTop: 1, color: STEP_ICON_COLOR[step.status], fontSize: 11 }}>
        {STEP_ICON[step.status]}
      </span>
      <span style={{ color: step.status === 'pending' ? '#aaa' : '#000', fontStyle: step.status === 'running' ? 'italic' : 'normal' }}>
        {step.label}
      </span>
    </div>
  );
}
