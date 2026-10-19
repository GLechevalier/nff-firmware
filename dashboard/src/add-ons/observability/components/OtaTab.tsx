import { useEffect, useMemo, useRef, useState } from 'react';
import { BRAND_ACCENT } from '../../../lib/brand';
import type { FirmwareVersion } from '../data/mockFirmwareVersions';
import type { OtaJob, OtaStatus } from '../data/mockOtaJobs';
import type { Deployment, DeploymentStatus } from '../types/ota';
import { FirmwareDetail } from './FirmwareDetail';
import { useFirmware } from '../hooks/useFirmware';
import { useOtaJobs } from '../hooks/useOtaJobs';
import { useDevices } from '../hooks/useDevices';
import { useDeployments } from '../hooks/useDeployments';
import { useDeviceGroups } from '../hooks/useDeviceGroups';
import { useCurrentProject } from '../../../context/CurrentProjectContext';
import { useDemoOtaRollout } from '../hooks/useDemoOtaRollout';
import { isDemoDeploymentId } from '../../../data/babynffDemoGit';
import { TriggerUpdateModal } from './TriggerUpdateModal';
import { formatRelativeTime } from '../../../utils/time';
import type { Device } from '../../../types/device';
import { Queryable } from '../../../components/squeletton/Queryable';
import { StatusBadge } from './StatusBadge';
import type { OnQueryClick } from '../../../types/query';

const STATUS_LABEL: Record<OtaStatus, string> = {
  pending:             '○',
  downloading:         '▶',
  verifying:           '⧗',
  installing:          '⚙',
  rebooting:           '↻',
  committed:           '✓',
  success:             '✓',
  'already-installed': '=',
  failure:             '✗',
  rolled_back:         '↩',
  aborted:             '⊘',
  timed_out:           '✗',
  decommissioned:      '⌫',
};

const STATUS_COLOR: Record<OtaStatus, string> = {
  pending:             '#aaa',
  downloading:         '#1d4ed8',
  verifying:           '#d97706',
  installing:          '#d97706',
  rebooting:           '#d97706',
  committed:           '#22c55e',
  success:             '#22c55e',
  'already-installed': '#22c55e',
  failure:             '#ef4444',
  rolled_back:         '#f97316',
  aborted:             '#f97316',
  timed_out:           '#ef4444',
  decommissioned:      '#6b7280',
};

const DONE_STATUSES: OtaStatus[] = ['committed', 'success', 'already-installed', 'failure', 'rolled_back', 'aborted', 'timed_out', 'decommissioned'];

const DEP_COLOR: Record<DeploymentStatus, string> = {
  scheduled: '#d97706',
  active:    '#1d4ed8',
  paused:    '#6b7280',
  finished:  '#22c55e',
  aborted:   '#ef4444',
};

const ROLLOUT_OPTS = [5, 10, 25, 50, 100] as const;

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(2)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

