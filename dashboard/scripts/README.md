# Supabase structure tools

This folder holds two complementary tools:

- **`dump-supabase-structure.mjs`** — writes `supabase/schema.json`, a single
  source of truth describing the **real, deployed** structure (see below).
- **`check-supabase-structure.mjs`** — diffs the **SQL scripts** against the
  live database and reports drift + multi-tenancy design assertions.

---

## `supabase/schema.json` — real-DB structure dump

`dump-supabase-structure.mjs` reads the **live** database and writes
`supabase/schema.json` — the committed single source of truth for the deployed
schema. It introspects via the PostgREST OpenAPI document (the Postgres catalog
is not reachable through PostgREST), so it captures, per exposed table: every
column (Postgres type, nullability, default, max length, enum values), the
**primary key**, and **foreign keys**.

**Scope note:** RLS state, policies, functions, triggers, indexes, and grants
are **not** exposed by PostgREST and are therefore *not* in `schema.json`. Use
`npm run db:check` (direct connection) to verify those.

### Setup

Add the **service_role** secret to `.env.local.dev` (gitignored). The anon key is
rejected by the schema endpoint — only `service_role` can read it.

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role secret>
```

Get the secret from **Supabase Dashboard → Project Settings → API → `service_role`**.

### Run

```bash
npm run db:dump                                          # writes supabase/schema.json
node scripts/dump-supabase-structure.mjs --stdout        # print, don't write
```

Regenerate after any schema change so the committed file stays current.

---

## Supabase structure drift checker

`check-supabase-structure.mjs` compares the **whole corpus of Supabase SQL
scripts** across the nff monorepo (the *expected* schema) against the **real
deployed database** (the *actual* schema) and reports every difference, plus a
set of multi-tenancy design assertions.

The nff stack runs on **one shared Supabase database**, but its schema is spread
across three repos and applied by hand. Nothing else verifies that what's
deployed matches what the scripts say — this script does.

### How the actual schema is obtained (two sources)

1. **Structure** (tables, columns, types, nullability, **primary & foreign
   keys**) comes from **`supabase/schema.json`** — the committed single source of
   truth. By default `db:check` first **downloads (refreshes)** `schema.json` from
   the live database (via `buildSchema()` in `dump-supabase-structure.mjs`; needs
   `VITE_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`), then runs the structural
   checks against it. Pass `--no-refresh` to test the committed file as-is
   (offline / CI). A missing service_role key automatically falls back to
   `--no-refresh`.
2. **Catalog + security** (RLS state, policies, functions, triggers, indexes,
   grants, and the design assertions) is **not exposed by PostgREST**, so it is
   read over the Postgres wire protocol from `SUPABASE_DB_URL` when set. When that
   connection is absent (or unreachable), these checks are **skipped with a clear
   note** and only the structural checks run.

## Setup

1. Install deps (adds `pg`, the Postgres driver):

   ```bash
   npm install
   ```

2. For the structural check (download/refresh of `schema.json`), set in
   `.env.local.dev` (gitignored):

   ```
   VITE_SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service_role secret>
   ```

3. *(Optional)* For the catalog + security/design checks, also add the **direct
   connection string** (use the **pooler / session** URI from the Dashboard — the
   legacy `db.<ref>.supabase.co` host is often unreachable):

   ```
   SUPABASE_DB_URL=postgresql://postgres:<password>@<pooler-host>:5432/postgres
   ```

   Get it from **Supabase Dashboard → Project Settings → Database → Connection
   string**. The anon/service-role keys can't be used here: PostgREST does not
   expose `information_schema` / `pg_catalog`, so these checks need a real
   Postgres connection.

## Run

```bash
npm run db:check                       # refresh schema.json + full check; exit 1 if any ERROR
npm run db:check -- --no-refresh       # test the committed schema.json (offline, no creds)
node scripts/check-supabase-structure.mjs --json          # machine-readable (incl. catalogChecked)
node scripts/check-supabase-structure.mjs --dump-expected # parsed scripts only, no DB
```

## What it checks

- **Tables / columns** (against `schema.json`) — in scripts but missing in DB
  (`ERROR`, e.g. an unapplied migration); in DB but undocumented (`WARN`); type /
  nullability differences (`WARN`).
- **Primary & foreign keys** (against `schema.json`) — declared in scripts but
  missing/differing in the DB, or present in the DB but undocumented (`WARN`;
  PK/FK extraction from SQL is heuristic, so these stay `WARN`, never `ERROR`).
- **RLS** — every table the scripts enable RLS on must have it enabled in the DB.
- **Policies** — every script-created policy exists; leftover DB policies are flagged.
- **Functions / triggers / indexes** — presence, plus `SECURITY DEFINER` and
  pinned `search_path` on functions.
- **Design assertions** (against the live DB):
  - every `project_id` table has RLS **and** a `is_project_member()` policy;
  - no permissive `USING (true)` SELECT policy survives on a tenant table;
  - child tables scope via a parent-join member policy;
  - `is_project_member` / `is_project_admin` are `SECURITY DEFINER`, pin
    `search_path`, and are granted to `authenticated`;
  - the `on_auth_user_created` signup trigger exists;
  - `project_id` columns are `NOT NULL` (phase-3 lock), except allow-listed ones.

## Scope & limitations

- The structural checks compare against `schema.json`, which is built from
  PostgREST's **public-schema** OpenAPI doc. Foreign keys targeting another schema
  (e.g. `auth.users`) can't be represented there, so they're excluded from the
  expected-side FK set.
- The RLS / policy / function / trigger / index / design checks **require
  `SUPABASE_DB_URL`**. Without it (or if the connection fails) they're skipped and
  the run reports structural findings only (`catalogChecked: false` in `--json`).
- The expected model is built by **targeted regex extraction**, not a full SQL
  parser — it understands the DDL patterns these scripts actually use. PK/FK
  extraction is heuristic (so those findings are `WARN`); dynamic DDL like the
  phase-03 `do $$ … alter column … set not null` loop is not followed. Extend the
  extractors in the script if the SQL adopts new syntax.
- Functions are matched by **name** (overloads like the three
  `upsert_device_heartbeat` signatures are treated as one).
- The ordered list of scripts lives in `supabase-sources.mjs`. Keep it in sync
  when migrations are added — order matters (later scripts drop/alter earlier ones).
- `db:check` **rewrites** `supabase/schema.json` on each run (the refresh step);
  it never modifies the database. Use `--no-refresh` to avoid the rewrite.
