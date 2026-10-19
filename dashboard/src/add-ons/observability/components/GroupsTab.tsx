import { useState } from 'react';
import { useDeviceGroups } from '../hooks/useDeviceGroups';
import { useDevices } from '../hooks/useDevices';
import { ConfirmModal } from '../../../components/squeletton/ConfirmModal';
import { formatRelativeTime } from '../../../utils/time';
import { Queryable } from '../../../components/squeletton/Queryable';
import { StatusBadge } from './StatusBadge';
import type { OnQueryClick } from '../../../types/query';

const panelHeader: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid #000',
  fontSize: 12,
  fontWeight: 'bold',
  flexShrink: 0,
};

export function GroupsTab({ queryMode, onQueryClick }: {
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
} = {}) {
  const { groups, loading, error, createGroup, deleteGroup, addDevicesToGroup, removeDevicesFromGroup } = useDeviceGroups();
  const { devices } = useDevices();

  const [selectedId, setSelectedId] = useState<string>('');
  const [newName, setNewName]       = useState('');
  const [creating, setCreating]     = useState(false);
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [msg, setMsg]               = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const selected = groups.find(g => g.id === selectedId) ?? null;

  async function handleCreate() {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setMsg(null);
    try {
      const id = await createGroup(name, []);
      setNewName('');
      setSelectedId(id);
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  }

  // Errors propagate so ConfirmModal can surface them inline and keep itself open.
  async function doDelete(id: string) {
    setMsg(null);
    await deleteGroup(id);
    if (selectedId === id) setSelectedId('');
  }

  // Toggle a single device's membership in the selected group. Mirrors the nff-ota
  // add_devices_to_group / remove_devices_from_group ops against device_group_members.
  async function toggleMember(deviceId: string, isMember: boolean) {
    if (!selected || busyDevice) return;
    setBusyDevice(deviceId);
    setMsg(null);
    try {
      if (isMember) await removeDevicesFromGroup(selected.id, [deviceId]);
      else          await addDevicesToGroup(selected.id, [deviceId]);
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setBusyDevice(null);
    }
  }

  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>

      {/* Left: group list + create */}
      <div style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #000', overflow: 'hidden' }}>
        <div style={panelHeader}>Device groups</div>

        <div data-tour="groups-create" style={{ display: 'flex', gap: 6, padding: '8px', borderBottom: '1px solid #ddd', flexShrink: 0 }}>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void handleCreate(); }}
            placeholder="new group name"
            style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '3px 5px', border: '1px solid #000' }}
          />
          <button
            onClick={handleCreate}
            disabled={!newName.trim() || creating}
            style={{
              fontSize: 12, fontWeight: 'bold',
              border: 'none', padding: '3px 10px',
              background: newName.trim() && !creating ? '#000' : '#ccc',
              color: '#fff', cursor: newName.trim() && !creating ? 'pointer' : 'default',
            }}
          >
            {creating ? '…' : '+'}
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && <div style={{ padding: 10, fontSize: 11, color: '#aaa' }}>Loading…</div>}
          {error && <div style={{ padding: 10, fontSize: 11, color: '#ef4444' }}>{error}</div>}
          {!loading && groups.length === 0 && (
            <div style={{ padding: 10, fontSize: 11, color: '#aaa' }}>No groups yet — create one above.</div>
          )}
          {groups.map(g => {
            const isSel = g.id === selectedId;
            return (
              <div
                key={g.id}
                onClick={() => setSelectedId(g.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '8px 10px', borderBottom: '1px solid #eee', cursor: 'pointer',
                  background: isSel ? '#f5f5f5' : 'transparent',
                  borderLeft: isSel ? '3px solid #000' : '3px solid transparent',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Queryable
                    queryMode={queryMode}
                    onQueryClick={onQueryClick}
                    field="Group Name"
                    value={g.name}
                    subject={`Group ${g.name}`}
                    details={{ 'Member Count': String(g.memberCount), Created: formatRelativeTime(g.createdAt) }}
                    as="div"
                    style={{ fontWeight: 'bold', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {g.name}
                  </Queryable>
                  <div style={{ fontSize: 10, color: '#888' }}>
                    <Queryable
                      queryMode={queryMode}
                      onQueryClick={onQueryClick}
                      field="Member Count"
                      value={String(g.memberCount)}
                      subject={`Group ${g.name}`}
                    >
                      {g.memberCount} device{g.memberCount !== 1 ? 's' : ''}
                    </Queryable>
                    {' · '}
                    <Queryable
                      queryMode={queryMode}
                      onQueryClick={onQueryClick}
                      field="Created"
                      value={formatRelativeTime(g.createdAt)}
                      subject={`Group ${g.name}`}
                    >
                      {formatRelativeTime(g.createdAt)}
                    </Queryable>
                  </div>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); setDeleteTarget({ id: g.id, name: g.name }); }}
                  title="Delete group"
                  style={{ border: 'none', background: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>

        {msg && (
          <div style={{ padding: '6px 8px', borderTop: '1px solid #ddd', fontSize: 10, color: msg.startsWith('Failed') ? '#ef4444' : '#666', flexShrink: 0 }}>
            {msg}
          </div>
        )}
      </div>

      {/* Right: member picker for the selected group */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!selected ? (
          <>
            <div style={panelHeader}>Members</div>
            <div style={{ padding: 16, color: '#aaa', fontSize: 13 }}>Select a group to manage its devices.</div>
          </>
        ) : (
          <>
            <div style={{ ...panelHeader, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selected.name}
              </span>
              <span style={{ fontSize: 11, fontWeight: 'normal', color: '#888', flexShrink: 0 }}>
                {selected.memberCount}/{devices.length} selected
              </span>
            </div>
            <div style={{ padding: '4px 10px 6px', borderBottom: '1px solid #eee', fontSize: 11, color: '#aaa', flexShrink: 0 }}>
              Check a device to add it to this group; uncheck to remove. Writes to <code>device_group_members</code>.
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {devices.length === 0 && (
                <div style={{ padding: 10, fontSize: 11, color: '#aaa' }}>No devices enrolled.</div>
              )}
              {devices.map(dev => {
                const isMember = selected.memberIds.includes(dev.id);
                const busy = busyDevice === dev.id;
                return (
                  <label
                    key={dev.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '7px 10px', borderBottom: '1px solid #eee',
                      cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isMember}
                      disabled={busy}
                      onChange={() => toggleMember(dev.id, isMember)}
                      style={{ flexShrink: 0, cursor: busy ? 'default' : 'pointer' }}
                    />
                    <span style={{ flexShrink: 0, display: 'inline-flex' }}>
                      <StatusBadge status={dev.status} deviceId={dev.id} />
                    </span>
                    <Queryable
                      queryMode={queryMode}
                      onQueryClick={onQueryClick}
                      field="Device"
                      value={dev.name}
                      device={dev}
                      style={{ fontWeight: 'bold', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {dev.name}
                    </Queryable>
                    <Queryable
                      queryMode={queryMode}
                      onQueryClick={onQueryClick}
                      field="Device ID"
                      value={dev.id}
                      device={dev}
                      style={{ fontSize: 10, color: '#aaa', flexShrink: 0 }}
                    >
                      ID = {dev.id}
                    </Queryable>
                  </label>
                );
              })}
            </div>
          </>
        )}
      </div>

      {deleteTarget && (
        <ConfirmModal
          title="Delete group"
          message={`Delete group "${deleteTarget.name}"? Membership rows are removed too.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await doDelete(deleteTarget.id);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
