import { BRAND_ACCENT } from '../../lib/brand';
import type { OnboardingPath } from '../../hooks/useOnboarding';

// The first thing onboarding shows: which story to tell. Same shell as ConfirmModal, but
// not dismissible (no ×, backdrop or Esc) — the tour waits on the pick.
export function OnboardingPathModal({ onPick }: { onPick: (p: OnboardingPath) => void }) {
  const btn = {
    fontSize: 12, fontWeight: 'bold', border: '1px solid #000', background: '#000', color: '#fff',
    cursor: 'pointer', padding: '6px 14px', flex: 1,
  } as const;
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        role="dialog"
        aria-label="How will you use nff?"
        style={{
          width: 380, maxWidth: '90vw',
          background: '#fff', border: '1.5px solid #000', boxShadow: '4px 4px 0 #000',
          display: 'flex', flexDirection: 'column', fontSize: 12,
        }}
      >
        <div style={{ padding: '6px 10px', borderBottom: '1px solid #000', background: BRAND_ACCENT, color: '#fff' }}>
          <strong style={{ letterSpacing: 0.3 }}>How will you use nff?</strong>
        </div>
        <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={{ fontSize: 13, marginBottom: 6 }}>Dev</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={btn} onClick={() => onPick('dev-physical')}>Physical devices</button>
              <button style={btn} onClick={() => onPick('dev-soft')}>Pure software</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
