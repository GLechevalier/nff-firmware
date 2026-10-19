# Backend Integration Guide

This document maps every mock/local-state surface in the dashboard to a real backend contract. Use it to build the backend so the frontend can be wired up with minimal rework.

---

## Architecture Overview

```
Browser (Vite + React)
│
├── Supabase JS client         — device data, telemetry, persistence, realtime
├── Vercel Edge Functions      — LLM proxy (QueryPopup, AgentTab chat)
└── Custom Service (nff)       — IoT CLI bridge (REST or MCP)
        ├── REST API  /nff/...
        └── MCP server  (alternative)
```

---

## 1. Device List — `src/data/mockDevices.ts`

**What it does now:** static array of 10 `Device` objects imported at startup.

**What it needs to become:** a live fetch on mount, updated via Supabase Realtime.

### Supabase table: `devices`

```sql
create table devices (
  id              text primary key,          -- device identifier, e.g. "alpha-01"
  name            text not null,
  status          text not null              -- 'online' | 'offline' | 'warning' | 'error'
                  check (status in ('online','offline','warning','error')),
  firmware_version text not null,
  agent_connected  boolean not null default false,
  last_seen        timestamptz not null,
  ip_address       text not null,
  rssi             integer,                  -- null = wired
  uptime_seconds   integer not null default 0,
  updated_at       timestamptz not null default now()
);
```

### Frontend change — `src/data/mockDevices.ts` → `src/hooks/useDevices.ts`

Replace the static import in `App.tsx` with a hook:

```ts
// replaces: import { mockDevices } from './data/mockDevices'
// becomes:
const { devices, loading } = useDevices();
```

The hook should:
1. `supabase.from('devices').select('*')` on mount
2. Subscribe to `supabase.channel('devices').on('postgres_changes', ...)` for live status updates
3. Map snake_case columns to the camelCase `Device` interface

### Who writes to this table?

The **nff custom service** is the authoritative writer. It polls or receives push events from devices and upserts rows. Supabase Realtime then propagates changes to the browser.

---

## 2. Device Telemetry Console — `src/components/DeviceDetailTab.tsx`

**What it does now:** a `setInterval` every 1800 ms emitting fake RSSI, heap, temperature, etc.

**What it needs:** a real-time stream of telemetry from the selected device.

### Supabase table: `device_telemetry`

```sql
create table device_telemetry (
  id         bigint generated always as identity primary key,
  device_id  text not null references devices(id),
  type       text not null          -- 'output' | 'info' | 'error' (maps to ConsoleEntry.type)
             check (type in ('output','info','error','command')),
  content    text not null,
  ts         timestamptz not null default now()
);

create index on device_telemetry (device_id, ts desc);
```

### Frontend change — `DeviceDetailTab.tsx`

Replace `useEffect` + `setInterval` block with:

```ts
useEffect(() => {
  // 1. Fetch last N entries on mount
  supabase
    .from('device_telemetry')
    .select('*')
    .eq('device_id', device.id)
    .order('ts', { ascending: false })
    .limit(50)
    .then(({ data }) => setEntries(/* map to ConsoleEntry[] */));

  // 2. Subscribe to new rows for this device
  const channel = supabase
    .channel(`telemetry:${device.id}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'device_telemetry',
      filter: `device_id=eq.${device.id}`,
    }, payload => addEntry(payload.new.type, payload.new.content))
    .subscribe();

  return () => { supabase.removeChannel(channel); };
}, [device.id]);
```

### Who writes to this table?

The **nff custom service** — it reads serial/MQTT output from devices and inserts rows. It can also be written by the **agent** when it runs diagnostics.

---

## 3. Agent Chat + Console — `src/components/AgentTab.tsx`

**What it does now:** a local `loop()` async function cycling through 5 hardcoded `SCENARIOS` with simulated delays. The `ChatPanel` is read-only (no user input).

**What it needs:** bidirectional chat wired to a real agent, with console output streamed back.

### Supabase tables: `agent_sessions`, `agent_messages`, `agent_console_entries`

```sql
create table agent_sessions (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz default now(),
  closed_at   timestamptz
);

create table agent_messages (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid references agent_sessions(id),
  role        text not null check (role in ('user','agent')),
  content     text not null,
  ts          timestamptz not null default now()
);

