import type { DeviceStatus } from '../../../types/device';

// A crash report (and its symbolicated backtrace + pre-crash RTC log) as rendered by the
// CrashTab. Rows come from Supabase `crash_reports` (+ backtrace_frames / rtc_log_lines),
// populated by nff-fleet's db.ingest_crash when a device publishes a retained crash report.

export interface BacktraceFrame {
  address: string;
  resolved?: string;
}

export interface RtcLogLine {
  level: 'I' | 'W' | 'E';
  tag: string;
  message: string;
  msBeforeCrash: number;
}

export interface CrashReport {
  id: string;
  deviceId: string;
  deviceName: string;
  deviceStatus: DeviceStatus;
  timestamp: Date;
  reason: string;
  exceptionCause: number;
  pc: string;
  uptimeMs: number;
  crashCount: number;
  fwVersion: string;
  buildId: string;
  backtrace: BacktraceFrame[];
  rtcLog: RtcLogLine[];
  retained: boolean;
}
