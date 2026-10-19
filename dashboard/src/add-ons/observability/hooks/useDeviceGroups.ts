import { useCallback, useMemo } from 'react';
import { supabase } from '../../../lib/supabase';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import { refetch as refetchResource, useSharedResource } from '../../../lib/sharedResource';
import type { DeviceGroup } from '../types/ota';

function mapRow(row: Record<string, unknown>): DeviceGroup {
  const members = row.device_group_members as { device_id: string }[] | null;
  const memberIds = Array.isArray(members) ? members.map(m => m.device_id) : [];
  return {
    id: row.id as string,
    name: row.name as string,
    memberCount: memberIds.length,
    memberIds,
    createdAt: new Date(row.created_at as string),
  };
}

const keyFor = (projectId: string) => `device-groups:${projectId}`;

async function fetchGroups(projectId: string): Promise<DeviceGroup[]> {
  const { data, error } = await supabase
    .from('device_groups')
    .select('*, device_group_members(device_id)')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(row => mapRow(row as Record<string, unknown>));
}

export function useDeviceGroups() {
  const { currentProjectId } = useCurrentProject();
  const key = currentProjectId ? keyFor(currentProjectId) : null;

  const { data, loading, error } = useSharedResource<DeviceGroup[]>(key, {
    fetcher: () => fetchGroups(currentProjectId),
    // Reload on any group/membership change (published in 0081). Several components mount this hook
    // independently — Groups, Releases, the Deploy walkthrough's gate — and a group created in one
    // of them has to become visible in the others without a page reload. Membership rows carry no
    // project_id, so they're watched unfiltered and re-read through the project-scoped select above.
    subscribe: ({ refetch }) => {
      const channel = supabase
        .channel(`device-groups-${Math.random().toString(36).slice(2)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'device_groups', filter: `project_id=eq.${currentProjectId}` }, refetch)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'device_group_members' }, refetch)
        .subscribe();
      return () => { supabase.removeChannel(channel); };
    },
  });

  const groups = useMemo(() => data ?? [], [data]);

  // Stable identity: callers poll on `reload` in an effect (App.tsx's Deploy-walkthrough gate), so a
  // fresh function each render would tear down and rebuild their interval every time.
  const reload = useCallback(async () => {
    if (key) await refetchResource(key);
  }, [key]);

  // Create a group and add its members. Used both for explicit group management and to
  // build an ad-hoc target when deploying to a hand-picked set of devices.
  const createGroup = useCallback(async (name: string, deviceIds: string[]): Promise<string> => {
    const id = crypto.randomUUID();
    const { error: err } = await supabase.from('device_groups').insert({ id, name, project_id: currentProjectId });
    if (err) throw new Error(err.message);
    if (deviceIds.length > 0) {
      const rows = deviceIds.map(device_id => ({ group_id: id, device_id }));
      const { error: e2 } = await supabase.from('device_group_members').insert(rows);
      if (e2) throw new Error(e2.message);
    }
    await reload();
    return id;
  }, [currentProjectId, reload]);

  const deleteGroup = useCallback(async (id: string): Promise<void> => {
    const { error: err } = await supabase.from('device_groups').delete().eq('id', id);
    if (err) throw new Error(err.message);
    await reload();
  }, [reload]);

  // Add devices to an existing group. Idempotent: re-adding a device already in the group
  // is a no-op (mirrors nff-ota's add_devices_to_group, which swallows the duplicate key).
  const addDevicesToGroup = useCallback(async (groupId: string, deviceIds: string[]): Promise<void> => {
    if (deviceIds.length === 0) return;
    const rows = deviceIds.map(device_id => ({ group_id: groupId, device_id }));
    const { error: err } = await supabase
      .from('device_group_members')
      .upsert(rows, { onConflict: 'group_id,device_id', ignoreDuplicates: true });
    if (err) throw new Error(err.message);
    await reload();
  }, [reload]);

  const removeDevicesFromGroup = useCallback(async (groupId: string, deviceIds: string[]): Promise<void> => {
    if (deviceIds.length === 0) return;
    const { error: err } = await supabase
      .from('device_group_members')
      .delete()
      .eq('group_id', groupId)
      .in('device_id', deviceIds);
    if (err) throw new Error(err.message);
    await reload();
  }, [reload]);

  return {
    groups, loading, error,
    createGroup, deleteGroup, addDevicesToGroup, removeDevicesFromGroup,
    reload,
  };
}
