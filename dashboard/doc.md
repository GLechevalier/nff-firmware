# nff-dashboard — Component & Data Model Reference

## Data models

### `Device` (`src/types/device.ts`)

```typescript
type DeviceStatus = 'online' | 'offline' | 'warning' | 'error';

interface Device {
  id: string;            // unique identifier, e.g. "dev-001"
  name: string;          // human-readable label
  status: DeviceStatus;
  firmwareVersion: string; // semver string, e.g. "2.1.4"
  agentConnected: boolean;
  lastSeen: Date;
  ipAddress: string;
  rssi: number | null;   // dBm; null means wired (no wireless signal)
  uptimeSeconds: number;
}
```

### `ChatMessage` (used in `ChatPanel`, `QueryPopup`)

```typescript
interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
}
```

### `ConsoleEntry` (used in `ConsolePanel`, `DeviceDetailTab`)

```typescript
type ConsoleEntryType = 'command' | 'output' | 'error' | 'info';

interface ConsoleEntry {
  id: string;
  type: ConsoleEntryType;
  content: string;
  timestamp: Date;
}
```

### `Priority` (used in `AgentManagementTab`)

```typescript
interface Priority {
  id: string;
  label: string;
  enabled: boolean;
}
```

### `Tool` (used in `AgentManagementTab`)

```typescript
type ToolStatus = 'online' | 'warning' | 'error';

interface Tool {
  id: string;
  name: string;
  description: string;
  status: ToolStatus;
  active: boolean;
}
```

### `AgentTask` / `TaskStep` (used in `AgentManagementTab`)

```typescript
type StepStatus = 'done' | 'running' | 'pending';

interface TaskStep {
  id: string;
  label: string;
  status: StepStatus;
}

interface AgentTask {
  title: string;
  steps: TaskStep[];
}
```

---

## Component reference

### `App` (`src/App.tsx`)

Root layout. Owns global state.

**State**

| Name | Type | Purpose |
|------|------|---------|
| `activeTab` | `TabId` | Which tab is shown |
| `selectedDevice` | `Device \| null` | Device whose detail tab is open |
| `splitPct` | `number` | Vertical split % between device table and agent panels |
| `queryMode` | `boolean` | Whether the Query tool overlay is active |
| `queryTarget` | `QueryTarget \| null` | The device + field the user clicked in query mode |
| `feedbackOpen` | `boolean` | Whether the feedback modal is open |

**Props received** — none (root component)

**Key callbacks passed down**

| Callback | Passed to | Effect |
|----------|-----------|--------|
| `onDeviceClick(device)` | `DeviceTable` | Opens device detail tab |
| `onCellClick(device, field, value)` | `DeviceTable` | Opens `QueryPopup` |
| `onClose()` | `DeviceDetailTab` | Closes device detail tab |
| `onQueryClose()` | `QueryPopup` | Dismisses query popup |
| `onFeedbackClose()` | `FeedbackPopup` | Dismisses feedback modal |

---

### `TabBar` (`src/components/TabBar.tsx`)

Renders the navigation pill buttons at the top of the page.

**Props**

| Prop | Type | Description |
|------|------|-------------|
| `tabs` | `Tab[]` | Array of `{ id: TabId, label: string }` |
| `activeTab` | `TabId` | Highlighted tab |
| `onTabChange` | `(id: TabId) => void` | Called on click |

---

### `AgentManagementTab` (`src/components/AgentManagementTab.tsx`)

Left panel: priority list (draggable) + current task steps.  
Right panel: hooked-tools topology SVG diagram.

**Props** — none (self-contained with default state)

**Internal state**

| Name | Purpose |
|------|---------|
| `priorities` | Ordered list of agent priorities with enabled flag |
| `tools` | Tool objects with status/active flags |
| `task` | Current agent task with step statuses |
| `splitPct`, `leftSplitPct` | Draggable pane percentages |
| `addingPriority`, `newPriorityLabel` | Inline add-priority form |
| `addingTool`, `newToolName` | Inline add-tool form |

**User interactions**

- Drag priority rows to reorder
- Toggle priority checkboxes
- Add / delete priorities inline
- Click tool nodes to cycle status (`online → warning → error → online`)
- Toggle tool active state
- Add / delete tools

