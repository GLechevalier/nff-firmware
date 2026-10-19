import type { TabId } from '../../../components/squeletton/TabBar';

// Devices → Hardware: the hardware-as-a-source actions (flash / enroll / WiFi / ship /
// break-and-heal — App-level modals). Parked here after leaving the brain's Devices side
// panel; where they live for good is still open.

export interface DeviceActions {
  onFlash: () => void;
  onWifi: () => void;
  onDeployTour: () => void;
  onBreakHeal: () => void;
  onNavigate: (tab: TabId) => void;
}

const btn = 'border border-ink bg-paper px-2.5 py-1 text-xs text-ink shadow-card hover:bg-elevated';

export function HardwareTab({ actions }: { actions: DeviceActions }) {
  return (
    <div className="flex flex-wrap content-start gap-2 p-3 text-xs text-ink">
      <button className={btn} onClick={actions.onFlash}>⚡ Flash an ESP32 over USB</button>
      <button className={btn} onClick={() => actions.onNavigate('enrollment')}>Enroll a device →</button>
      <button className={btn} onClick={actions.onWifi}>📡 Move a wired device to WiFi</button>
      <button className={btn} onClick={actions.onDeployTour}>Ship firmware (guided) →</button>
      <button className={btn} onClick={actions.onBreakHeal}>Break a device &amp; watch it heal</button>
    </div>
  );
}
