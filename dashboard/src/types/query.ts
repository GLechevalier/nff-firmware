import type { Device } from './device';

/**
 * What a clicked, query-able value carries to the QueryPopup. A value is either
 * scoped to one `device` (device tables/detail) or, for fleet-wide entities
 * (firmware versions, deployments, GitHub runs, crashes, features, groups…),
 * described by a free-form `subject` label plus optional `details` lines the
 * agent gets as extra context.
 */
export interface QueryContext {
  field: string;
  value: string;
  device?: Device;                   // present for device-scoped fields
  subject?: string;                  // entity label when not a device (e.g. "Firmware v1.2.3", "PR #42")
  details?: Record<string, string>;  // extra context lines handed to the agent
}

export type OnQueryClick = (anchor: { x: number; y: number }, context: QueryContext) => void;
