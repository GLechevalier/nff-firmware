// The single, permanent "showroom" project the public /floor page reads.
//
// This id is a CONSTANT and must never move — it is the same literal seeded by
// nff-db/migrations/0062_floor_project.sql, configured as the floor agent-worker's
// DEFAULT_PROJECT_ID, and targeted by the nff-floor-showrunner. Public-read RLS
// (anon SELECT) is scoped to exactly this project, so the floor page reads real,
// live data with the anon key and no login.
export const FLOOR_PROJECT_ID = 'f100f100-0000-4000-8000-000000000001';
