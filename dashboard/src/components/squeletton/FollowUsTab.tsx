import type React from 'react';
import QRCode from 'react-qr-code';

const X_URL = 'https://x.com/max_ysh';
const X_HANDLE = '@max_ysh';
const REPO_URL = 'https://github.com/GLechevalier/nff-core';
const REPO_LABEL = 'GLechevalier/nff-core';
const QR_SIZE = 220;
const LOGO_SIZE = 48;

const panelHeader: React.CSSProperties = {
  padding: '4px 8px',
  borderBottom: '1px solid #000',
  fontSize: 12,
  fontWeight: 'bold',
  flexShrink: 0,
};

const card: React.CSSProperties = {
  border: '1px solid #000',
  background: '#fff',
  boxShadow: '2px 2px 0 #ddd',
  marginBottom: 12,
};

// X (formerly Twitter) logo, rendered black to match the monospace theme.
function XMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1200 1227" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        fill="#000"
        d="M714.163 519.284 1160.89 0h-105.86L667.137 450.887 357.328 0H0l468.492 681.821L0 1226.37h105.866l409.625-476.152 327.181 476.152H1200L714.137 519.284h.026ZM569.165 687.828l-47.468-67.894-377.686-540.24h162.604l304.797 435.991 47.468 67.894 396.2 566.721H892.476L569.165 687.854v-.026Z"
      />
    </svg>
  );
}

// Official GitHub "mark" (octocat), rendered black to match the monospace theme.
function GithubMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 98 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="#000"
        d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.301-6.356 13.426-5.052 13.426-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z"
      />
    </svg>
  );
}

function QrCard({ caption, url, label, logo }: { caption: string; url: string; label: string; logo?: 'github' | 'x' }) {
  return (
    <div style={{ ...card, width: 300, padding: 20, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
      <div style={{ fontSize: 12, color: '#666', textAlign: 'center' }}>{caption}</div>
      <div style={{ background: '#fff', padding: 12, border: '1px solid #000' }}>
        <div style={{ position: 'relative', width: QR_SIZE, height: QR_SIZE }}>
          {/* When a centered logo sits over the QR, level H (30% recovery) keeps it scannable. */}
          <QRCode value={url} size={QR_SIZE} bgColor="#fff" fgColor="#000" level={logo ? 'H' : 'M'} />
          {logo && (
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                background: '#fff',
                padding: 4,
                display: 'flex',
              }}
            >
              {logo === 'github' ? <GithubMark size={LOGO_SIZE} /> : <XMark size={LOGO_SIZE} />}
            </div>
          )}
        </div>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ fontSize: 14, fontWeight: 'bold', color: '#1d4ed8', textDecoration: 'none' }}
      >
        {label}
      </a>
    </div>
  );
}

export function FollowUsTab() {
  return (
    <div style={{ flex: 1, minWidth: 0, height: '100%', overflowY: 'auto' }}>
      <div style={panelHeader}>Follow us</div>
      <div style={{ padding: 12, display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center' }}>
        <QrCard caption="Scan to follow us on X" url={X_URL} label={X_HANDLE} logo="x" />
        <QrCard caption="Scan to star us on GitHub" url={REPO_URL} label={REPO_LABEL} logo="github" />
      </div>
    </div>
  );
}
