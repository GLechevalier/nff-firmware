# nff-dashboard — Backend API Contract

This document defines every HTTP and WebSocket endpoint the frontend needs. The frontend currently uses mock data everywhere. Each section identifies the component/file that must be updated to consume the real endpoint.

Base URL: `http://<host>/api`  
WebSocket base: `ws://<host>/ws`

---

## REST Endpoints

### Devices

#### `GET /api/devices`

Returns the full device fleet.

**Response `200`**

```json
[
  {
    "id": "dev-001",
    "name": "Gateway Node Alpha",
    "status": "online",
    "firmwareVersion": "2.1.4",
    "agentConnected": true,
    "lastSeen": "2026-06-01T10:42:00Z",
    "ipAddress": "192.168.1.100",
    "rssi": -62,
    "uptimeSeconds": 864000
  }
]
```

`rssi` is `null` for wired devices.  
`status` is one of `"online" | "offline" | "warning" | "error"`.

**Frontend seam**: `src/data/mockDevices.ts` — replace the exported array with a `fetch('/api/devices')` call.

---

#### `GET /api/devices/:id`

Returns a single device.

**Response `200`** — same shape as one element of the list above.  
**Response `404`** — `{ "error": "device not found" }`

**Frontend seam**: `DeviceDetailTab.tsx` — load device on mount (currently receives it as a prop from mock state).

---

#### `PATCH /api/devices/:id`

Update mutable device fields (e.g. rename).

**Request body** (all fields optional)

```json
{
  "name": "Sensor Hub Beta (relocated)"
}
```

**Response `200`** — updated `Device` object.

**Frontend seam**: Not yet wired; add a rename handler in `DeviceDetailTab.tsx`.

---

#### `GET /api/devices/:id/telemetry`

Returns the last N telemetry snapshots for a device.

**Query params**: `?limit=50` (default 50)

**Response `200`**

```json
[
  {
    "ts": "2026-06-01T10:42:00Z",
    "rssi": -64,
    "heapFree": 42108,
    "packetsRx": 1024,
    "packetsTx": 1018,
    "tempC": 38.2
  }
]
```

**Frontend seam**: `DeviceDetailTab.tsx` — replace the `setInterval` random-data loop with this endpoint (initial load) + WebSocket for live updates.

---

### Agent

#### `GET /api/agent/config`

Returns the agent's current configuration: priorities, tools, and active task.

**Response `200`**

```json
{
  "priorities": [
    { "id": "p1", "label": "Maintain the fleet", "enabled": true },
    { "id": "p2", "label": "Security audit",    "enabled": true }
  ],
  "tools": [
    {
      "id": "t1",
      "name": "Diagnostics Tool",
      "description": "Run device diagnostics",
      "status": "online",
      "active": true
    }
  ],
  "task": {
    "title": "Fleet maintenance sweep",
    "steps": [
      { "id": "s1", "label": "Scan all devices",     "status": "done"    },
      { "id": "s2", "label": "Identify anomalies",   "status": "running" },
      { "id": "s3", "label": "Apply patches",        "status": "pending" }
    ]
  }
}
```

**Frontend seam**: `AgentManagementTab.tsx` — replace `DEFAULT_PRIORITIES`, `DEFAULT_TOOLS`, `DEFAULT_TASK` constants.

---

#### `PUT /api/agent/config`

Persist updated priorities and tools. The full config object is replaced.

**Request body** — same shape as `GET /api/agent/config` response (task field ignored; tasks are server-managed).

**Response `200`** — updated config.

**Frontend seam**: `AgentManagementTab.tsx` — call on every user change (add/remove/reorder priorities, add/remove/toggle tools).

---

#### `GET /api/agent/tasks`

Returns recent agent tasks (current + history).

**Query params**: `?limit=10`

**Response `200`**

```json
[
  {
    "id": "task-42",
    "title": "Fleet maintenance sweep",
    "createdAt": "2026-06-01T10:00:00Z",
    "completedAt": null,
    "steps": [
      { "id": "s1", "label": "Scan all devices",   "status": "done"    },
      { "id": "s2", "label": "Identify anomalies", "status": "running" }
    ]
  }
]
```

**Frontend seam**: `AgentManagementTab.tsx` — replace the static `DEFAULT_TASK`.

---

### Agent Chat

#### `GET /api/agent/messages`

Returns the agent chat history.

**Query params**: `?limit=100&before=<iso-timestamp>`

**Response `200`**

```json
[
  {
    "id": "msg-001",
    "role": "agent",
    "content": "Starting fleet scan…",
    "timestamp": "2026-06-01T10:00:01Z"
  }
]
```

`role` is `"user" | "agent"`.

