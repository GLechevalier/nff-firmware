// Vulnerability-tree types + helpers for the dev-only Security tab.
//
// The tree originates as nff-pentester/.../vuln_tree.json, seeded into the
// `vuln_tree_nodes` Supabase table (one row per node, parent/child via
// parent_id). The dashboard reads it project-scoped and can append nodes.

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type NodeOrigin = 'seed' | 'user' | 'agent';

export interface NextCheck {
  tool?: string;
  reason?: string;
  params_hint?: Record<string, unknown>;
}

export interface Outcome {
  compromised?: string;
  impact?: string;
  cvss?: string;
}

export interface VulnNode {
  nodeId: string;
  parentId: string | null;
  label: string;
  tool: string | null;
  severity: Severity;
  condition: unknown | null;
  nextCheck: NextCheck | null;
  outcome: Outcome | null;
  origin: NodeOrigin;
  sourceSession: string | null;
}

export const SEVERITY_ORDER: Severity[] = ['low', 'medium', 'high', 'critical'];

export const SEVERITY_COLOR: Record<Severity, string> = {
  low: '#4caf50',
  medium: '#e0a800',
  high: '#fb8c00',
  critical: '#e5484d',
};

// Fallback list of pentester tools — used only if the live pentester_tools fetch
// (the source of truth, synced by the pentester on startup) returns nothing. A
// node whose tool is not in the set is rendered "planned".
export const REAL_TOOLS = new Set<string>([
  'port_scan', 'discover_devices',
  'mqtt_probe', 'mqtt_topic_enum',
  'coap_discover', 'ble_scan', 'zigbee_scan',
  'extract_firmware', 'analyze_strings', 'scan_hardcoded_creds',
  'fuzz_web_paths', 'test_default_creds_http',
  'lookup_default_creds', 'ssh_brute', 'telnet_brute',
]);

// `realTools` comes from the live pentester_tools registry (via useVulnTree); the
// static REAL_TOOLS is the fallback when that fetch is empty/unavailable.
export function isPlanned(node: VulnNode, realTools?: Set<string>): boolean {
  if (node.tool == null) return false;
  const known = realTools && realTools.size > 0 ? realTools : REAL_TOOLS;
  return !known.has(node.tool);
}

// Render a condition matcher object as a readable one-liner (ported from the
// pentester HTML visualizer). Pure, defensive — unknown shapes degrade to ''.
export function condText(c: unknown): string {
  if (!c || typeof c !== 'object') return '';
  const m = c as Record<string, unknown>;
  const op = m.op as string | undefined;
  const field = m.field === '.' ? '⟨item⟩' : (m.field as string | undefined);
  const of = m.of as unknown[] | undefined;
  switch (op) {
    case 'and': return (of ?? []).map(condText).join(' AND ');
    case 'or': return '(' + (of ?? []).map(condText).join(' OR ') + ')';
    case 'not': return 'NOT(' + condText(m.of) + ')';
    case 'any': return `any ${m.field}[ ${condText(m.match)} ]`;
    case 'all': return `all ${m.field}[ ${condText(m.match)} ]`;
    case 'exists': return `${field} exists`;
    case 'missing': return `${field} missing`;
    case 'non_empty': return `${field} not empty`;
    case 'empty': return `${field} empty`;
    case 'equals': return `${field} == ${JSON.stringify(m.value)}`;
    case 'not_equals': return `${field} != ${JSON.stringify(m.value)}`;
    case 'contains': return `${field} contains ${JSON.stringify(m.value)}`;
    case 'gt': return `${field} > ${m.value}`;
    case 'gte': return `${field} >= ${m.value}`;
    case 'lt': return `${field} < ${m.value}`;
    case 'lte': return `${field} <= ${m.value}`;
    default: return op ?? '';
  }
}

// kebab-case id from a label, with a short suffix so manual appends never collide.
export function makeNodeId(label: string, suffix: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${slug || 'node'}-${suffix}`;
}
