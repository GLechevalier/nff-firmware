// The distinct external tools/brands the brain graph (Overview tab) visualizes
// as nodes, deduped from SettingsTab.tsx's PERMISSION_GROUPS (several
// permission keys share a brand, e.g. digest_emails/todo_reminders are both
// Gmail). Zero React/DOM imports — safe to import from api/_lib/brain.ts
// (server-side syncDatabase) as well as the client.

export interface BrainToolEntry {
  id: string;
  label: string;
  permissionKeys: string[];
  // The Settings → Store key (storeCatalog.tsx / nav-group id) whose switch
  // installs this tool: off in the Store = the tool's node dims on the graph
  // (BrainGraph.tsx's toolDisabled). Absent = a core tool, permissions only.
  storeKey?: string;
  // The Store app (brainMasters.ts BRAIN_APPS) this tool's master hangs off on
  // the brain graph — the tree rule's tier-2 parent. Mirrored by hand in
  // nff-admin api/_lib/brain.ts's TOOL_CATALOG.
  app: 'devices' | 'dev';
}

export const BRAIN_TOOL_CATALOG: BrainToolEntry[] = [
  { id: 'github', label: 'GitHub', permissionKeys: ['git_sync'], storeKey: 'github', app: 'dev' },
  { id: 'posthog', label: 'PostHog', permissionKeys: ['workflow_cron'], storeKey: 'posthog', app: 'dev' },
  { id: 'growth', label: 'Growth roll-up', permissionKeys: ['growth_rollup'], app: 'dev' },
  { id: 'cursor', label: 'Click logging', permissionKeys: ['click_logging'], app: 'dev' },
  { id: 'builder', label: 'Coding agent', permissionKeys: ['builder_agent'], app: 'dev' },
];
