import type { ReactElement } from 'react';
import type { Tab } from './components/Sidebar';
import {
  PostHogIcon,
  SupabaseIcon,
  SentryIcon,
  DatadogIcon,
  JiraIcon,
  LinearIcon,
  SlackIcon,
  CloudflareIcon,
  AwsIcon,
  KubernetesIcon,
  TerraformIcon,
  GrafanaIcon,
  BuilderIcon,
  RegistryIcon,
  AuthIcon,
  SecretsIcon,
} from './components/BrandIcons';

// THE add-on Store catalog of the fleet dashboard: Settings → Store (src/lib/store.tsx)
// lists the entries here plus its condensed Devices switch. The company's own apps live in
// nff-admin since Oct 2026.
//
// `superAdmin: true` marks add-ons only the platform console may offer — the
// regular nff-app surface never imports those tabs, so a toggle there would be
// a dead switch.
// `key` is the nav-group id the toggle hides/shows (Sidebar's visibleGroup +
// the pinned rows all honor view.hiddenGroups).
// NOT listed here = not an add-on: Chat, History and Improve are always-on
// parts of nff-admin (no toggle, no Store row). nff-app never imports History
// or Improve at all, and its chat is core (it lives on the Overview), also always on.
// `badge` marks a placeholder with no toggle yet, same as StoreAdapter's.
// `settingsTab` = the add-on's own settings page; the Store row shows an
// arrow that jumps there. An add-on with no nav group of its own (Emails)
// is still toggled by `key`: Sidebar's STORE_KEY_OF_TAB hides its settings
// tab when the key is hidden.

export interface AdminStoreEntry {
  key: string;
  label: string;
  icon?: ReactElement;
  description?: string;
  badge?: string;
  superAdmin?: boolean;
  settingsTab?: Tab;
  // What connecting this source mirrors into the brain ("repos, deployments…")
  // and a couple of prompts it makes answerable — the Sources page's pitch.
  brainAdds?: string;
  ask?: string[];
  // A dev tool: it belongs inside nff-app's condensed Dev sub-app rather than
  // at the top level, filed under this heading — the standard developer stack
  // grouped by job, one tool per row. nff-app nests every entry that has a
  // `section` under its Dev row (src/lib/store.tsx) and prints the headings in
  // DEV_SECTIONS order; nff-admin still lists them flat.
  section?: DevSection;
  // Set only on a condensed sub-app row (see devSubApp): the tools it hides
  // behind one switch, which StoreSection reveals under their job headings.
  tools?: AdminStoreEntry[];
}

// The jobs a dev tool can do, in the order the Dev sub-page lists them.
export const DEV_SECTIONS = [
  'Write code',
  'Version control & CI',
  'Build & ship',
  'Hosting & infra',
  'Data',
  'Auth, secrets & payments',
  'Observability',
  'Planning & communication',
  'Analytics & product',
] as const;
export type DevSection = (typeof DEV_SECTIONS)[number];

const BUILDING = 'Building…';

