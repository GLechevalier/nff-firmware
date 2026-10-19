// Union of the dashboard's lifecycle states and nff-ota's per-device delivery
// states (kept in sync with the ota_jobs_status_check constraint in nff-ota).
export type OtaStatus =
  | 'pending'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'rebooting'
  | 'committed'
  | 'success'
  | 'already-installed'
  | 'failure'
  | 'rolled_back'
  | 'aborted'
  | 'timed_out'
  | 'decommissioned';

export interface OtaJob {
  id: string;
  deviceId: string;
  deviceName: string;
  fromVersion: string;
  targetVersion: string;
  status: OtaStatus;
  progress: number;
  startedAt: Date;
  completedAt?: Date;
  deploymentId?: string | null;
  // Why a rollback/failure happened, as reported by the device (e.g. "health gate
  // failed on v3.0.18 (null_deref)"). Null for successful jobs.
  failureReason?: string | null;
}

const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms);
const min = 60_000;
const hr  = 3_600_000;
const day = 86_400_000;

let _n = 0;
const id = () => `job-${++_n}`;

export const mockOtaJobs: OtaJob[] = [
  {
    id: id(),
    deviceId: '6',
    deviceName: 'Device 06',
    fromVersion: '2.4.0',
    targetVersion: '2.4.1',
    status: 'downloading',
    progress: 34,
    startedAt: ago(2 * min),
  },
  {
    id: id(),
    deviceId: '1',
    deviceName: 'Device 01',
    fromVersion: '2.4.0',
    targetVersion: '2.4.1',
    status: 'committed',
    progress: 100,
    startedAt: ago(5 * day + 3 * hr),
    completedAt: ago(5 * day + 2 * hr + 35 * min),
  },
  {
    id: id(),
    deviceId: '2',
    deviceName: 'Device 02',
    fromVersion: '2.4.0',
    targetVersion: '2.4.1',
    status: 'committed',
    progress: 100,
    startedAt: ago(5 * day + 3 * hr + 10 * min),
    completedAt: ago(5 * day + 2 * hr + 25 * min),
  },
  {
    id: id(),
    deviceId: '8',
    deviceName: 'Device 08',
    fromVersion: '2.4.0',
    targetVersion: '2.4.1',
    status: 'committed',
    progress: 100,
    startedAt: ago(5 * day + 4 * hr),
    completedAt: ago(5 * day + 3 * hr + 40 * min),
  },
  {
    id: id(),
    deviceId: '4',
    deviceName: 'Device 04',
    fromVersion: '2.2.0',
    targetVersion: '2.4.1',
    status: 'rolled_back',
    progress: 100,
    startedAt: ago(6 * day),
    completedAt: ago(6 * day - hr),
  },
  {
    id: id(),
    deviceId: '7',
    deviceName: 'Device 07',
    fromVersion: '1.9.3',
    targetVersion: '2.4.1',
    status: 'timed_out',
    progress: 0,
    startedAt: ago(7 * day),
  },
  {
    id: id(),
    deviceId: '5',
    deviceName: 'Device 05',
    fromVersion: '2.3.8',
    targetVersion: '2.4.0',
    status: 'committed',
    progress: 100,
    startedAt: ago(8 * day),
    completedAt: ago(8 * day - 30 * min),
  },
  {
    id: id(),
    deviceId: '3',
    deviceName: 'Device 03',
    fromVersion: '2.3.8',
    targetVersion: '2.3.9',
    status: 'committed',
    progress: 100,
    startedAt: ago(9 * day),
    completedAt: ago(9 * day - 25 * min),
  },
];