**Frontend seam**: `AgentTab.tsx` / `ChatPanel.tsx` — replace scenario-driven message array.

---

#### `POST /api/agent/messages`

Send a user message to the agent.

**Request body**

```json
{
  "content": "What is the status of dev-003?"
}
```

**Response `202`**

```json
{
  "id": "msg-042",
  "role": "user",
  "content": "What is the status of dev-003?",
  "timestamp": "2026-06-01T10:05:00Z"
}
```

The agent reply arrives over `ws://<host>/ws/agent/events` (see below).

---

### Query (field-level AI query)

#### `POST /api/query`

Ask the AI agent a question about a specific device field.

**Request body**

```json
{
  "deviceId": "dev-003",
  "field": "firmwareVersion",
  "value": "1.8.2",
  "message": "Is this firmware up to date?"
}
```

**Response `200`**

```json
{
  "reply": "Firmware 1.8.2 is two minor versions behind the current stable release 2.1.4. I recommend scheduling an OTA update during the next maintenance window."
}
```

**Frontend seam**: `QueryPopup.tsx` → replace `generateAgentReply()` with this call. Show `thinking` spinner while awaiting response.

---

### Feedback

#### `POST /api/feedback`

Submit user feedback.

**Request body**

```json
{
  "category": "bug",
  "message": "The RSSI column sorts incorrectly for null values."
}
```

`category` is `"bug" | "feature" | "other"`.

**Response `201`** — `{ "id": "fb-007" }`

**Frontend seam**: `FeedbackPopup.tsx` — wire the submit button handler.

---

## WebSocket Streams

### `ws://<host>/ws/agent/events`

Real-time stream of agent chat messages and console log entries. Subscribe once on app mount; keep alive for the session.

**Server → client message envelope**

```json
{
  "type": "chat_message | console_entry | task_update",
  "payload": { ... }
}
```

#### `type: "chat_message"`

```json
{
  "type": "chat_message",
  "payload": {
    "id": "msg-043",
    "role": "agent",
    "content": "OTA patch applied to dev-003.",
    "timestamp": "2026-06-01T10:06:12Z"
  }
}
```

#### `type: "console_entry"`

```json
{
  "type": "console_entry",
  "payload": {
    "id": "con-201",
    "entryType": "command",
    "content": "ota apply dev-003 v2.1.4",
    "timestamp": "2026-06-01T10:06:10Z"
  }
}
```

`entryType` is `"command" | "output" | "error" | "info"`.

#### `type: "task_update"`

```json
{
  "type": "task_update",
  "payload": {
    "taskId": "task-42",
    "stepId": "s2",
    "status": "done"
  }
}
```

**Frontend seam**: `AgentTab.tsx` — replace the `SCENARIOS` `useEffect` loop.

---

### `ws://<host>/ws/devices/:id/telemetry`

Per-device real-time telemetry stream.

**Server → client**

```json
{
  "ts": "2026-06-01T10:42:05Z",
  "rssi": -66,
  "heapFree": 41200,
  "packetsRx": 1025,
  "packetsTx": 1019,
  "tempC": 38.5
}
```

**Frontend seam**: `DeviceDetailTab.tsx` — replace the `setInterval` loop with this WebSocket; append entries to `ConsoleEntry[]` for display in `ConsolePanel`.

---

### `ws://<host>/ws/devices`

Fleet-level status updates (device comes online/offline, RSSI changes, etc.).

**Server → client**

```json
{
  "type": "device_update",
  "payload": {
    "id": "dev-007",
    "status": "online",
    "rssi": -58,
    "lastSeen": "2026-06-01T10:42:06Z"
  }
}
```

Only the changed fields are included alongside `id`. The frontend merges the patch into its device list.

**Frontend seam**: `App.tsx` — subscribe on mount; update the `devices` state array via a reducer that merges partial updates by `id`.

---

## Error format

All error responses follow:

```json
{
  "error": "human-readable message",
  "code": "MACHINE_CODE"
}
```

Common codes: `NOT_FOUND`, `VALIDATION_ERROR`, `AGENT_UNAVAILABLE`, `INTERNAL_ERROR`.

Invoke-WebRequest -Uri "http://127.0.0.1:3000/oauth/authorize?redirect_uri=http://127.0.0.1:9999/callback&state=test"  -MaximumRedirection 0 -ErrorAction SilentlyContinue | Select-Object   StatusCode, Headers

---

## Authentication (not yet implemented)

When authentication is added, all requests should include:

```
Authorization: Bearer <token>
```

WebSocket connections should pass the token as a query parameter: `?token=<token>` (or via a handshake message if the transport does not support headers).