create table agent_console_entries (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid references agent_sessions(id),
  type        text not null check (type in ('command','output','error','info')),
  content     text not null,
  ts          timestamptz not null default now()
);
```

### Vercel Edge Function: `POST /api/agent/chat`

This is the bridge between the frontend and the underlying LLM + nff tool executor.

**Request body:**
```json
{
  "session_id": "uuid",
  "message": "string"
}
```

**What the function does:**
1. Persists the user message to `agent_messages`
2. Calls the LLM (Claude via Anthropic SDK or similar) with the conversation history + tool definitions
3. When the LLM calls a tool (e.g. `nff list-devices`), the function forwards it to the **nff service** and streams results back
4. Inserts each console line into `agent_console_entries` as it arrives
5. Inserts the final agent reply into `agent_messages`
6. Returns `{ ok: true }` — the frontend picks up messages via Supabase Realtime, not the HTTP response

**Streaming approach (alternative):** use a streaming SSE response. The frontend reads the stream and appends lines to state directly, bypassing Supabase for the live console. Supabase still persists the session for history.

### Frontend change — `AgentTab.tsx`

- Remove the `SCENARIOS` loop entirely
- On mount: create or resume a session, subscribe to both `agent_messages` and `agent_console_entries` channels for that session
- Add a user input row to `ChatPanel` (currently `messages` is passed read-only — needs an `onSend` prop)
- On send: `POST /api/agent/chat` with the session ID and message text

---

## 4. Query Popup — `src/components/QueryPopup.tsx`

**What it does now:** `generateAgentReply()` — a local function with regex keyword matching. No network call.

**What it needs:** a real LLM call with device context injected into the system prompt.

### Vercel Edge Function: `POST /api/agent/query`

**Request body:**
```json
{
  "device_id": "string",
  "field":     "string",       // e.g. "Firmware Version"
  "value":     "string",       // e.g. "2.4.1"
  "message":   "string",       // user's question
  "history":   [               // prior turns in this popup session
    { "role": "user",  "content": "..." },
    { "role": "agent", "content": "..." }
  ]
}
```

**Response body:**
```json
{
  "reply": "string"
}
```

The function fetches the full device row from Supabase (or accepts it in the request body), builds a system prompt like _"You are a firmware engineer assistant. The user is looking at field `{field}` = `{value}` on device `{device.name}` (status: {status}, firmware: {firmwareVersion})."_, and calls the LLM.

### Frontend change — `QueryPopup.tsx`

Replace the `setTimeout(() => generateAgentReply(...))` block in `send()` with:

```ts
const res = await fetch('/api/agent/query', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ device_id: context.device.id, field: context.field, value: context.value, message: text, history: messages }),
});
const { reply } = await res.json();
```

---

## 5. Agent Management State — `src/components/AgentManagementTab.tsx`

**What it does now:** all state is component-local. Priorities, tools, and the current task are reset on every page reload.

**What it needs:** persistence in Supabase.

### Supabase tables

```sql
create table agent_priorities (
  id       text primary key,
  label    text not null,
  enabled  boolean not null default true,
  position integer not null           -- for ordering
);

create table agent_tools (
  id          text primary key,
  name        text not null,
  description text not null,
  status      text not null check (status in ('online','warning','error')),
  active      boolean not null default true,
  direction   text check (direction in ('undirected','inbound','outbound','bidirectional')),
  accent      text,
  icon        text
);

create table agent_tasks (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  created_at timestamptz default now()
);

