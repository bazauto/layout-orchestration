# Layout Orchestrator

Model railway layout orchestration for the Westgate Hollow project.

This repository contains a local-first control stack for a DCC-based layout:
- A Node.js backend for layout state, MQTT integration, DCC control, SQLite persistence, REST APIs, and WebSocket updates
- A React frontend for operating the layout, editing topology, and configuring blocks, sensors, points, locos, and track tiles

The project is currently in the layout-definition and operator tooling phase. Route reservation and automation are planned next.

## Current Status

Implemented:
- Backend domain safety and state logic
- MQTT and DCC adapter abstraction with simulator support
- SQLite persistence via Drizzle ORM with auto-migrate on startup
- REST API for layouts, locos, blocks, points, sensors, and grid tiles
- WebSocket state streaming to the frontend
- Frontend operate screen for throttle, points, and live state
- Frontend configuration screen for blocks, sensors, points, and locos
- Track editor with tile palette, rotation, keyboard shortcuts, hover ghost preview, and persistence
- Backend unit/integration tests and Playwright frontend end-to-end tests
- GitHub Actions CI

Planned next:
- Route reservation engine
- Automation engine / schedules

## Workspace Layout

```text
.
├─ packages/
│  ├─ backend/   # Fastify, MQTT/DCC adapters, domain logic, DB, tests
│  └─ frontend/  # React + Vite operator/config/editor UI
├─ tests/
│  └─ e2e/       # Playwright end-to-end tests
├─ .github/
│  └─ workflows/ # CI
└─ docs/         # Project notes and contracts
```

## Requirements

- Node.js 20+
- npm
- Optional for hybrid/full hardware modes:
  - MQTT broker (for example Mosquitto)
  - DCC EX serial controller

## Installation

```powershell
npm install
```

## Environment

Copy the example file and adjust values as needed:

```powershell
Copy-Item .env.example .env
```

Important mode flags:

- `USE_SIMULATOR=true` → full simulator, no broker and no hardware required
- `USE_SIMULATOR=false` + `DCC_SIMULATOR=true` → hybrid mode, real MQTT broker + simulated DCC
- `USE_SIMULATOR=false` + `DCC_SIMULATOR=false` → full hardware mode, real MQTT broker + DCC serial controller

Default local development is typically best in hybrid mode.

## Running Locally

Start backend:

```powershell
npm run dev:backend
```

Start frontend:

```powershell
npm run dev:frontend
```

Frontend runs on Vite's dev server and talks to the backend on port `3000`.

## Database

The backend uses SQLite with Drizzle ORM.

On startup the backend automatically applies pending migrations from `MIGRATIONS_PATH`.

Useful commands:

```powershell
npm run db:generate --workspace=packages/backend
npm run db:migrate --workspace=packages/backend
npm run db:push --workspace=packages/backend
npm run db:seed --workspace=packages/backend
```

`db:seed` creates a useful starter layout with:
- blocks
- points
- sensors
- locos

## Testing

Run all workspace tests:

```powershell
npm test
```

Run lint:

```powershell
npm run lint
```

Run Playwright end-to-end tests:

```powershell
npm run test:e2e
```

Current automated coverage includes:
- backend domain unit tests
- backend service tests
- backend HTTP route integration tests
- Playwright tests for editor happy path, erase flow, keyboard shortcuts, and no-scrollbar viewport regression

## Frontend Features

### Operate
- System status bar
- Emergency stop
- Mode selection
- Loco throttle with roster dropdown
- Live block and point state display

### Configure
- CRUD for blocks, sensors, points, and locos
- Inline editing

### Track Editor
- Tile-based sparse grid persisted to backend
- Straight, corner, point, crossing, buffer, and platform tiles
- Rotation in 45° steps
- Keyboard shortcuts:
  - `1-7` select tile type
  - `R` rotate +45°
  - `Shift+R` rotate -45°
- Mouse controls:
  - left drag to paint
  - right click to erase
  - middle drag to pan
  - wheel to zoom

## CI

GitHub Actions currently runs:
- install
- lint
- workspace tests
- backend build
- Playwright browser install
- Playwright end-to-end tests

## Safety Notes

The system follows a fail-safe posture:
- unknown/unhealthy transport states should result in safe-stop behavior
- business logic is separated from transport callbacks
- MQTT and DCC are abstracted behind ports/adapters
- simulation remains a first-class development mode

## Known Limits

A formal track graph now exists — `block_edges` in the schema, with construction and
traversal in `domain/graph.ts` — but nothing is wired to it yet: there is no repository
read path, and topology editing in the UI is still tile-based, so edges cannot be
authored. Reservations, automation, and route locking are not implemented.

## Next Milestones

1. Route reservation engine
2. Automation engine / schedules
3. Richer topology semantics from grid tiles
4. Hardware validation and operator workflows
