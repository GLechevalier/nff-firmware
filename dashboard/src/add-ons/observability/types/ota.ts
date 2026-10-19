// Deployments and device groups — the nff-ota orchestration the dashboard now drives
// by writing rows directly to Supabase (a backend poller picks scheduled rows up).

export type DeploymentStatus = 'scheduled' | 'active' | 'paused' | 'finished' | 'aborted';

export interface Deployment {
  id: string;
  name: string;
  targetVersion: string;
  deviceGroupId: string;
  status: DeploymentStatus;
  maxDevicesInFlight: number;
  retries: number;
  createdAt: Date;
  startTime: Date | null;
  // When paused/aborted, why — e.g. "rate_limited: …" or "declined: rate-limited".
  haltedReason: string | null;
}

export interface DeviceGroup {
  id: string;
  name: string;
  memberCount: number;
  memberIds: string[];
  createdAt: Date;
}
