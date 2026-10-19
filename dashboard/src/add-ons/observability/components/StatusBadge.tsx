import type { DeviceStatus } from '../../../types/device';
import { useEffectiveStatus, type EffectiveStatus } from '../../../context/DeviceHealthContext';

const COLOR: Record<EffectiveStatus, string> = {
  online:   '#22c55e',
  offline:  '#6b7280',
  warning:  '#eab308',
  error:    '#ef4444',
  breaking: '#f59e0b',
  updating: '#1d4ed8', // firmware update shipping — same blue as the floor grid / OtaTab
};

// Passing `deviceId` opts the dot into the break→crash→recover lifecycle: it shows amber the
// moment the device is broken, red while it crashes / the agent fixes it, and green once it
// heartbeats healthy again (see DeviceHealthContext). Without a deviceId it renders the raw
// status verbatim (back-compat for non-device callers).
export function StatusBadge({ status, deviceId }: { status: DeviceStatus; deviceId?: string }) {
  const effective = useEffectiveStatus(deviceId ? { id: deviceId, status } : undefined, status);
  // Pulse the in-progress states (breaking / actively crashing / update shipping) so live
  // activity draws the eye; steady fill for settled states (online / offline / warning).
  const pulsing = effective === 'breaking' || effective === 'error' || effective === 'updating';
  return (
    <span
      title={effective}
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: COLOR[effective] ?? '#ccc',
        ...(pulsing ? { animation: 'nff-dot-pulse 1.2s ease-in-out infinite' } : {}),
      }}
    />
  );
}
