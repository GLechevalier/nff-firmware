import type { ReactNode } from 'react';

// Identifier for a connector's inline-SVG logo. Kept as the single source of
// truth for the `Tool.icon` union so the dashboard hook and the management graph
// can't drift apart. White-fill silhouettes, sized to sit on a colored chip
// (the same treatment as the original GitHub badge).
export type ConnectorIconKey =
  | 'github'
  | 'esp-rainmaker'
  | 'golioth'
  | 'edge-impulse'
  | 'memfault'
  | 'mender';

// One monochrome (white-fill) mark per connector, drawn on a 24×24 viewBox so it
// renders cleanly on the accent chip used by the menu list and the node badge.
// The five new marks are simplified, brand-evocative glyphs — refine against the
// real brand assets later. `currentColor`/white fill is inherited from the chip.
export const CONNECTOR_LOGOS: Record<ConnectorIconKey, ReactNode> = {
  // GitHub Octocat — same path used by the existing node badge.
  github: (
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
  ),
  // ESP RainMaker — Wi-Fi arcs over a device dot (Espressif/ESP32 cloud).
  'esp-rainmaker': (
    <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 9.5a11 11 0 0 1 16 0" />
      <path d="M7 13a7 7 0 0 1 10 0" />
      <circle cx="12" cy="17.5" r="1.4" fill="currentColor" stroke="none" />
    </g>
  ),
  // Golioth — bold "G" ring (Zephyr/MCU cloud).
  golioth: (
    <path d="M12 3a9 9 0 1 0 8.5 12H12v-3.4h8.9c.07.46.1.93.1 1.4A9 9 0 0 1 12 3zm0 3.2a5.8 5.8 0 0 0-5.6 7.3l3.1-.85A2.6 2.6 0 0 1 12 9.4c.6 0 1.16.2 1.6.55l2.3-2.3A5.78 5.78 0 0 0 12 6.2z" />
  ),
  // Edge Impulse — a pulse/heartbeat waveform (TinyML signal).
  'edge-impulse': (
    <path d="M2 12h4l2.5-6 4 13L16 9l1.6 3H22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  ),
  // Memfault — stylized "M" peaks (embedded observability).
  memfault: (
    <path d="M3 20V5l5 7 4-5 4 5 5-7v15h-3.2v-7.2L14 17l-2-2.6L10 17l-3.8-4.2V20z" />
  ),
  // Mender — abstract bird/arrow mark (OTA with rollback).
  mender: (
    <path d="M3 12c5 .4 8.3-1.2 10.5-5.5C13 11 15 13 21 12c-4.8 1.2-7 3.5-8.4 7.5C11.5 14.6 8.5 12.6 3 12z" />
  ),
};

// Renders a connector logo. Intended on a colored chip; defaults to white fill so
// the silhouette reads against the accent background.
export function ConnectorLogo({ icon, size = 16, color = '#fff' }: { icon: ConnectorIconKey; size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} style={{ fill: color, color, flexShrink: 0 }} aria-hidden>
      {CONNECTOR_LOGOS[icon]}
    </svg>
  );
}

export type ConnectorDirection = 'undirected' | 'inbound' | 'outbound' | 'bidirectional';

export interface ConnectorDef {
  name: string;
  description: string;
  accent: string;
  icon: ConnectorIconKey;
  direction: ConnectorDirection;
}

// The curated set of connectors the agent may hook. GitHub is the one with a
// real backend today (nff-github: webhooks → build → OTA rollout, fix PRs,
// connect/disconnect/deploy-policy via api/github.ts); the five externals are
// UI/config-layer only — selecting one adds a Tool node to the graph +
// agent_config.tools; their backend wiring is the separate nff-connect work
// (docs/Potential connectors.md). Keep the GitHub `name` in sync with
// AgentManagementTab's SERVICE_BY_TOOL key — that binding drives its live
// heartbeat status. Accents are brand approximations.
export const CONNECTOR_CATALOG: ConnectorDef[] = [
  { name: 'GitHub Connector', description: 'Push-to-deploy for firmware repos: webhook builds roll out via nff-ota; fix PRs on failure', accent: '#1f6feb', icon: 'github', direction: 'bidirectional' },
  { name: 'ESP RainMaker', description: 'Espressif ESP32 cloud: device management + OTA',       accent: '#E7352C', icon: 'esp-rainmaker', direction: 'bidirectional' },
  { name: 'Golioth',       description: 'Zephyr/MCU cloud: OTA w/ rollback, RPC, logging',       accent: '#7B61FF', icon: 'golioth',       direction: 'bidirectional' },
  { name: 'Edge Impulse',  description: 'TinyML: train + export models to MCU firmware',         accent: '#3B5BDB', icon: 'edge-impulse',  direction: 'bidirectional' },
  { name: 'Memfault',      description: 'Embedded observability: crashes, metrics, symbolication', accent: '#00B3A4', icon: 'memfault',      direction: 'bidirectional' },
  { name: 'Mender',        description: 'Embedded OTA server with A/B rollback',                  accent: '#015D8E', icon: 'mender',        direction: 'bidirectional' },
];