create table agent_task_steps (
  id       uuid primary key default gen_random_uuid(),
  task_id  uuid references agent_tasks(id) on delete cascade,
  label    text not null,
  status   text not null check (status in ('done','running','pending')),
  position integer not null
);
```

### Frontend changes

- On mount: fetch priorities, tools, active task from Supabase
- On mutation (toggle, reorder, add/delete): call `supabase.from(...).upsert(...)` / `.delete()`
- Subscribe to `agent_task_steps` via Realtime so the "Current Task" panel updates live as the agent progresses
- Subscribe to `agent_tools` via Realtime so tool status changes (pushed by the nff service or agent) appear without refresh

---

## 6. Feedback — `src/components/FeedbackPopup.tsx`

**What it does now:** sets `submitted = true` locally; data goes nowhere.

**What it needs:** a real submission endpoint.

### Option A — Supabase table (simple)

```sql
create table feedback (
  id         bigint generated always as identity primary key,
  category   text not null check (category in ('bug','feature','other')),
  body       text not null,
  created_at timestamptz default now(),
  user_id    uuid references auth.users(id)   -- if auth is added
);
```

Replace `setSubmitted(true)` in `submit()` with:

```ts
await supabase.from('feedback').insert({ category, body: text });
setSubmitted(true);
```

### Option B — Vercel Edge Function (if you want email/Slack notification on submit)

```
POST /api/feedback   { category, body }
→ insert into Supabase + send Slack webhook
→ 200 OK
```

---

## 7. Custom nff Service (REST API or MCP)

This is the service that actually talks to IoT devices. The frontend never calls it directly — the Vercel Edge Functions and Supabase Realtime are the intermediary.

### REST API surface (minimum viable)

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/devices` | List all devices (writes to Supabase `devices` on each poll) |
| `GET`  | `/devices/:id/serial?tail=50` | Stream recent serial output |
| `POST` | `/devices/:id/command` | Send a serial command: `{ "data": "CMD:WIFI_RECONNECT" }` |
| `POST` | `/devices/:id/flash` | Push firmware: `{ "firmware_url": "..." }` |
| `POST` | `/fleet/:fleet/ota` | Fleet OTA: `{ "firmware_url": "...", "rollout_pct": 10 }` |
| `GET`  | `/devices/:id/firmware/versions` | Firmware changelog |
| `POST` | `/devices/:id/cal/reset` | Reset calibration registers |
| `GET`  | `/audit` | Run a security/cert audit across all devices |

### MCP alternative

If the nff CLI is exposed as an MCP server, the Vercel Edge Function calls it via the MCP client SDK instead of HTTP. The tool definitions fed to the LLM in `/api/agent/chat` are derived directly from the MCP server's `tools/list` response.

This is the cleaner approach if the agent needs to call many different nff sub-commands — the LLM picks tools by name and arguments rather than the Edge Function having to map intent to REST calls.

---

## 8. Auth (optional but recommended)

Supabase Auth covers this. Add Row Level Security (RLS) so users only see their own session data and feedback.

The frontend gains:

```ts
// src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js';
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
```

Vercel Edge Functions receive the JWT via `Authorization: Bearer <token>` and verify it with the Supabase service role key before writing to the database.

---

## Frontend Files → Backend Dependency Map

| Frontend file | Currently | Replace with |
|---|---|---|
| `src/data/mockDevices.ts` | Static array | Supabase `devices` table + Realtime |
| `App.tsx` (online/total count) | `mockDevices.filter(...)` | Derived from live device state |
| `AgentTab.tsx` (scenarios loop) | Local `async loop()` | Supabase Realtime channels + `POST /api/agent/chat` |
| `AgentTab.tsx` (read-only chat) | No user input | Add `onSend` to `ChatPanel` |
| `DeviceDetailTab.tsx` (signals) | `setInterval` fake data | Supabase `device_telemetry` + Realtime |
| `QueryPopup.tsx` (replies) | `generateAgentReply()` regex | `POST /api/agent/query` (Vercel Edge) |
| `AgentManagementTab.tsx` (state) | `useState` local | Supabase tables + Realtime |
| `FeedbackPopup.tsx` (submit) | No-op | Supabase `feedback` table or `POST /api/feedback` |

---

## Recommended Build Order

1. **Supabase schema** — create all tables above, seed `devices` with the current mock data.
2. **Supabase client** — add `src/lib/supabase.ts`, install `@supabase/supabase-js`.
3. **Device list** — replace `mockDevices` with `useDevices()` hook. Dashboard tab works with real data.
4. **nff service** — stand up the REST or MCP service; have it upsert into `devices` on a poll interval (e.g. every 30 s). Device statuses now go live.
5. **Device telemetry** — nff service starts inserting into `device_telemetry`; wire `DeviceDetailTab` to Realtime.
6. **Agent Management persistence** — wire priorities + tools to Supabase; `AgentManagementTab` state survives refresh.
7. **`POST /api/agent/query`** — implement the Vercel Edge Function; `QueryPopup` now uses real LLM.
8. **`POST /api/agent/chat`** — implement the full agent loop; `AgentTab` becomes interactive.
9. **Feedback** — insert into Supabase; add Slack/email hook if needed.
10. **Auth** — add Supabase Auth + RLS last, once the happy path works without it.
