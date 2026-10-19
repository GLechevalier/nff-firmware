import type { Device } from '../types/device';

// Semantic fleet colors — identical to the marketing site's Proof grid so the public
// floor reads as the same "floor" the landing page advertises, but driven by LIVE data.
const GREEN = '#22c55e'; // running in the field
const AMBER = '#eab308'; // nff is mid-fix (warning / error)
const BLUE = '#1d4ed8';  // OTA update landing live
const GREY = '#3f3f46';  // offline

function colorFor(d: Device, updating: boolean): string {
  if (updating) return BLUE;
  if (d.status === 'online') return GREEN;
  if (d.status === 'offline') return GREY;
  return AMBER; // warning | error → mid-fix
}

function labelFor(d: Device, updating: boolean): string {
  if (updating) return 'OTA update live';
  if (d.status === 'online') return 'running';
  if (d.status === 'offline') return 'offline';
  return 'nff_ mid-fix';
}

// The live floor: one square per real device, colored by its current state. A subtle
// pulse on the "mid-fix" / "updating" squares mirrors the marketing visual.
export function FloorGrid({ devices, updatingIds }: { devices: Device[]; updatingIds: Set<string> }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(16px, 1fr))',
        gap: 3,
      }}
    >
      {devices.map(d => {
        const updating = updatingIds.has(d.id);
        const color = colorFor(d, updating);
        return (
          <div
            key={d.id}
            title={`${d.name} — ${labelFor(d, updating)} (fw ${d.currentFirmwareVersion ?? d.firmwareVersion})`}
            style={{
              aspectRatio: '1',
              border: '1px solid #000',
              background: color,
              transition: 'background .4s ease',
              animation: updating || d.status === 'warning' || d.status === 'error'
                ? 'floorPulse 1.6s ease-in-out infinite'
                : undefined,
            }}
          />
        );
      })}
      {devices.length === 0 && (
        <span style={{ gridColumn: '1 / -1', color: '#888', fontSize: 12 }}>
          Spinning up the fleet…
        </span>
      )}
    </div>
  );
}
