import type { FirmwareVersion } from '../data/mockFirmwareVersions';
import { useDevices } from '../hooks/useDevices';
import { StatusBadge } from './StatusBadge';
import { CopyButton } from '../../../components/squeletton/CopyButton';
import { formatRelativeTime } from '../../../utils/time';
import { Queryable } from '../../../components/squeletton/Queryable';
import type { OnQueryClick } from '../../../types/query';

export function branchColor(name: string | null): string {
  if (!name || name === 'main') return '#000';
  if (name.startsWith('hotfix')) return '#ef4444';
  if (name.startsWith('feature')) return '#1d4ed8';
  return '#888';
}

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(2)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

/**
 * Version detail (metadata, changelog, devices on version) for a firmware
 * release. Extracted from the former Firmware tab so the Releases (OTA) view
 * can show it inline without a duplicate firmware list.
 */
export function FirmwareDetail({ fw, onDeploy, queryMode, onQueryClick }: {
  fw: FirmwareVersion;
  onDeploy?: () => void;
  queryMode?: boolean;
  onQueryClick?: OnQueryClick;
}) {
  const { devices } = useDevices();
  const devicesOnVersion = devices.filter(d => d.firmwareVersion === fw.version);
  const subject = `Firmware ${fw.version}`;
  const fwDetails = { buildId: fw.buildId };

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20 }}>
      {/* Version heading */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
        <Queryable
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Version"
          value={fw.version}
          subject={subject}
          details={fwDetails}
          style={{ fontSize: 22, fontWeight: 'bold' }}
        >
          v{fw.version}
        </Queryable>
        {fw.branchName !== 'main' && (
          <Queryable
            queryMode={queryMode}
            onQueryClick={onQueryClick}
            field="Branch"
            value={fw.branchName}
            subject={subject}
            details={fwDetails}
            style={{
              fontSize: 11, border: `1px solid ${branchColor(fw.branchName)}`,
              color: branchColor(fw.branchName), padding: '2px 7px',
            }}
          >
            {fw.branchName}
          </Queryable>
        )}
        {fw.tag === 'latest' && (
          <Queryable
            queryMode={queryMode}
            onQueryClick={onQueryClick}
            field="Tag"
            value={fw.tag}
            subject={subject}
            details={fwDetails}
            style={{ fontSize: 11, background: '#000', color: '#fff', padding: '2px 7px' }}
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
            style={{ fontSize: 11, background: '#22c55e', color: '#fff', padding: '2px 7px' }}
          >
            STABLE
          </Queryable>
        )}
      </div>

      {/* Metadata */}
      <table style={{ borderCollapse: 'collapse', marginBottom: 18, fontSize: 12 }}>
        <tbody>
          {([
            ['Build ID',  fw.buildId],
            ['Author',    fw.author],
            ['Committed', formatRelativeTime(fw.committedAt) + ' — ' + fw.committedAt.toLocaleDateString()],
            ['Size',      formatBytes(fw.size)],
            ['ELF file',  fw.elfStored ? 'Stored — backtrace resolution available' : 'Not stored — upload ELF to enable backtrace'],
          ] as [string, string][]).map(([k, v]) => (
            <tr key={k}>
              <td style={{ paddingRight: 16, paddingBottom: 4, color: '#888', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{k}</td>
              <Queryable
                as="td"
                queryMode={queryMode}
                onQueryClick={onQueryClick}
                field={k}
                value={v}
                subject={subject}
                details={fwDetails}
                style={{ paddingBottom: 4, color: fw.elfStored && k === 'ELF file' ? '#22c55e' : !fw.elfStored && k === 'ELF file' ? '#d97706' : '#000' }}
              >
                {v}
              </Queryable>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Changelog */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, fontWeight: 'bold', color: '#555', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Changelog</span>
          <CopyButton variant="icon" title="Copy changelog" value={fw.changelog} />
        </div>
        <Queryable
          as="div"
          queryMode={queryMode}
          onQueryClick={onQueryClick}
          field="Changelog"
          value={fw.changelog.split('\n')[0]}
          subject={subject}
          details={fwDetails}
        >
          <pre style={{
            fontSize: 12, lineHeight: 1.7,
            background: '#f5f5f5', padding: '10px 12px',
            margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            border: '1px solid #e5e5e5',
          }}>
            {fw.changelog}
          </pre>
        </Queryable>
      </div>

      {/* Devices on this version */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 'bold', color: '#555', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
          Devices on this version ({devicesOnVersion.length})
        </div>
        {devicesOnVersion.length === 0 ? (
          <div style={{ fontSize: 12, color: '#aaa' }}>No devices currently on this version</div>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
            <tbody>
              {devicesOnVersion.map(dev => (
                <tr key={dev.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                  <Queryable
                    as="td"
                    queryMode={queryMode}
                    onQueryClick={onQueryClick}
                    field="Status"
                    value={dev.status}
                    subject={`Device ${dev.name}`}
                    style={{ padding: '5px 0', paddingRight: 12 }}
                  >
                    <StatusBadge status={dev.status} deviceId={dev.id} />
                  </Queryable>
                  <Queryable
                    as="td"
                    queryMode={queryMode}
                    onQueryClick={onQueryClick}
                    field="Device"
                    value={dev.name}
                    subject={`Device ${dev.name}`}
                    style={{ padding: '5px 0', paddingRight: 12, fontWeight: 'bold' }}
                  >
                    {dev.name}
                  </Queryable>
                  <Queryable
                    as="td"
                    queryMode={queryMode}
                    onQueryClick={onQueryClick}
                    field="IP Address"
                    value={dev.ipAddress}
                    subject={`Device ${dev.name}`}
                    style={{ padding: '5px 0', color: '#888', fontSize: 11 }}
                  >
                    {dev.ipAddress}
                  </Queryable>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {onDeploy && (
          <button
            onClick={onDeploy}
            style={{
              marginTop: 12, fontSize: 12,
              border: '1px solid #000', background: 'none', cursor: 'pointer',
              padding: '4px 14px',
            }}
          >
            Deploy this version →
          </button>
        )}
      </div>
    </div>
  );
}
