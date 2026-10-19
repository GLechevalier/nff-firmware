import { useState } from 'react';
import { useDevices } from '../hooks/useDevices';
import { useEnrollments } from '../hooks/useEnrollments';
import { DeviceModal } from './DeviceModal';
import { ConfirmModal } from '../../../components/squeletton/ConfirmModal';
import { StatusBadge } from './StatusBadge';
import { useEffectiveStatusFn } from '../../../context/DeviceHealthContext';
import { Toast } from './Toast';
import type { Device, DeviceEnrollment, EnrollmentBatch, OtaEnrollmentStatus } from '../../../types/device';
import { Queryable } from '../../../components/squeletton/Queryable';
import type { OnQueryClick } from '../../../types/query';

const OTA_STATUS_COLOR: Record<OtaEnrollmentStatus, string> = {
  pending:        '#d97706',
  preauthorized:  '#1d4ed8',
  accepted:       '#22c55e',
  rejected:       '#ef4444',
  decommissioned: '#6b7280',
};

// The board only surfaces these three lanes. The enrollment enum stays intact for the
// OTA backend; other statuses are mapped onto a lane for display via laneFor().
type Lane = 'pending' | 'accepted' | 'rejected';
const BOARD_COLUMNS: Lane[] = ['pending', 'accepted', 'rejected'];

// Display mapping: preauthorized shows in the pending lane, decommissioned in rejected.
// Dragging a card only ever writes one of the three canonical lane values.
function laneFor(status: OtaEnrollmentStatus): Lane {
  if (status === 'preauthorized') return 'pending';
  if (status === 'decommissioned') return 'rejected';
  return status as Lane;
}

function DeviceCard({ dev, lane, busy, onOpen, onDragStart, onMove, queryMode, onQueryClick }: {
  dev: Device;
  lane: Lane;
  busy: boolean;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onMove: (dir: -1 | 1) => void;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}) {
  const [hover, setHover] = useState(false);
  const laneIndex = BOARD_COLUMNS.indexOf(lane);
  const canLeft = laneIndex > 0;
  const canRight = laneIndex < BOARD_COLUMNS.length - 1;
  const showArrows = hover && !busy;

  const arrowBtn: React.CSSProperties = {
    border: '1px solid #000', background: '#fff', cursor: 'pointer',
    fontSize: 11, lineHeight: 1, padding: '1px 5px', boxShadow: '1px 1px 0 #ddd',
  };

  return (
    <div
      draggable={!busy}
      onDragStart={onDragStart}
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        border: '1px solid #000', background: '#fff', padding: '6px 8px', marginBottom: 6,
        cursor: busy ? 'default' : 'grab', opacity: busy ? 0.5 : 1,
        boxShadow: '2px 2px 0 #ddd',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* Online/offline dot — same live status the dashboard shows, not the lane's OTA color. */}
        <span style={{ display: 'inline-flex', flexShrink: 0 }}><StatusBadge status={dev.status} deviceId={dev.id} /></span>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Device Name"
          value={dev.name}
          device={dev}
          style={{ fontSize: 12, fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {dev.name}
        </Queryable>
      </div>
      <div style={{ fontSize: 10, color: '#999', marginTop: 2 }}>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Device ID"
          value={dev.id}
          device={dev}
        >
          {dev.id}
        </Queryable>
        {' · '}
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Firmware"
          value={dev.currentFirmwareVersion ?? dev.firmwareVersion}
          device={dev}
        >
          {dev.currentFirmwareVersion ?? dev.firmwareVersion}
        </Queryable>
      </div>
      {dev.tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 4 }}>
          {dev.tags.map(tag => (
            <span key={tag} style={{ border: '1px solid #000', background: '#f4f4f4', padding: '0 4px', fontSize: 10 }}>{tag}</span>
          ))}
        </div>
      )}
      {showArrows && (canLeft || canRight) && (
        <div style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 3 }}>
          {canLeft && (
            <button
              title="Move left"
              onClick={e => { e.stopPropagation(); onMove(-1); }}
              style={arrowBtn}
            >◀</button>
          )}
          {canRight && (
            <button
              title="Move right"
              onClick={e => { e.stopPropagation(); onMove(1); }}
              style={arrowBtn}
            >▶</button>
          )}
        </div>
      )}
    </div>
  );
}

