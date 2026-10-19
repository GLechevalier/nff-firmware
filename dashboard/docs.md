# nff-dashboard — Database Schema & API Routes

## Database Schema

### `devices`
```sql
CREATE TABLE devices (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('online','offline','warning','error')),
  firmware_version TEXT NOT NULL,
  agent_connected  BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen        TIMESTAMPTZ,
  ip_address       TEXT,
  rssi             INTEGER,          -- NULL = wired
  uptime_seconds   INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `device_telemetry` (time-series)
```sql
CREATE TABLE device_telemetry (
  id          BIGSERIAL PRIMARY KEY,
  device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rssi        INTEGER,
  heap_free   INTEGER,
  packets_rx  INTEGER,
  packets_tx  INTEGER,
  temp_c      REAL
);
CREATE INDEX ON device_telemetry (device_id, ts DESC);
```

### `firmware_versions`
```sql
CREATE TABLE firmware_versions (
  version        TEXT PRIMARY KEY,
  build_id       TEXT UNIQUE NOT NULL,
  parent_version TEXT REFERENCES firmware_versions(version),
  merged_into    TEXT REFERENCES firmware_versions(version),
  branch_name    TEXT NOT NULL,
  committed_at   TIMESTAMPTZ NOT NULL,
  author         TEXT NOT NULL,
  changelog      TEXT NOT NULL DEFAULT '',
  elf_stored     BOOLEAN NOT NULL DEFAULT FALSE,
  elf_path       TEXT,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  tag            TEXT CHECK (tag IN ('latest','stable')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- device_count is always derived: SELECT COUNT(*) FROM devices WHERE firmware_version = ?
```

### `crash_reports`
```sql
CREATE TABLE crash_reports (
  id               TEXT PRIMARY KEY,
  device_id        TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ts               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason           TEXT NOT NULL,
  exception_cause  INTEGER,
  pc               TEXT,     -- hex address e.g. '0x400d1234'
  uptime_ms        BIGINT,
  crash_count      INTEGER NOT NULL DEFAULT 1,
  fw_version       TEXT,
  build_id         TEXT,
  retained         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON crash_reports (device_id, ts DESC);
```

### `backtrace_frames`
```sql
CREATE TABLE backtrace_frames (
  id        BIGSERIAL PRIMARY KEY,
  crash_id  TEXT NOT NULL REFERENCES crash_reports(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  address   TEXT NOT NULL,
  resolved  TEXT         -- e.g. 'sensor_poll at src/sensor.cpp:247'; NULL if unresolved
);
```

### `rtc_log_lines`
```sql
CREATE TABLE rtc_log_lines (
  id              BIGSERIAL PRIMARY KEY,
  crash_id        TEXT NOT NULL REFERENCES crash_reports(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  level           TEXT NOT NULL CHECK (level IN ('I','W','E')),
  tag             TEXT NOT NULL,
  message         TEXT NOT NULL,
  ms_before_crash INTEGER NOT NULL
);
```

### `ota_jobs`
```sql
CREATE TABLE ota_jobs (
  id             TEXT PRIMARY KEY,
  device_id      TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  from_version   TEXT NOT NULL,
  target_version TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending','downloading','verifying','committed','rolled_back','timed_out')),
  progress       INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);
CREATE INDEX ON ota_jobs (device_id, started_at DESC);
```

### `agent_messages`
```sql
CREATE TABLE agent_messages (
  id      TEXT PRIMARY KEY,
  role    TEXT NOT NULL CHECK (role IN ('user','agent')),
  content TEXT NOT NULL,
  ts      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON agent_messages (ts DESC);
```

### `agent_tasks`
```sql
CREATE TABLE agent_tasks (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
```

### `agent_task_steps`
```sql
CREATE TABLE agent_task_steps (
  id       TEXT PRIMARY KEY,
  task_id  TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label    TEXT NOT NULL,
  status   TEXT NOT NULL CHECK (status IN ('done','running','pending'))
);
```

### `agent_config` (singleton row)
```sql
CREATE TABLE agent_config (
  id         INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  priorities JSONB NOT NULL DEFAULT '[]',
  tools      JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- priorities element: { "id": "p1", "label": "Maintain the fleet", "enabled": true }
-- tools element:      { "id": "t1", "name": "...", "description": "...",
--                       "status": "online|warning|error", "active": true,
--                       "direction": "undirected|inbound|outbound|bidirectional",
--                       "accent": "#hex", "icon": "github" }
```

### `brain_nodes`
```sql
CREATE TABLE brain_nodes (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('core','analysis','rules','strategy')),
  color        TEXT NOT NULL,
  x            REAL NOT NULL,
  y            REAL NOT NULL,
  size         REAL NOT NULL,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content      TEXT NOT NULL DEFAULT ''
);
-- relatedIds is derived from brain_edges at query time
```

### `brain_edges`
```sql
CREATE TABLE brain_edges (
  from_id  TEXT NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  to_id    TEXT NOT NULL REFERENCES brain_nodes(id) ON DELETE CASCADE,
  strength REAL NOT NULL CHECK (strength BETWEEN 0 AND 1),
  PRIMARY KEY (from_id, to_id)
);
```

### `feedback`
```sql
CREATE TABLE feedback (
  id         TEXT PRIMARY KEY,
  category   TEXT NOT NULL CHECK (category IN ('bug','feature','other')),
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### `audit_log`
```sql
CREATE TABLE audit_log (
  id        BIGSERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  device_id TEXT NOT NULL,
  action    TEXT NOT NULL,   -- 'ping','reboot','diag','ota','rename'
  nonce     TEXT,
  payload   JSONB
);
CREATE INDEX ON audit_log (device_id, ts DESC);
```

---

## REST API Routes

### Devices

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/devices` | List all devices |
| `GET` | `/api/devices/:id` | Get single device |
| `PATCH` | `/api/devices/:id` | Update device — body: `{ "name": "..." }` |
| `GET` | `/api/devices/:id/telemetry` | Historical telemetry — `?limit=50` |
| `GET` | `/api/devices/:id/crashes` | Crash reports for device — `?limit=20` |
| `GET` | `/api/devices/:id/ota-jobs` | OTA jobs for device — `?limit=20` |

### Firmware

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/firmware` | List all versions (newest-first) |
| `GET` | `/api/firmware/:version` | Single version with full metadata |
| `POST` | `/api/firmware` | Register a new firmware version |
| `POST` | `/api/firmware/:version/elf` | Upload ELF binary (`multipart/form-data`) |

### OTA Jobs

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/ota-jobs` | List all jobs — `?deviceId=&status=&limit=50` |
| `POST` | `/api/ota-jobs` | Create job — body: `{ "deviceId", "fromVersion", "targetVersion" }` |
| `GET` | `/api/ota-jobs/:id` | Get single job |
| `PATCH` | `/api/ota-jobs/:id` | Update status/progress — body: `{ "status", "progress", "completedAt" }` |

### Crashes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/crashes` | Fleet-wide list — `?limit=20` (newest-first) |
| `GET` | `/api/crashes/:id` | Full detail: report + `backtrace[]` + `rtcLog[]` |
| `POST` | `/api/crashes` | Ingest crash (called by NFF backend) |

### Agent Config

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agent/config` | Get priorities + tools |
| `PUT` | `/api/agent/config` | Replace full config — body: `{ "priorities": [...], "tools": [...] }` |

### Agent Tasks

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agent/tasks` | List tasks — `?limit=10` |
| `GET` | `/api/agent/tasks/:id` | Get task with steps |
| `POST` | `/api/agent/tasks` | Create task |
| `PATCH` | `/api/agent/tasks/:id/steps/:stepId` | Update step status |

### Agent Chat

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agent/messages` | History — `?limit=100&before=<iso>` |
| `POST` | `/api/agent/messages` | Send user message → `202`; agent reply comes via WebSocket |

### AI Query

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/query` | Field-level query — body: `{ "deviceId", "field", "value", "message" }` → `{ "reply": "..." }` |

### Brain / Knowledge Graph

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/brain` | All nodes + all edges |
| `GET` | `/api/brain/nodes/:id` | Single node detail |
| `POST` | `/api/brain/nodes` | Create node |
| `PUT` | `/api/brain/nodes/:id` | Update node content/position |
| `DELETE` | `/api/brain/nodes/:id` | Delete node (cascades edges) |
| `PUT` | `/api/brain/edges` | Upsert edge — body: `{ "fromId", "toId", "strength" }` |
| `DELETE` | `/api/brain/edges/:fromId/:toId` | Delete edge |

### Misc

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/feedback` | Submit feedback — body: `{ "category": "bug|feature|other", "message": "..." }` → `{ "id": "..." }` |

---

## WebSocket Streams

| Endpoint | Events |
|----------|--------|
| `ws://<host>/ws/agent/events` | `chat_message`, `console_entry`, `task_update` |
| `ws://<host>/ws/devices/:id/telemetry` | Telemetry snapshot every ~2s |
| `ws://<host>/ws/devices` | `device_update` (partial patch by id) |

**Agent events envelope**
```json
{ "type": "chat_message|console_entry|task_update", "payload": { ... } }
```

**Fleet update envelope**
```json
{ "type": "device_update", "payload": { "id": "dev-007", "status": "online", "rssi": -58, "lastSeen": "..." } }
```

---

## Error Format

All error responses:
```json
{ "error": "human-readable message", "code": "NOT_FOUND|VALIDATION_ERROR|INTERNAL_ERROR" }
```
