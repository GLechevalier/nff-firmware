# nff dashboard

The fleet dashboard, app.nanoforgeflow.com: IoT fleet monitoring and AI agent management, built with React 19, TypeScript and Vite. Vercel deploys this directory from `main` (project `nff-app`, root directory `dashboard`). It moved here from the nff-app repo in Oct 2026; the company's own admin apps live in nff-admin.

## What it does

The dashboard gives operators a single pane of glass over a fleet of IoT devices (sensors, gateways, controllers, actuators). It surfaces real-time device health, firmware versions, connectivity status, and RSSI readings. An integrated AI agent interface lets users observe and direct an autonomous firmware engineer that performs diagnostics, OTA updates, calibration fixes, and security audits across the fleet.

## Screenshots / Tabs

| Tab | Purpose |
|-----|---------|
| **Management** | Configure agent priorities, inspect current task progress, and manage the set of hooked tools shown in a circular topology diagram |
| **Agent** | Split view — device table on the left, agent chat + console output on the right; AI narrates its actions in real time |
| **Device Detail** | Opens on device click — full device properties plus a live signal console streaming telemetry |

## Tech stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript 6 |
| UI | React 19 |
| Build | Vite 8 |
| Styling | Tailwind CSS 4 + inline styles |
| State | React hooks (no external library) |
| Routing | Tab-based (no React Router) |
| API | **Mock only** — see `api.md` for the backend contract |

## Getting started

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm run build      # type-check + production bundle → dist/
npm run preview    # preview the production bundle locally
npm run lint       # ESLint check
```

## Project structure

```
src/
├── types/
│   └── device.ts              # Device, DeviceStatus types
├── data/
│   └── mockDevices.ts         # 10 hardcoded mock devices (replace with API)
├── components/
│   ├── TabBar.tsx
│   ├── AgentManagementTab.tsx
│   ├── AgentTab.tsx
│   ├── ChatPanel.tsx
│   ├── ConsolePanel.tsx
│   ├── DeviceDetailTab.tsx
│   ├── DeviceTable.tsx
│   ├── StatusBadge.tsx
│   ├── AgentBadge.tsx
│   ├── QueryPopup.tsx
│   └── FeedbackPopup.tsx
└── App.tsx                    # Root layout + global state
```

## Connecting to a backend

All mock data lives in `src/data/mockDevices.ts` and the hardcoded scenario arrays inside `AgentTab.tsx` and `QueryPopup.tsx`. The full REST + WebSocket API surface is documented in [`api.md`](./api.md). `doc.md` covers the component API and data models in detail.