function FirmwareRow({ fw, selected, onClick, queryMode, onQueryClick }: {
  fw: FirmwareVersion;
  selected: boolean;
  onClick: () => void;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}) {
  const shortSha = fw.checksumSha256 ? fw.checksumSha256.slice(0, 10) : null;
  const subject = `Firmware ${fw.version}`;
  const fwDetails = { buildId: fw.buildId };
  return (
    <div
      onClick={onClick}
      style={{
        padding: '8px 10px',
        borderBottom: '1px solid #eee',
        cursor: 'pointer',
        background: selected ? '#f5f5f5' : 'transparent',
        borderLeft: selected ? '3px solid #000' : '3px solid transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Version"
          value={fw.version}
          subject={subject}
          details={fwDetails}
          style={{ fontWeight: 'bold', fontSize: 13 }}
        >
          {fw.version}
        </Queryable>
        {fw.tag === 'latest' && (
          <Queryable
            queryMode={queryMode}
            onQueryClick={onQueryClick}
            field="Tag"
            value={fw.tag}
            subject={subject}
            details={fwDetails}
            style={{ fontSize: 9, background: '#000', color: '#fff', padding: '1px 5px', letterSpacing: 0.3 }}
          >
            LATEST
          </Queryable>
        )}
        {fw.tag === 'stable' && (
          <Queryable
            queryMode={queryMode}
            onQueryClick={onQueryClick}
            field="Tag"
            value={fw.tag}
            subject={subject}
            details={fwDetails}
            style={{ fontSize: 9, background: '#22c55e', color: '#fff', padding: '1px 5px', letterSpacing: 0.3 }}
          >
            STABLE
          </Queryable>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: fw.elfStored ? '#22c55e' : '#ccc' }}>
          {fw.elfStored ? 'ELF ✓' : 'ELF —'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#888' }}>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Committed"
          value={fw.committedAt.toISOString()}
          subject={subject}
          details={fwDetails}
        >
          {formatRelativeTime(fw.committedAt)}
        </Queryable>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Size"
          value={String(fw.size)}
          subject={subject}
          details={fwDetails}
        >
          {formatBytes(fw.size)}
        </Queryable>
      </div>
      {/* Artifact integrity: only present once a deployable binary has been uploaded */}
      {(shortSha || fw.signature) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
          {shortSha && (
            <Queryable
              queryMode={queryMode}
              onQueryClick={onQueryClick}
              field="Checksum"
              value={fw.checksumSha256 ?? ''}
              subject={subject}
              details={fwDetails}
              style={{ fontSize: 9, color: '#999' }}
            >
              sha256:{shortSha}
            </Queryable>
          )}
          <Queryable
            queryMode={queryMode}
            onQueryClick={onQueryClick}
            field="Signature"
            value={fw.signature ?? ''}
            subject={subject}
            details={fwDetails}
            style={{
              fontSize: 8, padding: '1px 4px', letterSpacing: 0.3,
              background: fw.signature ? '#22c55e' : '#e5e5e5',
              color: fw.signature ? '#fff' : '#999',
            }}
          >
            {fw.signature ? 'SIGNED' : 'UNSIGNED'}
          </Queryable>
        </div>
      )}
      <Queryable
        as="div"
        queryMode={queryMode}
        onQueryClick={onQueryClick}
        field="Changelog"
        value={fw.changelog.split('\n')[0]}
        subject={subject}
        details={fwDetails}
        style={{ fontSize: 11, color: '#aaa', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {fw.changelog.split('\n')[0]}
      </Queryable>
    </div>
  );
}

function JobRow({ job, deviceName, queryMode, onQueryClick }: {
  job: OtaJob;
  deviceName: string;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}) {
  const done = DONE_STATUSES.includes(job.status);
  const subject = `OTA ${job.deviceName}`;
  return (
    <div style={{ padding: '6px 10px', borderBottom: '1px solid #eee', opacity: done ? 0.65 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Status"
          value={job.status}
          subject={subject}
          style={{ fontSize: 13, color: STATUS_COLOR[job.status], fontWeight: 'bold', flexShrink: 0 }}
        >
          {STATUS_LABEL[job.status]}
        </Queryable>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Device"
          value={deviceName}
          subject={subject}
          style={{ fontSize: 12, fontWeight: 'bold', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {deviceName}
        </Queryable>
      </div>
      <div style={{ fontSize: 11, color: '#555', paddingLeft: 18, marginBottom: job.status === 'downloading' ? 4 : 0 }}>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="From Version"
          value={job.fromVersion}
          subject={subject}
        >
          {job.fromVersion}
        </Queryable>
        {' → '}
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Target Version"
          value={job.targetVersion}
          subject={subject}
        >
          {job.targetVersion}
        </Queryable>
      </div>
      {job.status === 'downloading' && (
        <div style={{ paddingLeft: 18, marginBottom: 4 }}>
          <div style={{ height: 4, background: '#e5e5e5', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', background: STATUS_COLOR.downloading, width: `${job.progress}%`, transition: 'width 0.3s' }} />
          </div>
          <Queryable
            as="div"
            queryMode={queryMode}
            onQueryClick={onQueryClick}
            field="Progress"
            value={String(job.progress)}
            subject={subject}
            style={{ fontSize: 10, color: '#888', marginTop: 1 }}
          >
            {job.progress}%
          </Queryable>
        </div>
      )}
      {job.status === 'verifying' && (
        <div style={{ paddingLeft: 18, fontSize: 11, color: STATUS_COLOR.verifying }}>Verifying…</div>
      )}
      {(job.status === 'rolled_back' || job.status === 'failure') && job.failureReason && (
        <Queryable
          as="div"
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Rollback reason"
          value={job.failureReason}
          subject={subject}
          style={{ paddingLeft: 18, fontSize: 11, color: STATUS_COLOR[job.status], marginTop: 1 }}
        >
          ↩ {job.failureReason}
        </Queryable>
      )}
      <Queryable
        as="div"
        queryMode={queryMode}
        onQueryClick={onQueryClick}
        field={job.completedAt ? 'Completed' : 'Started'}
        value={(job.completedAt ?? job.startedAt).toISOString()}
        subject={subject}
        style={{ fontSize: 10, color: '#bbb', paddingLeft: 18 }}
      >
        {job.completedAt ? formatRelativeTime(job.completedAt) : formatRelativeTime(job.startedAt)}
      </Queryable>
    </div>
  );
}

function DeploymentRow({ dep, total, done, onAbort, hideAbort, highlighted, innerRef, queryMode, onQueryClick }: {
  dep: Deployment;
  total: number;
  done: number;
  onAbort: () => void;
  // The break/heal demo deploys are synthetic — there is nothing to abort, so hide the button.
  hideAbort?: boolean;
  highlighted?: boolean;
  innerRef?: (el: HTMLDivElement | null) => void;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const canAbort = !hideAbort && (dep.status === 'scheduled' || dep.status === 'active');
  const subject = `Deployment ${dep.name}`;
  const depDetails = { maxDevicesInFlight: String(dep.maxDevicesInFlight) };
  return (
    <div
      ref={innerRef}
      style={{
        padding: '6px 10px',
        borderBottom: '1px solid #eee',
        background: highlighted ? '#eef4ff' : 'transparent',
        borderLeft: highlighted ? '3px solid #1d4ed8' : '3px solid transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Status"
          value={dep.status}
          subject={subject}
          details={depDetails}
          style={{
            fontSize: 9, padding: '1px 5px', letterSpacing: 0.3,
            background: DEP_COLOR[dep.status], color: '#fff', textTransform: 'uppercase', flexShrink: 0,
          }}
        >
          {dep.status}
        </Queryable>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Target Version"
          value={dep.targetVersion}
          subject={subject}
          details={depDetails}
          style={{ fontSize: 12, fontWeight: 'bold', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          v{dep.targetVersion}
        </Queryable>
        {canAbort && (
          <button
            onClick={onAbort}
            style={{ fontSize: 10, border: 'none', background: 'none', color: '#ef4444', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
          >
            abort
          </button>
        )}
      </div>
      <Queryable
        as="div"
        queryMode={queryMode}
        onQueryClick={onQueryClick}
        field="Name"
        value={dep.name}
        subject={subject}
        details={depDetails}
        style={{ fontSize: 10, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}
      >
        {dep.name}
      </Queryable>
      {dep.haltedReason && (dep.status === 'paused' || dep.status === 'aborted') && (
        <div style={{ fontSize: 10, color: dep.status === 'paused' ? '#b45309' : '#ef4444', marginBottom: 3 }}>
          {dep.haltedReason.startsWith('declined') ? '⊘ declined — rate-limited' : `⏸ ${dep.haltedReason}`}
        </div>
      )}
      {total > 0 && (
        <div style={{ height: 4, background: '#e5e5e5', borderRadius: 2, overflow: 'hidden', marginBottom: 2 }}>
          <div style={{ height: '100%', background: DEP_COLOR[dep.status], width: `${pct}%`, transition: 'width 0.3s' }} />
        </div>
      )}
      <div style={{ fontSize: 10, color: '#bbb' }}>
        {done}/{total} done · {formatRelativeTime(dep.createdAt)}
      </div>
    </div>
  );
}

type CardState = 'active' | 'queued' | 'excluded' | 'done';

const CARD_BG: Record<CardState, { rest: string; hover: string }> = {
  active:   { rest: '#111',    hover: '#333'    },
  queued:   { rest: '#d4d4d4', hover: '#c0c0c0' },
  excluded: { rest: '#f8f8f8', hover: '#efefef' },
  done:     { rest: '#e8e8e8', hover: '#e8e8e8' },
};

const CARD_INK: Record<CardState, { id: string; version: string; sub: string }> = {
  active:   { id: '#ccc',  version: '#fff', sub: '#888' },
  queued:   { id: '#666',  version: '#111', sub: '#555' },
  excluded: { id: '#bbb',  version: '#aaa', sub: '#bbb' },
  done:     { id: '#999',  version: '#999', sub: '#aaa' },
};

function DeviceSquare({ dev, targetVersion, isChecked, isActive, alreadyOn, onToggle }: {
  dev: Device;
  targetVersion: string;
  isChecked: boolean;
  isActive: boolean;
  alreadyOn: boolean;
  onToggle: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const state: CardState = alreadyOn ? 'done' : isActive ? 'active' : isChecked ? 'queued' : 'excluded';
  const bg  = hovered && !alreadyOn ? CARD_BG[state].hover : CARD_BG[state].rest;
  const ink = CARD_INK[state];
  const notAccepted = dev.otaStatus !== 'accepted';

  return (
    <div
      onClick={alreadyOn ? undefined : onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={notAccepted ? `ota_status: ${dev.otaStatus} — will be skipped by the backend` : undefined}
      style={{
        width: 82,
        flexShrink: 0,
        borderRadius: 0,
        padding: '5px 6px',
        minHeight: 66,
        cursor: alreadyOn ? 'default' : 'pointer',
        userSelect: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        background: bg,
        border: '1px solid rgba(0,0,0,0.12)',
        opacity: notAccepted ? 0.55 : 1,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 9, fontWeight: 'bold', color: ink.id, letterSpacing: 0.2 }}>
          ID = {dev.id}
        </span>
        <span style={{ flexShrink: 0, display: 'inline-flex', transform: 'scale(0.7)', transformOrigin: 'center right' }}>
          <StatusBadge status={dev.status} deviceId={dev.id} />
        </span>
      </div>
      <div style={{ fontSize: 10, fontWeight: 'bold', color: ink.version, textDecoration: alreadyOn ? 'line-through' : 'none' }}>
        {dev.firmwareVersion}
      </div>
      {!alreadyOn && (
        <div style={{ fontSize: 9, color: ink.sub }}>
          ↑ {targetVersion}
        </div>
      )}
      {alreadyOn && (
        <div style={{ fontSize: 8, color: ink.sub, letterSpacing: 0.2 }}>CURRENT</div>
      )}
    </div>
  );
}

export function OtaTab({ focusDeploymentId, queryMode, onQueryClick, onShipped, compact = false }: {
  focusDeploymentId?: string | null;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
  // Only the Deployments + OTA jobs column, full width — the demo's brain side panel
  // mounts it this way (the firmware list and release pane pin 500px otherwise).
  compact?: boolean;
  /** The user rolled an update out from the Trigger-update modal (drives the Deploy walkthrough). */
  onShipped?: (deploymentId: string) => void;
} = {}) {
  const { versions, uploadFirmware } = useFirmware();
  const { jobs: realJobs }          = useOtaJobs();
  const { devices }                 = useDevices();
  const { deployments: realDeployments, createDeployment, abortDeployment } = useDeployments();
  const { groups, createGroup }     = useDeviceGroups();
  const { currentProjectId }        = useCurrentProject();

  // The break demo ships a bad commit to the fleet and the agent heals it, but api/_selfheal.ts and
  // submit_firmware_fix write no deployments or ota_jobs. Without this the Deploy tab shows nothing
  // arriving — neither the break nor the fix. Derived, never persisted (writing a real
  // firmware_versions row would contend for that table's global `version` PK), and gated on the
  // bundled demo repo, so a project with a real repo never sees it.
  const demoRollout = useDemoOtaRollout();
  // Merged newest-first, the order useDeployments returns — so the fix deploy (newer) sorts above
  // the break, and any real deployment sorts by its own time.
  const deployments = useMemo(
    () => [...demoRollout.deployments, ...realDeployments].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    [demoRollout.deployments, realDeployments],
  );
  const jobs = useMemo(
    () => [...demoRollout.jobs, ...realJobs],
    [demoRollout.jobs, realJobs],
  );
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [selectedFw, setSelectedFw] = useState<FirmwareVersion | null>(null);
  const [centerView, setCenterView] = useState<'deploy' | 'details'>('deploy');
  const [activityOpen, setActivityOpen] = useState(false);
  const focusedRowRef               = useRef<HTMLDivElement | null>(null);

  // When opened from the GitHub tab with a deployment to focus, reveal the
  // activity column and scroll the deployment into view.
  useEffect(() => {
    if (!focusDeploymentId) return;
    setActivityOpen(true);
    if (focusedRowRef.current) {
      focusedRowRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusDeploymentId, deployments.length, activityOpen]);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [rolloutPct, setRolloutPct] = useState<typeof ROLLOUT_OPTS[number]>(100);
  const [targetGroupId, setTargetGroupId] = useState<string>(''); // '' = ad-hoc selection
  const [deploying, setDeploying]   = useState(false);
  const [deployMsg, setDeployMsg]   = useState<string | null>(null);

  // Firmware upload (left panel). Any file becomes a deployable artifact: a binary/ELF runs
  // the OTA flow + bumps the version; a .json/.yaml sketch additionally changes mock behaviour.
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadVersion, setUploadVersion] = useState('1.1.0');
  const [uploadName, setUploadName] = useState('');
  const [uploadDeviceTypes, setUploadDeviceTypes] = useState('esp32');
  const [uploading, setUploading]   = useState(false);
  const [uploadMsg, setUploadMsg]   = useState<string | null>(null);

  async function doUpload() {
    if (!uploadFile || uploading) return;
    setUploading(true);
    setUploadMsg(null);
    try {
      await uploadFirmware(uploadFile, {
        version: uploadVersion.trim(),
        name: uploadName.trim() || undefined,
        deviceTypes: uploadDeviceTypes.split(',').map(s => s.trim()).filter(Boolean),
      });
      setUploadMsg(`Uploaded v${uploadVersion.trim()} — select it and Push OTA.`);
      setUploadFile(null);
    } catch (e) {
      setUploadMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  }

  useEffect(() => {
    if (versions.length > 0) setSelectedFw(prev => prev ?? versions[0]);
  }, [versions]);

  useEffect(() => {
    if (devices.length > 0 && checkedIds.size === 0) {
      setCheckedIds(new Set(devices.map(d => d.id)));
    }
  }, [devices, checkedIds.size]);

  // Per-deployment job rollup, derived from the live ota_jobs subscription.
  const jobsByDeployment = new Map<string, OtaJob[]>();
  for (const job of jobs) {
    if (!job.deploymentId) continue;
    const arr = jobsByDeployment.get(job.deploymentId) ?? [];
    arr.push(job);
    jobsByDeployment.set(job.deploymentId, arr);
  }
  const deviceNameById = new Map(devices.map(d => [d.id, d.name]));

  function toggleDevice(id: string) {
    setCheckedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (checkedIds.size === devices.length) setCheckedIds(new Set());
    else setCheckedIds(new Set(devices.map(d => d.id)));
  }

  const checkedDevices  = devices.filter(d => checkedIds.has(d.id));
  const activeCount     = Math.max(1, Math.ceil(checkedDevices.length * rolloutPct / 100));
  const activeDevices   = checkedDevices.slice(0, activeCount);
  const activeDeviceIds = new Set(activeDevices.map(d => d.id));
  const usingGroup      = targetGroupId !== '';
  const canPush         = selectedFw !== null && !deploying && (usingGroup || activeDevices.length > 0);

  async function pushOta() {
    if (!selectedFw || deploying) return;
    setDeploying(true);
    setDeployMsg(null);
    try {
      let groupId = targetGroupId;
      let label: string;
      let inFlight: number;
      if (usingGroup) {
        label = groups.find(g => g.id === groupId)?.name ?? 'group';
        inFlight = 10;
      } else {
        // Build an ad-hoc group from the rollout-selected devices. The backend then
        // targets only the group members that are ota_status='accepted'.
        const groupName = `deploy-${selectedFw.version}-${Date.now()}`;
        groupId = await createGroup(groupName, activeDevices.map(d => d.id));
        label = groupName;
        inFlight = Math.max(1, activeDevices.length);
      }
      await createDeployment({
        name: `OTA ${selectedFw.version} → ${label}`,
        targetVersion: selectedFw.version,
        deviceGroupId: groupId,
        maxDevicesInFlight: inFlight,
      });
      setDeployMsg('Deployment scheduled — the backend will begin delivery within ~15s.');
    } catch (e) {
      setDeployMsg(`Failed: ${(e as Error).message}`);
    } finally {
      setDeploying(false);
    }
  }

  const panelHeader: React.CSSProperties = {
    padding: '4px 8px',
    borderBottom: '1px solid #000',
    fontSize: 12,
    fontWeight: 'bold',
    flexShrink: 0,
  };

  return (
    <div style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}>

      {/* Left: firmware binary list */}
      <div style={{ width: 220, flexShrink: 0, display: compact ? 'none' : 'flex', flexDirection: 'column', borderRight: '1px solid #000', overflow: 'hidden' }}>
        <div style={{ ...panelHeader, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Firmware</span>
          <button
            onClick={() => { setUploadOpen(o => !o); setUploadMsg(null); }}
            title="Upload a firmware artifact"
            style={{
              fontSize: 11, fontWeight: 'bold',
              border: '1px solid #000', background: uploadOpen ? '#000' : '#fff',
              color: uploadOpen ? '#fff' : '#000', cursor: 'pointer', padding: '1px 7px',
            }}
          >
            {uploadOpen ? '×' : '＋ Upload'}
          </button>
        </div>
        {uploadOpen && (
          <div style={{ borderBottom: '1px solid #000', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
            <label style={{ fontSize: 10, color: '#666' }}>
              Artifact (any file)
            </label>
            <input
              type="file"
              onChange={e => { setUploadFile(e.target.files?.[0] ?? null); setUploadMsg(null); }}
              style={{ fontSize: 10 }}
            />
            <div style={{ fontSize: 9, color: '#aaa', lineHeight: 1.4 }}>
              binary/ELF → OTA + version bump · .json/.yaml sketch → visible behaviour change
            </div>
            <input
              value={uploadVersion}
              onChange={e => setUploadVersion(e.target.value)}
              placeholder="version (semver, e.g. 1.1.0)"
              style={{ fontSize: 11, padding: '3px 4px', border: '1px solid #000' }}
            />
            <input
              value={uploadName}
              onChange={e => setUploadName(e.target.value)}
              placeholder="name (optional)"
              style={{ fontSize: 11, padding: '3px 4px', border: '1px solid #000' }}
            />
            <input
              value={uploadDeviceTypes}
              onChange={e => setUploadDeviceTypes(e.target.value)}
              placeholder="device_types (comma-sep)"
              style={{ fontSize: 11, padding: '3px 4px', border: '1px solid #000' }}
            />
            <button
              onClick={doUpload}
              disabled={!uploadFile || !uploadVersion.trim() || uploading}
              style={{
                padding: '5px 0', background: (!uploadFile || !uploadVersion.trim() || uploading) ? '#ccc' : '#000',
                color: '#fff', border: 'none', cursor: (!uploadFile || !uploadVersion.trim() || uploading) ? 'default' : 'pointer',
                fontSize: 12, fontWeight: 'bold',
              }}
            >
              {uploading ? 'Uploading…' : 'Upload'}
            </button>
            {uploadMsg && (
              <div style={{ fontSize: 10, color: uploadMsg.startsWith('Failed') ? '#ef4444' : '#22c55e', lineHeight: 1.4 }}>
                {uploadMsg}
              </div>
            )}
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {versions.map(fw => (
            <FirmwareRow
              key={fw.version}
              fw={fw}
              selected={selectedFw?.version === fw.version}
              onClick={() => setSelectedFw(fw)}
              queryMode={queryMode}
              onQueryClick={onQueryClick}
            />
          ))}
        </div>
      </div>

      {/* Center: firmware details + deploy controls */}
      <div style={{ flex: 1, minWidth: 0, display: compact ? 'none' : 'flex', flexDirection: 'column', borderRight: '1px solid #000', overflow: 'hidden' }}>
        <div style={{ ...panelHeader, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedFw ? `v${selectedFw.version}` : 'Release'}
          </span>
          {/* Outside the `selectedFw` guard on purpose: a fresh project has no firmware at all,
              and shipping to a group is exactly how it gets its first release. */}
          <button
            data-tour="ota-trigger"
            onClick={() => setTriggerOpen(true)}
            title="Roll a release out to a device group"
            style={{ fontSize: 11, fontWeight: 'bold', border: '1px solid #000', background: BRAND_ACCENT, color: '#fff', cursor: 'pointer', padding: '1px 8px', flexShrink: 0 }}
          >
            ⇪ Trigger update
          </button>
          {selectedFw && (
            <div style={{ display: 'flex', flexShrink: 0 }}>
              {(['deploy', 'details'] as const).map((view, i) => (
                <button
                  key={view}
                  onClick={() => setCenterView(view)}
                  style={{
                    fontSize: 11, fontWeight: 'bold',
                    border: '1px solid #000', borderLeft: i === 0 ? '1px solid #000' : 'none',
                    background: centerView === view ? '#000' : '#fff',
                    color:      centerView === view ? '#fff' : '#000',
                    cursor: 'pointer', padding: '1px 8px', textTransform: 'capitalize',
                  }}
                >
                  {view}
                </button>
              ))}
            </div>
          )}
        </div>
        {!selectedFw ? (
          <div style={{ padding: 16, color: '#aaa', fontSize: 13 }}>Select a firmware version</div>
        ) : centerView === 'details' ? (
          <FirmwareDetail fw={selectedFw} onDeploy={() => setCenterView('deploy')} queryMode={queryMode} onQueryClick={onQueryClick} />
        ) : (
          <>
            {/* Device canvas */}
            <div style={{ display: 'flex', gap: 12, padding: '4px 10px 6px', borderBottom: '1px solid #eee', flexShrink: 0, alignItems: 'center' }}>
              <button
                onClick={toggleAll}
                disabled={usingGroup}
                style={{ fontSize: 11, border: 'none', background: 'none', cursor: usingGroup ? 'default' : 'pointer', color: usingGroup ? '#ccc' : '#555', padding: 0, textDecoration: 'underline' }}
              >
                {checkedIds.size === devices.length ? 'None' : 'All'}
              </button>
              <span style={{ fontSize: 11, color: '#aaa' }}>
                {usingGroup
                  ? `targeting group "${groups.find(g => g.id === targetGroupId)?.name ?? ''}"`
                  : `${activeDevices.length} of ${devices.length} will receive OTA`}
              </span>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignContent: 'flex-start', opacity: usingGroup ? 0.4 : 1, pointerEvents: usingGroup ? 'none' : 'auto' }}>
              {devices.map((dev) => (
                <DeviceSquare
                  key={dev.id}
                  dev={dev}
                  targetVersion={selectedFw.version}
                  isChecked={checkedIds.has(dev.id)}
                  isActive={activeDeviceIds.has(dev.id)}
                  alreadyOn={dev.firmwareVersion === selectedFw.version}
                  onToggle={() => toggleDevice(dev.id)}
                />
              ))}
            </div>

            {/* Target + rollout + push */}
            <div style={{ flexShrink: 0, borderTop: '1px solid #ddd', padding: '10px 12px' }}>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 6 }}>Target</div>
              <select
                value={targetGroupId}
                onChange={e => setTargetGroupId(e.target.value)}
                style={{ width: '100%', fontSize: 12, padding: '3px 4px', marginBottom: 12, border: '1px solid #000' }}
              >
                <option value="">Selected devices (ad-hoc group)</option>
                {groups.map(g => (
                  <option key={g.id} value={g.id}>{g.name} ({g.memberCount})</option>
                ))}
              </select>

              {!usingGroup && (
                <>
                  <div style={{ fontSize: 11, color: '#666', marginBottom: 6 }}>Rollout percentage</div>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                    {ROLLOUT_OPTS.map(pct => (
                      <button
                        key={pct}
                        onClick={() => setRolloutPct(pct)}
                        style={{
                          fontSize: 12, fontWeight: 'bold',
                          border: '1px solid #000',
                          background: rolloutPct === pct ? '#000' : '#fff',
                          color:      rolloutPct === pct ? '#fff' : '#000',
                          cursor: 'pointer',
                          padding: '2px 8px',
                        }}
                      >
                        {pct}%
                      </button>
                    ))}
                  </div>
                </>
              )}
              <button
                onClick={pushOta}
                disabled={!canPush}
                style={{
                  width: '100%', padding: '6px 0',
                  background: canPush ? '#000' : '#ccc',
                  color: '#fff', border: 'none', cursor: canPush ? 'pointer' : 'default',
                  fontSize: 13, fontWeight: 'bold',
                  letterSpacing: 0.3,
                }}
              >
                {deploying
                  ? 'Scheduling…'
                  : usingGroup
                    ? 'Push OTA to group'
                    : `Push OTA to ${activeDevices.length} device${activeDevices.length !== 1 ? 's' : ''}`}
              </button>
              {deployMsg && (
                <div style={{ fontSize: 10, color: deployMsg.startsWith('Failed') ? '#ef4444' : '#666', marginTop: 6 }}>
                  {deployMsg}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Right: deployments + job list — collapsible to reclaim horizontal space */}
      {(activityOpen || compact) ? (
        <div style={{ width: compact ? '100%' : 280, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ ...panelHeader, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Deployments</span>
            {!compact && <button
              onClick={() => setActivityOpen(false)}
              title="Collapse activity"
              style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px', color: '#000' }}
            >
              ›
            </button>}
          </div>
          <div style={{ flex: '0 0 40%', overflowY: 'auto', borderBottom: '1px solid #000' }}>
            {deployments.length === 0 && (
              <div style={{ padding: 10, fontSize: 11, color: '#aaa' }}>No deployments yet</div>
            )}
            {deployments.map(dep => {
              const depJobs = jobsByDeployment.get(dep.id) ?? [];
              const done = depJobs.filter(j => DONE_STATUSES.includes(j.status)).length;
              const isFocused = focusDeploymentId === dep.id;
              return (
                <DeploymentRow
                  key={dep.id}
                  dep={dep}
                  total={depJobs.length}
                  done={done}
                  onAbort={() => { if (!isDemoDeploymentId(dep.id)) void abortDeployment(dep.id); }}
                  hideAbort={isDemoDeploymentId(dep.id)}
                  highlighted={isFocused}
                  innerRef={isFocused ? (el) => { focusedRowRef.current = el; } : undefined}
                  queryMode={queryMode}
                  onQueryClick={onQueryClick}
                />
              );
            })}
          </div>
          <div style={panelHeader}>OTA Jobs</div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {jobs.map(job => (
              <JobRow key={job.id} job={job} deviceName={deviceNameById.get(job.deviceId) ?? job.deviceName} queryMode={queryMode} onQueryClick={onQueryClick} />
            ))}
          </div>
        </div>
      ) : (
        <button
          onClick={() => setActivityOpen(true)}
          title="Show deployment activity"
          style={{
            width: 30, flexShrink: 0, borderLeft: '1px solid #000', background: '#fff',
            cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: 10, padding: '8px 0', fontSize: 11, color: '#000',
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1 }}>‹</span>
          <span style={{ writingMode: 'vertical-rl', letterSpacing: 1, fontWeight: 'bold' }}>
            Activity{deployments.length > 0 ? ` (${deployments.length})` : ''}
          </span>
        </button>
      )}

      {triggerOpen && currentProjectId && (
        <TriggerUpdateModal
          groups={groups}
          versions={versions}
          projectId={currentProjectId}
          uploadFirmware={uploadFirmware}
          createDeployment={createDeployment}
          onShipped={onShipped}
          onClose={() => { setTriggerOpen(false); setActivityOpen(true); }}
        />
      )}
    </div>
  );
}