function EnrollmentCard({ enr, busy, onAccept, onReject, queryMode, onQueryClick }: {
  enr: DeviceEnrollment;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}) {
  const chip = enr.hardware.chip ?? enr.hardware.fqbn ?? '';
  const subject = enr.deviceHwid ?? 'Enrollment';
  return (
    <div style={{
      border: '1px solid #000', background: '#fff', padding: '6px 8px', marginBottom: 6,
      boxShadow: '2px 2px 0 #ddd', opacity: busy ? 0.5 : 1,
    }}>
      <Queryable
        queryMode={queryMode}
        onQueryClick={onQueryClick}
        field="Hardware ID"
        value={enr.deviceHwid}
        subject={subject}
        details={{
          ...(enr.hardware.chip ? { Chip: enr.hardware.chip } : {}),
          ...(enr.hardware.fqbn ? { FQBN: enr.hardware.fqbn } : {}),
        }}
        as="div"
        style={{ fontSize: 12, fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {enr.deviceHwid}
      </Queryable>
      {chip && (
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field={enr.hardware.chip ? 'Chip' : 'FQBN'}
          value={chip}
          subject={subject}
          as="div"
          style={{ fontSize: 10, color: '#999', marginTop: 2 }}
        >
          {chip}
        </Queryable>
      )}
      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
        <button disabled={busy} onClick={onAccept} style={{ flex: 1, fontSize: 11, border: '1px solid #000', background: '#22c55e', color: '#fff', cursor: busy ? 'default' : 'pointer', padding: '2px 0' }}>Accept</button>
        <button disabled={busy} onClick={onReject} style={{ flex: 1, fontSize: 11, border: '1px solid #000', background: '#fff', cursor: busy ? 'default' : 'pointer', padding: '2px 0' }}>Reject</button>
      </div>
    </div>
  );
}

export function EnrollmentTab({ queryMode, onQueryClick }: {
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
} = {}) {
  // Use the unfiltered list — the enrollment board's "rejected" lane must still show rejected devices.
  const { allDevices: devices, setEnrollment, setEnrollmentBulk, setDeviceTags, deleteRejectedDevices } = useDevices();
  const { enrollments, batches, autoAccept, acceptOne, acceptAll, reject, setAutoAccept } = useEnrollments();
  // Classify by the SAME status the cards' dots show, not the raw one: a device crash-looping or
  // taking a fix OTA blinks 'offline' between reboots, and must not be swept as dead.
  const effectiveStatus = useEffectiveStatusFn();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<Lane | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState<number | null>(null);
  // Ids are snapshotted at click time so a heartbeat landing between click and confirm can't
  // widen the set the user agreed to.
  const [confirmReject, setConfirmReject] = useState<{ lane: Lane; ids: string[] } | null>(null);
  // Set when a background bulk action fails so a toast can report it — the modal is already
  // gone by then and the user may have navigated away.
  const [toastError, setToastError] = useState<string | null>(null);

  const pending = enrollments.filter(e => e.state === 'pending');
  const batchById = new Map<string, EnrollmentBatch>(batches.map(b => [b.id, b]));
  // Per-batch enrolled count (pending + accepted + claimed) for the quota anomaly check.
  const enrolledByBatch = new Map<string, number>();
  for (const e of enrollments) {
    if (e.state !== 'rejected') enrolledByBatch.set(e.batchId, (enrolledByBatch.get(e.batchId) ?? 0) + 1);
  }
  const overQuota = batches.filter(b => b.maxDevices != null && (enrolledByBatch.get(b.id) ?? 0) > b.maxDevices);

  async function runEnroll(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusyId(null); }
  }

  async function handleToggleAuto(value: boolean) {
    setErr(null);
    try { await setAutoAccept(value); } catch (e) { setErr((e as Error).message); }
  }

  // Derive the live device so realtime tag/status edits reflect in the open modal.
  const selected = selectedId ? devices.find(d => d.id === selectedId) ?? null : null;

  async function handleSet(deviceId: string, status: Lane) {
    setBusyId(deviceId);
    setErr(null);
    try {
      await setEnrollment(deviceId, status);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  function handleDrop(lane: Lane, e: React.DragEvent) {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData('text/plain');
    if (!id) return;
    const dev = devices.find(d => d.id === id);
    if (!dev || laneFor(dev.otaStatus) === lane) return; // already in this lane
    void handleSet(id, lane);
  }

  const panelHeader: React.CSSProperties = {
    padding: '4px 8px', borderBottom: '1px solid #000', fontSize: 12, fontWeight: 'bold', flexShrink: 0,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>
      <div style={{ ...panelHeader, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Device Enrollment</span>
        <label style={{ fontSize: 11, fontWeight: 'normal', display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={autoAccept} onChange={e => void handleToggleAuto(e.target.checked)} />
          Auto-accept new devices
        </label>
      </div>
      {err && <div style={{ padding: '4px 10px', fontSize: 11, color: '#ef4444' }}>{err}</div>}
      {overQuota.map(b => (
        <div key={b.id} style={{ padding: '4px 10px', fontSize: 11, color: '#b91c1c', background: '#fef2f2', borderBottom: '1px solid #fecaca' }}>
          ⚠ Batch{' '}
          <Queryable
            queryMode={queryMode}
            onQueryClick={onQueryClick}
            field="Batch ID"
            value={b.id}
            subject={`Batch ${b.id}`}
            details={{ 'Max Devices': String(b.maxDevices), Enrolled: String(enrolledByBatch.get(b.id) ?? 0) }}
          >
            {b.id.slice(0, 8)}
          </Queryable>
          {' expected '}
          <Queryable
            queryMode={queryMode}
            onQueryClick={onQueryClick}
            field="Max Devices"
            value={b.maxDevices != null ? String(b.maxDevices) : ''}
            subject={`Batch ${b.id}`}
          >
            {b.maxDevices}
          </Queryable>
          {' device(s) but '}{enrolledByBatch.get(b.id)} enrolled — possible cloned credential.
        </div>
      ))}

      <div style={{ display: 'flex', flex: 1, minWidth: 0, overflow: 'hidden' }}>
        {/* Unclaimed: devices announcing under a batch, awaiting acceptance (pre-ownership). */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', borderRight: '1px solid #000', overflow: 'hidden' }}>
          <div style={{
            padding: '4px 10px', fontSize: 11, fontWeight: 'bold', letterSpacing: 0.5,
            textTransform: 'uppercase', color: '#7c3aed', background: '#faf5ff',
            borderBottom: '1px solid #eee', flexShrink: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span>unclaimed ({pending.length})</span>
            {pending.length > 0 && (
              <button
                disabled={busyId === 'all'}
                onClick={() => void runEnroll('all', async () => {
                  for (const batchId of new Set(pending.map(e => e.batchId))) await acceptAll(batchId);
                })}
                style={{ fontSize: 10, border: '1px solid #000', background: '#22c55e', color: '#fff', cursor: 'pointer', padding: '1px 6px' }}
              >Accept all</button>
            )}
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
            {pending.length === 0 && <div style={{ fontSize: 11, color: '#ccc', padding: 4 }}>—</div>}
            {pending.map(enr => {
              const b = batchById.get(enr.batchId);
              return (
                <div key={enr.id}>
                  {b?.maxDevices != null && (
                    <div style={{ fontSize: 9, color: '#a78bfa', marginBottom: 2 }}>
                      batch {enr.batchId.slice(0, 8)} · {enrolledByBatch.get(enr.batchId)}/{b.maxDevices}
                    </div>
                  )}
                  <EnrollmentCard
                    enr={enr}
                    busy={busyId === enr.id}
                    onAccept={() => void runEnroll(enr.id, () => acceptOne(enr.id))}
                    onReject={() => void runEnroll(enr.id, () => reject(enr.id))}
                    queryMode={queryMode}
                    onQueryClick={onQueryClick}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {BOARD_COLUMNS.map((lane, i) => {
          const items = devices.filter(d => laneFor(d.otaStatus) === lane);
          const rejectedCount = lane === 'rejected' ? items.filter(d => d.otaStatus === 'rejected').length : 0;
          // Dead devices in this lane — the sweep's targets. Never offered on the rejected lane
          // itself, which already has "Delete all".
          const inactive = lane === 'rejected' ? [] : items.filter(d => effectiveStatus(d) === 'offline');
          return (
            <div
              key={lane}
              onDragOver={e => { e.preventDefault(); if (dragOver !== lane) setDragOver(lane); }}
              onDragLeave={() => setDragOver(prev => (prev === lane ? null : prev))}
              onDrop={e => handleDrop(lane, e)}
              style={{
                flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
                borderRight: i < BOARD_COLUMNS.length - 1 ? '1px solid #000' : 'none',
                background: dragOver === lane ? '#f0f9ff' : '#fff',
                overflow: 'hidden',
              }}
            >
              <div style={{
                padding: '4px 10px', fontSize: 11, fontWeight: 'bold', letterSpacing: 0.5,
                textTransform: 'uppercase', color: OTA_STATUS_COLOR[lane],
                background: '#fafafa', borderBottom: '1px solid #eee', flexShrink: 0,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span>{lane} ({items.length})</span>
                {inactive.length > 0 && (
                  <button
                    disabled={busyId === 'all'}
                    title="Move every offline device in this column to the rejected lane"
                    onClick={() => setConfirmReject({ lane, ids: inactive.map(d => d.id) })}
                    style={{ fontSize: 10, border: '1px solid #000', background: '#ef4444', color: '#fff', cursor: 'pointer', padding: '1px 6px' }}
                  >Reject inactive ({inactive.length})</button>
                )}
                {rejectedCount > 0 && (
                  <button
                    disabled={busyId === 'all'}
                    onClick={() => setConfirmDeleteAll(rejectedCount)}
                    style={{ fontSize: 10, border: '1px solid #000', background: '#ef4444', color: '#fff', cursor: 'pointer', padding: '1px 6px' }}
                  >Delete all</button>
                )}
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
                {items.length === 0 && <div style={{ fontSize: 11, color: '#ccc', padding: 4 }}>—</div>}
                {items.map(dev => (
                  <DeviceCard
                    key={dev.id}
                    dev={dev}
                    lane={lane}
                    busy={busyId === dev.id}
                    onOpen={() => setSelectedId(dev.id)}
                    onDragStart={e => { e.dataTransfer.setData('text/plain', dev.id); e.dataTransfer.effectAllowed = 'move'; }}
                    onMove={dir => {
                      const target = BOARD_COLUMNS[i + dir];
                      if (target) void handleSet(dev.id, target);
                    }}
                    queryMode={queryMode}
                    onQueryClick={onQueryClick}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <DeviceModal
          device={selected}
          onClose={() => setSelectedId(null)}
          onSetTags={tags => setDeviceTags(selected.id, tags)}
          queryMode={queryMode}
          onQueryClick={onQueryClick}
        />
      )}

      {confirmDeleteAll !== null && (
        <ConfirmModal
          title="Delete rejected devices"
          message={`Delete ${confirmDeleteAll} rejected device(s)? Mock containers will be torn down. This cannot be undone.`}
          confirmLabel="Delete all"
          // Close the dialog at once and run the teardown in the background: the cards vanish
          // immediately (useDevices removes them optimistically) so the user can move on. If the
          // delete fails the hook rolls the rows back and we surface a toast — which shows even
          // if they've since switched tabs.
          onConfirm={() => {
            setConfirmDeleteAll(null);
            void deleteRejectedDevices().catch(e =>
              setToastError(`Couldn't delete all rejected devices: ${(e as Error).message}`),
            );
          }}
          onCancel={() => setConfirmDeleteAll(null)}
        />
      )}

      {confirmReject !== null && (
        <ConfirmModal
          title="Reject inactive devices"
          message={`Move ${confirmReject.ids.length} offline device(s) from ${confirmReject.lane} to rejected? Nothing is deleted — drag a card back to undo, or use "Delete all" on the rejected lane to remove them for good.`}
          confirmLabel="Reject inactive"
          onConfirm={() => {
            const { ids } = confirmReject;
            setConfirmReject(null);
            // Through runEnroll so the busy sentinel and the inline error banner behave like every
            // other action on this board; the cards move optimistically inside setEnrollmentBulk.
            void runEnroll('all', () => setEnrollmentBulk(ids, 'rejected'));
          }}
          onCancel={() => setConfirmReject(null)}
        />
      )}

      {toastError && <Toast message={toastError} onDismiss={() => setToastError(null)} />}
    </div>
  );
}
