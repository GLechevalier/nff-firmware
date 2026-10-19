// Ordered manifest of every Supabase SQL script across the nff monorepo.
//
// The nff stack runs on ONE shared Supabase database. Its schema is defined by
// scripts owned by three repos and applied by hand, in phases, in this order.
// The drift checker replays them in exactly this sequence to build the
// "expected" schema — order matters because later scripts DROP/ALTER what
// earlier ones created (e.g. migration 04 drops the anon read-all policies that
// supabase_schema.sql and the nff-ota 0001/0002/0003 scripts created).
//
// Paths are resolved relative to this file's directory (nff-dashboard/scripts).
// Sibling repos sit next to nff-dashboard under nff_cli_mcp/.

export const SOURCES = [
  // ── 1. Dashboard base schema (creates the core fleet tables + anon read-all) ──
  { repo: 'nff-dashboard',     path: '../supabase_schema.sql' },

  // ── 2. Dashboard fleet hooks (heartbeat RPC, crash dedup constraint) ──────────
  { repo: 'nff-dashboard',     path: '../supabase/migrations/20260603000000_nff_fleet_hooks.sql' },

  // ── 3. nff-ota layer — extends devices/firmware/ota_jobs, adds OTA + github ───
  //     (must come after the base tables it ALTERs exist; before the RLS cutover
  //      that drops its anon policies).
  { repo: 'nff-ota',           path: '../../nff-ota/supabase/migrations/0001_initial.sql' },
  { repo: 'nff-ota',           path: '../../nff-ota/supabase/migrations/0002_dashboard_writes.sql' },
  { repo: 'nff-ota',           path: '../../nff-ota/supabase/migrations/0003_github.sql' },
  { repo: 'nff-ota',           path: '../../nff-ota/supabase/migrations/0004_pipeline_commit_message.sql' },
  { repo: 'nff-ota',           path: '../../nff-ota/supabase/migrations/0005_release_version.sql' },
  { repo: 'nff-ota',           path: '../../nff-ota/supabase/migrations/0006_pipeline_verified.sql' },

  // ── 4. agent worker schema (agent_console_entries, session_id). The worker's own
  //     copies were dropped when it folded into nff-app/src/core/agent/service on
  //     2026-09-04; nff-db owns them (same SQL, 0009/0010 of its linear sequence).
  { repo: 'nff-db',            path: '../../nff-db/migrations/0009_agent_console_entries.sql' },
  { repo: 'nff-db',            path: '../../nff-db/migrations/0010_agent_messages_session.sql' },

  // ── 5. Dashboard service/identity migrations (before the tenancy phases) ──────
  { repo: 'nff-dashboard',     path: '../supabase/migrations/20260608000000_service_heartbeats.sql' },
  { repo: 'nff-dashboard',     path: '../supabase/migrations/20260609000000_device_hardware_identity.sql' },
  { repo: 'nff-dashboard',     path: '../supabase/migrations/20260609010000_dashboard_config_feedback_writes.sql' },
  { repo: 'nff-dashboard',     path: '../supabase/migrations/20260609020000_agent_messages_authenticated_writes.sql' },
  { repo: 'nff-dashboard',     path: '../supabase/migrations/20260610000000_device_build_id.sql' },

  // ── 6. Multi-tenancy cutover, phases 1 → 2 → 3 (manual) → 4 → 5 ───────────────
  { repo: 'nff-dashboard',     path: '../supabase/migrations/20260611000000_01_projects_and_members.sql' },
  { repo: 'nff-dashboard',     path: '../supabase/migrations/20260611010000_02_add_project_id_columns.sql' },
  { repo: 'nff-dashboard',     path: '../supabase/manual/03_set_project_id_not_null.sql' },
  { repo: 'nff-dashboard',     path: '../supabase/migrations/20260611030000_04_rls_multitenant_rewrite.sql' },
  { repo: 'nff-dashboard',     path: '../supabase/migrations/20260612000000_05_demo_project.sql' },
  // 06 supersedes the buggy 05_chat_sessions (TEXT→UUID FK; never applied).
  { repo: 'nff-dashboard',     path: '../supabase/migrations/20260613000000_06_chat_sessions.sql' },
];

// Tables that are intentionally NOT project-scoped — exempt from the
// "must have project_id + member-scoped RLS" design assertions.
export const GLOBAL_TABLES = new Set([
  'projects',          // tenancy root
  'project_members',   // tenancy membership (own user_id = auth.uid() policy)
  'service_status',    // backend liveness, global read, intentional USING(true)
]);

// Child tables: scoped via a parent join, so they carry NO own project_id column
// but MUST still have a member-scoped (parent-join) SELECT policy.
export const CHILD_TABLES = {
  backtrace_frames:     'crash_reports',
  rtc_log_lines:        'crash_reports',
  device_group_members: 'device_groups',
  agent_task_steps:     'agent_tasks',
  brain_edges:          'brain_nodes',
  pipeline_runs:        'github_connections',
};

// Columns allowed to stay nullable even after the phase-3 NOT NULL lock.
export const NULLABLE_PROJECT_ID_OK = new Set([
  'feedback',          // app-level submissions may lack a project context
]);