---

### `AgentTab` (`src/components/AgentTab.tsx`)

Split view: `ChatPanel` + `ConsolePanel`. Runs pre-scripted IoT problem scenarios that loop indefinitely.

**Props**

| Prop | Type | Description |
|------|------|-------------|
| `devices` | `Device[]` | Fleet device list |
| `onDeviceClick` | `(d: Device) => void` | Opens device detail |
| `onCellClick` | `(d, field, value) => void` | Query mode click |
| `queryMode` | `boolean` | Highlights queryable cells |

**Mock-to-real migration point**

Replace the `SCENARIOS` array and `useEffect` loop in this file with a WebSocket connection to `ws://<host>/ws/agent/events` (see `api.md`).

---

### `ChatPanel` (`src/components/ChatPanel.tsx`)

Scrollable chat bubble list.

**Props**

| Prop | Type | Description |
|------|------|-------------|
| `messages` | `ChatMessage[]` | Messages to render |

---

### `ConsolePanel` (`src/components/ConsolePanel.tsx`)

Dark terminal-style log panel.

**Props**

| Prop | Type | Description |
|------|------|-------------|
| `entries` | `ConsoleEntry[]` | Log lines to render |
| `onClear` | `() => void` | Clears entries |

Entry type styling: `command` → `>` prefix amber, `output` → gray, `error` → red, `info` → `#` prefix cyan.

---

### `DeviceDetailTab` (`src/components/DeviceDetailTab.tsx`)

Shows a single device's properties and a live signal console.

**Props**

| Prop | Type | Description |
|------|------|-------------|
| `device` | `Device` | Device to display |
| `onClose` | `() => void` | Closes the tab |

**Mock-to-real migration point**

Replace the `setInterval` telemetry loop with a WebSocket subscription to `ws://<host>/ws/devices/:id/telemetry`.

---

### `DeviceTable` (`src/components/DeviceTable.tsx`)

Sortable data grid for the device fleet.

**Props**

| Prop | Type | Description |
|------|------|-------------|
| `devices` | `Device[]` | Rows to render |
| `onDeviceClick` | `(d: Device) => void` | Row action button |
| `onCellClick` | `(d, field, value) => void` | Query mode cell click |
| `queryMode` | `boolean` | Activates cell highlight + `⊕` icons |

**Columns**: ID, Name, Status, Firmware, Agent, Last Seen, IP, RSSI, Uptime.

---

### `StatusBadge` (`src/components/StatusBadge.tsx`)

**Props**: `status: DeviceStatus` → colored dot + label.

Color map: `online` → `#22c55e`, `warning` → `#eab308`, `error` → `#ef4444`, `offline` → `#6b7280`.

---

### `AgentBadge` (`src/components/AgentBadge.tsx`)

**Props**: `connected: boolean` → renders `"yes"` (green) or `"—"` (gray).

---

### `QueryPopup` (`src/components/QueryPopup.tsx`)

Fixed-position modal for querying a device field with an AI agent.

**Props**

| Prop | Type | Description |
|------|------|-------------|
| `device` | `Device` | Context device |
| `field` | `string` | Field name (e.g. `"firmwareVersion"`) |
| `value` | `string` | Current field value shown in header |
| `onClose` | `() => void` | Dismiss |

**Mock-to-real migration point**

Replace `generateAgentReply()` with a call to `POST /api/query` (see `api.md`).

---

### `FeedbackPopup` (`src/components/FeedbackPopup.tsx`)

Modal with category pills (Bug / Feature / Other) and a text area.

**Props**: `onClose: () => void`

**Mock-to-real migration point**

Wire the submit handler to `POST /api/feedback` (see `api.md`).

---

## Current mock data

| File | What it contains |
|------|-----------------|
| `src/data/mockDevices.ts` | 10 hardcoded `Device` objects |
| `AgentTab.tsx` → `SCENARIOS` | 5 step-by-step IoT problem scenarios with chat + console lines |
| `QueryPopup.tsx` → `generateAgentReply()` | Pattern-matched mock responses per field type |
| `AgentManagementTab.tsx` → `DEFAULT_*` | Default priorities, tools, and task |

All of these are the integration seams — replace them with API calls and WebSocket streams as described in `api.md`.
