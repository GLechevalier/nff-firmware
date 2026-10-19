import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import { attachLinkDevice, getLinkDeviceId, getLinkState } from '../../../lib/ppplink/linkStore';
import type { DeviceEnrollment, DeviceHardware, EnrollmentBatch, EnrollmentState } from '../../../types/device';

// Device-initiated claim enrollment (DEVICE_OWNERSHIP_DESIGN.md §8). Devices flashed with a batch
// bootstrap credential announce themselves and land in `device_enrollments` (pending). A member
// Accepts them here — a plain SECURITY DEFINER RPC call as the authenticated user (membership is
// enforced inside the RPC via auth.uid() + is_project_member, exactly like setEnrollment writes
// ota_status). The fleet fulfillment worker then issues each a unique cert and rolls it over, after
// which it appears in `devices` as claimed. No serverless route / fleet secret is involved here.

function mapEnrollment(row: Record<string, unknown>): DeviceEnrollment {
  return {
    id: row.id as string,
    batchId: row.batch_id as string,
    projectId: row.project_id as string,
    deviceHwid: row.device_hwid as string,
    deviceId: (row.device_id as string | null) ?? null,
    hardware: (row.hardware && typeof row.hardware === 'object' ? (row.hardware as DeviceHardware) : {}),
    state: row.state as EnrollmentState,
    createdAt: new Date(row.created_at as string),
  };
}

function mapBatch(row: Record<string, unknown>): EnrollmentBatch {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    maxDevices: (row.max_devices as number | null) ?? null,
    state: row.state as EnrollmentBatch['state'],
    createdAt: new Date(row.created_at as string),
    expiresAt: new Date(row.expires_at as string),
  };
}

export function useEnrollments() {
  const { currentProjectId } = useCurrentProject();
  const [enrollments, setEnrollments] = useState<DeviceEnrollment[]>([]);
  const [batches, setBatches] = useState<EnrollmentBatch[]>([]);
  const [autoAccept, setAutoAcceptState] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentProjectId) return;

    supabase.from('device_enrollments').select('*').eq('project_id', currentProjectId)
      .then(({ data, error: err }) => {
        if (err) setError(err.message);
        else setEnrollments((data ?? []).map(mapEnrollment));
      });
    supabase.from('enrollment_batches').select('*').eq('project_id', currentProjectId)
      .then(({ data }) => setBatches((data ?? []).map(mapBatch)));
    supabase.from('projects').select('auto_accept_enrollments').eq('id', currentProjectId).single()
      .then(({ data }) => setAutoAcceptState(Boolean(data?.auto_accept_enrollments)));

    const channelId = Math.random().toString(36).slice(2);
    const channel = supabase
      .channel(`enrollments-${channelId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'device_enrollments', filter: `project_id=eq.${currentProjectId}` },
        payload => {
          if (payload.eventType === 'INSERT') {
            setEnrollments(prev => [...prev, mapEnrollment(payload.new as Record<string, unknown>)]);
          } else if (payload.eventType === 'UPDATE') {
            const u = mapEnrollment(payload.new as Record<string, unknown>);
            setEnrollments(prev => prev.map(e => (e.id === u.id ? u : e)));
            // A claim names the fleet device the active wired link is cabled to. Late-bind it so
            // the console cloud-sync (device_serial_logs) can drain its buffered first-boot log —
            // fresh flashes have no device id until exactly this moment.
            if (u.state === 'claimed' && u.deviceId && getLinkState() !== null && getLinkDeviceId() === null) {
              attachLinkDevice(u.deviceId);
            }
          } else if (payload.eventType === 'DELETE') {
            const id = (payload.old as Record<string, unknown>).id as string;
            setEnrollments(prev => prev.filter(e => e.id !== id));
          }
        })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [currentProjectId]);

  async function acceptOne(enrollmentId: string) {
    const { error: err } = await supabase.rpc('accept_enrollment', { p_enrollment_id: enrollmentId });
    if (err) throw new Error(err.message);
  }

  async function acceptAll(batchId: string) {
    const { error: err } = await supabase.rpc('accept_all_enrollments', { p_batch_id: batchId });
    if (err) throw new Error(err.message);
  }

  async function reject(enrollmentId: string) {
    const { error: err } = await supabase.rpc('reject_enrollment', { p_enrollment_id: enrollmentId });
    if (err) throw new Error(err.message);
  }

  async function setAutoAccept(value: boolean) {
    if (!currentProjectId) return;
    const { error: err } = await supabase
      .from('projects').update({ auto_accept_enrollments: value }).eq('id', currentProjectId);
    if (err) throw new Error(err.message);
    setAutoAcceptState(value);
  }

  return { enrollments, batches, autoAccept, error, acceptOne, acceptAll, reject, setAutoAccept };
}
