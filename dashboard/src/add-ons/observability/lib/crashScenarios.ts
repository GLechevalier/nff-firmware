// Demo crash scenarios — shared between the per-device inject control (DeviceDetailTab)
// and the fleet-wide failure-injection box (DemoChaosPanel). Mirrors nff-mock/scenarios.py:
// "OTA fix" scenarios crash-loop until a higher firmware version ships; "reboot" scenarios
// self-heal after one reboot.

export interface CrashScenario {
  id: string;
  label: string;
}

export const CRASH_SCENARIOS: CrashScenario[] = [
  { id: 'null_deref',       label: 'NULL deref (crash-loop · OTA fix)' },
  { id: 'stack_overflow',   label: 'Stack overflow (crash-loop · OTA fix)' },
  { id: 'heap_leak',        label: 'Heap exhaustion (crash-loop · OTA fix)' },
  { id: 'divide_by_zero',   label: 'Divide-by-zero (crash-loop · OTA fix)' },
  { id: 'unaligned_access', label: 'Unaligned access (crash-loop · OTA fix)' },
  { id: 'assert_failed',    label: 'Assert/abort (crash-loop · OTA fix)' },
  { id: 'watchdog',         label: 'Task watchdog (reboot)' },
  { id: 'transient_load',   label: 'Transient LoadProhibited (reboot)' },
];