export const ADMIN_STORE_CATALOG: AdminStoreEntry[] = [
  // ── Building — future Dev-tab integrations, grouped by job ─────────────
  // Announced in BOTH stores (no superAdmin) so the roadmap is visible; the
  // badge replaces the toggle, and there's no nav group yet. `section` files
  // them under nff-app's Dev sub-app, one tool per job (a small team needs one
  // per row, not several). `key` is reserved
  // as the tool's future nav-group id: a tool graduates by dropping `badge`
  // and landing its Dev sub-tab + BRAIN_TOOL_CATALOG entry (the GitHub add-on
  // is the shape). Goal: supervise the whole web product from the brain.
  // Build & ship
  { key: 'registries', label: 'Registries', description: 'npm, PyPI and GHCR — what you publish.', icon: <RegistryIcon />, badge: BUILDING, section: 'Build & ship' },
  { key: 'kubernetes', label: 'Kubernetes', description: 'Clusters, pods and rollouts.', icon: <KubernetesIcon />, badge: BUILDING, section: 'Build & ship' },
  { key: 'cloudflare', label: 'Cloudflare', description: 'DNS, CDN and firewall.', icon: <CloudflareIcon />, badge: BUILDING, section: 'Hosting & infra' },
  { key: 'aws', label: 'AWS', description: 'Accounts, costs and services.', icon: <AwsIcon />, badge: BUILDING, section: 'Hosting & infra' },
  { key: 'terraform', label: 'Terraform', description: 'State, plans and drift.', icon: <TerraformIcon />, badge: BUILDING, section: 'Hosting & infra' },
  // Data
  { key: 'supabase', label: 'Supabase', description: 'Tables, auth and edge functions.', icon: <SupabaseIcon />, badge: BUILDING, section: 'Data' },
  // Auth, secrets & payments — the rows the stack has and this catalog didn't.
  { key: 'auth', label: 'Auth', description: 'Clerk, Auth0 or Supabase Auth — who gets in.', icon: <AuthIcon />, badge: BUILDING, section: 'Auth, secrets & payments' },
  { key: 'secrets', label: 'Secrets', description: '1Password, Doppler or Vault — keys out of .env.', icon: <SecretsIcon />, badge: BUILDING, section: 'Auth, secrets & payments' },
  // Observability
  { key: 'sentry', label: 'Sentry', description: 'Errors and releases.', icon: <SentryIcon />, badge: BUILDING, section: 'Observability' },
  { key: 'grafana', label: 'Grafana', description: 'Dashboards and alert rules.', icon: <GrafanaIcon />, badge: BUILDING, section: 'Observability' },
  { key: 'datadog', label: 'Datadog', description: 'Metrics, logs and traces.', icon: <DatadogIcon />, badge: BUILDING, section: 'Observability' },
  // Planning & communication
  { key: 'linear', label: 'Linear', description: 'Issues and cycles.', icon: <LinearIcon />, badge: BUILDING, section: 'Planning & communication' },
  { key: 'jira', label: 'Jira', description: 'Tickets and sprints.', icon: <JiraIcon />, badge: BUILDING, section: 'Planning & communication' },
  { key: 'slack', label: 'Slack', description: 'Channels and alerts.', icon: <SlackIcon />, badge: BUILDING, section: 'Planning & communication' },
  // Analytics & product
  { key: 'posthog', label: 'PostHog', description: 'Product analytics and feature flags.', icon: <PostHogIcon />, badge: BUILDING, section: 'Analytics & product' },
];

// Synthetic Store key for the condensed Dev row — not a real nav group id, it
// never reaches a sidebar filter. Each surface maps it to its own tool keys.
export const DEV_STORE_KEY = 'dev-app';

/** A condensed sub-app row: the entries of `entries` whose job is one of
 * `sections` — plus the `extra` tools a surface ships as real nav groups of its
 * own — filed by job in `sections` order. A stable sort, so declaration order
 * holds within a job. */
function subApp(
  row: Pick<AdminStoreEntry, 'key' | 'label' | 'description' | 'icon'>,
  sections: readonly string[],
  entries: AdminStoreEntry[],
  extra: AdminStoreEntry[] = [],
): AdminStoreEntry {
  return {
    ...row,
    tools: [...extra, ...entries.filter((e) => e.section && sections.includes(e.section))].sort(
      (a, b) => sections.indexOf(a.section!) - sections.indexOf(b.section!),
    ),
  };
}

/** The condensed "Dev" Store row, shared by both stores so they read the same
 * (nff-app adds its Code / GitHub / Deploy nav groups as `extra`). */
export function devSubApp(entries: AdminStoreEntry[], extra: AdminStoreEntry[] = []): AdminStoreEntry {
  return subApp(
    { key: DEV_STORE_KEY, label: 'Dev', description: 'Everything that builds and ships the product.', icon: <BuilderIcon /> },
    DEV_SECTIONS,
    entries,
    extra,
  );
}

/** The entries a surface offers: the dashboard never sees superAdmin ones. */
export function adminStoreEntries(superAdmin: boolean): AdminStoreEntry[] {
  return superAdmin ? ADMIN_STORE_CATALOG : ADMIN_STORE_CATALOG.filter((e) => !e.superAdmin);
}
