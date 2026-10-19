import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { Device, DeviceHardware, DeviceStatus, OtaEnrollmentStatus } from '../types/device';
import type { ChatMessage } from '../components/chat/ChatPanel';
import type { ConsoleEntry } from '../components/squeletton/ConsolePanel';
import { FLOOR_PROJECT_ID } from './floorProject';

// Live, read-only feed for the public floor page. Subscribes (anon key) to the four
// tables the floor renders — devices, agent_messages, agent_console_entries, ota_jobs —
// all filtered to FLOOR_PROJECT_ID, which is the only project the anon role can read
// (public-read RLS, migration 0062). No writes, no auth, no project context — this is a
// trimmed mirror of the real useDevices / useAgentMessages / useAgentConsole hooks.

// Active OTA job states that should paint a device "updating" on the grid. Matches nff-ota's
// real ota_jobs statuses (transitions.py) — the showroom keeps 'pending' so the dot lights for
// the whole rollout, and stays lit through install/reboot instead of reverting early.
const OTA_ACTIVE = new Set(['pending', 'downloading', 'installing', 'rebooting', 'verifying']);

function mapDevice(row: Record<string, unknown>): Device {
  return {
    id: row.id as string,
    projectId: (row.project_id as string | null) ?? '',
    name: row.name as string,
    status: row.status as DeviceStatus,
    firmwareVersion: row.firmware_version as string,
    agentConnected: row.agent_connected as boolean,
    lastSeen: new Date(row.last_seen as string),
    ipAddress: (row.ip_address as string | null) ?? '',
    rssi: (row.rssi as number | null) ?? null,
    uptimeSeconds: row.uptime_seconds as number,
    otaStatus: (row.ota_status as OtaEnrollmentStatus | null) ?? 'accepted',
    currentFirmwareVersion: (row.current_firmware_version as string | null) ?? null,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    deviceType: (row.device_type as string | null) ?? null,
    hardware: (row.hardware && typeof row.hardware === 'object' ? (row.hardware as DeviceHardware) : {}),
    heartbeatIntervalS: (row.heartbeat_interval_s as number | null) ?? null,
    // The public floor never runs the break demo; 0080's marker is irrelevant here.
    demoFaultAbove: null,
    demoFaultSince: null,
  };
}

function mapMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: row.id as string,
    role: (row.role as 'user' | 'agent') ?? 'agent',
    content: (row.content as string) ?? '',
    timestamp: new Date((row.ts as string) ?? Date.now()),
  };
}

function mapEntry(row: Record<string, unknown>): ConsoleEntry {
  return {
    id: row.id as string,
    type: (row.type as ConsoleEntry['type']) ?? 'output',
    content: (row.content as string) ?? '',
    timestamp: new Date((row.ts as string) ?? Date.now()),
  };
}

// Keep the live feeds bounded so a long-running floor doesn't grow unboundedly in memory.
const MAX_MESSAGES = 60;
const MAX_ENTRIES = 200;

export interface FloorData {
  devices: Device[];
  messages: ChatMessage[];
  entries: ConsoleEntry[];
  updatingIds: Set<string>;
  task: { title: string; steps: string[] } | null;
}

export function useFloorData(): FloorData {
  const [devices, setDevices] = useState<Device[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());
  const [task, setTask] = useState<{ title: string; steps: string[] } | null>(null);

  useEffect(() => {
    const eq = `project_id=eq.${FLOOR_PROJECT_ID}`;
    const id = Math.random().toString(36).slice(2);

    // ── Initial snapshots ────────────────────────────────────────────────────
    supabase.from('devices').select('*').eq('project_id', FLOOR_PROJECT_ID).order('name')
      .then(({ data }) => setDevices((data ?? []).map(mapDevice)));

    supabase.from('agent_messages').select('*').eq('project_id', FLOOR_PROJECT_ID)
      .order('ts', { ascending: false }).limit(MAX_MESSAGES)
      .then(({ data }) => setMessages((data ?? []).map(mapMessage).reverse()));

    supabase.from('agent_console_entries').select('*').eq('project_id', FLOOR_PROJECT_ID)
      .order('ts', { ascending: false }).limit(MAX_ENTRIES)
      .then(({ data }) => setEntries((data ?? []).map(mapEntry).reverse()));

    supabase.from('ota_jobs').select('device_id,status').eq('project_id', FLOOR_PROJECT_ID)
      .then(({ data }) => {
        const next = new Set<string>();
        for (const r of data ?? []) {
          if (OTA_ACTIVE.has((r as Record<string, unknown>).status as string)) {
            next.add((r as Record<string, unknown>).device_id as string);
          }
        }
        setUpdatingIds(next);
      });

    // Latest active "Current Task" breadcrumb + its steps.
    supabase.from('agent_tasks').select('id,title').eq('project_id', FLOOR_PROJECT_ID)
      .is('completed_at', null).order('created_at', { ascending: false }).limit(1)
      .then(async ({ data }) => {
        const t = (data ?? [])[0] as Record<string, unknown> | undefined;
        if (!t) return;
        const { data: steps } = await supabase.from('agent_task_steps')
          .select('label').eq('task_id', t.id as string).order('position');
        setTask({ title: t.title as string, steps: (steps ?? []).map(s => (s as Record<string, unknown>).label as string) });
      });

    // ── Live subscriptions ───────────────────────────────────────────────────
    const channel = supabase
      .channel(`floor-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'devices', filter: eq }, p => {
        if (p.eventType === 'DELETE') {
          const did = (p.old as Record<string, unknown>).id as string;
          setDevices(prev => prev.filter(d => d.id !== did));
          return;
        }
        const d = mapDevice(p.new as Record<string, unknown>);
        setDevices(prev => {
          const rest = prev.filter(x => x.id !== d.id);
          return [...rest, d].sort((a, b) => a.name.localeCompare(b.name));
        });
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'agent_messages', filter: eq }, p => {
        setMessages(prev => [...prev, mapMessage(p.new as Record<string, unknown>)].slice(-MAX_MESSAGES));
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'agent_console_entries', filter: eq }, p => {
        setEntries(prev => [...prev, mapEntry(p.new as Record<string, unknown>)].slice(-MAX_ENTRIES));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ota_jobs', filter: eq }, p => {
        const row = (p.eventType === 'DELETE' ? p.old : p.new) as Record<string, unknown>;
        const did = row.device_id as string;
        const active = p.eventType !== 'DELETE' && OTA_ACTIVE.has(row.status as string);
        setUpdatingIds(prev => {
          const next = new Set(prev);
          if (active) next.add(did); else next.delete(did);
          return next;
        });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_tasks', filter: eq }, async p => {
        if (p.eventType === 'DELETE') return;
        const row = p.new as Record<string, unknown>;
        if (row.completed_at) { setTask(null); return; }
        const { data: steps } = await supabase.from('agent_task_steps')
          .select('label').eq('task_id', row.id as string).order('position');
        setTask({ title: row.title as string, steps: (steps ?? []).map(s => (s as Record<string, unknown>).label as string) });
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  return { devices, messages, entries, updatingIds, task };
}
