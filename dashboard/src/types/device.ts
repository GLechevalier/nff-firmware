export type DeviceStatus = 'online' | 'offline' | 'warning' | 'error';

// nff-ota enrollment lifecycle (devices.ota_status), distinct from connectivity status.
export type OtaEnrollmentStatus =
  | 'pending'
  | 'preauthorized'
  | 'accepted'
  | 'rejected'
  | 'decommissioned';

// Device-attested hardware fingerprint, carried in the heartbeat (see nff-sdk-c
// nff_heartbeat.c → devices.hardware jsonb). All fields are best-effort: older
// firmware may omit any of them.
export interface DeviceHardware {
  fqbn?: string;   // fully-qualified board name, e.g. "esp32:esp32:esp32"
  chip?: string;   // chip model, e.g. "ESP32-D0WD-V3"
  rev?: number;    // silicon revision
  flash?: number;  // flash size in bytes
}

// A flashed batch of devices sharing one bootstrap credential (DEVICE_OWNERSHIP_DESIGN.md §8;
// nff-db migration 0030). max_devices is the expected size — enrollments beyond it are a
// cloned-credential anomaly the UI surfaces.
export interface EnrollmentBatch {
  id: string;
  projectId: string;
  maxDevices: number | null;
  state: 'active' | 'expired' | 'revoked';
  createdAt: Date;
  expiresAt: Date;
}

// A single device announcing itself under a batch, awaiting acceptance. Once accepted, the fleet
// worker issues a unique per-device cert and the device shows up in `devices` (claimed).
export type EnrollmentState = 'pending' | 'accepted' | 'claimed' | 'rejected' | 'rotated';

export interface DeviceEnrollment {
  id: string;
  batchId: string;
  projectId: string;
  deviceHwid: string;        // MAC/chip id — the dedup + quota key
  deviceId: string | null;   // assigned operational id once claimed
  hardware: DeviceHardware;
  state: EnrollmentState;
  createdAt: Date;
}

export interface Device {
  id: string;
  // Owning project (tenant). Set for real devices (from Supabase); optional only so
  // demo fixtures need not carry it. Needed to address the device on its project-scoped
  // command topic when pinging via fleet.
  projectId?: string;
  name: string;
  status: DeviceStatus;
  firmwareVersion: string;
  agentConnected: boolean;
  lastSeen: Date;
  ipAddress: string;
  rssi: number | null; // dBm; null means wired
  uptimeSeconds: number;
  otaStatus: OtaEnrollmentStatus;
  currentFirmwareVersion: string | null;
  tags: string[];
  // Canonical hardware family ("esp32", "esp32s3", …) the OTA gate matches on.
  deviceType: string | null;
  // Richer fingerprint (fqbn, chip, revision, flash) self-attested in the heartbeat.
  hardware: DeviceHardware;
  // Device-attested heartbeat frequency in seconds (heartbeat "interval_s"). null =
  // unknown (older firmware); the offline rule treats null as 30s. A device is offline
  // once it misses two beats in a row (last_seen older than 2 × this).
  heartbeatIntervalS: number | null;
  // The break-and-heal demo's durable fault marker (nff-db migration 0080), written by
  // api/_selfheal.ts. `demoFaultAbove` is the seeded buggy semver: while it is set, the heartbeat
  // upsert forces status='error' until the device reports firmware strictly above it — so the break
  // survives a page reload, unlike the client-only markers in DeviceHealthContext.
  // Both null on every real device, and on a demo device that has never been broken.
  demoFaultAbove: string | null;
  demoFaultSince: Date | null;
}
