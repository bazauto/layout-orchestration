# Layout Orchestrator: Project Plan & Architecture

This is an automated, web-based layout orchestrator designed to replace JMRI. It provides manual and automated control via DCC, MQTT sensors, and custom throttle hardware. Everything is layout-agnostic and data-driven to easily support future layouts (starting with Westgate Hollow Yard).

## Phase 0: System Design & Contracts (Pre-requisite)
Before implementation begins, we must define the core architectural contracts and safety models:

1. **Safety & Fail-Safe Policy:** Define the exact behavior when the system loses certainty (e.g., MQTT disconnects, lost sensors, missed DCC acknowledgements). Default posture: **Safe-Stop** (stop all automated trains, prevent new routes, require manual operator recovery).
2. **Control Authority & Operating Modes:** Define how Authority is granted (per layout, per block, per loco) across Manual, Auto, and Hybrid modes. Explicitly define what happens when an operator overrides an active automated route.
3. **MQTT Contract Definition:** Define the topic hierarchy, payload schemas (JSON), QoS levels, and retained-message policies for Control (throttle, point setting) vs. Telemetry (sensor state, occupancy).
4. **Layout Builder Vocabulary:** Define the dictionary of valid UI tiles (Straight, Curve, Left/Right Points, Buffer, etc.) to drive both the frontend grid and the backend topology.
5. **Real-Time UI Strategy:** Establish the mechanism for pushing immediate state updates to the browser (e.g., WebSockets / Server-Sent Events) rather than polling.

## Phase 1: Foundation, Transport & Simulation (MVP)
1. **Infrastructure:** Set up a local `Mosquitto` MQTT broker on the Linux host.
2. **Backend Scaffolding:** Initialize a Node.js/TypeScript backend using `Fastify` or `Hono` (for high-performance WebSocket/SSE support), and an SQLite database wrapped with a migration tool (e.g., `Drizzle ORM`).
3. **Hardware Simulator:** Build a first-class simulator and replay harness to emulate the DCC controller, sensor streams, and MQTT traffic. *Core logic must be testable without actual physical hardware.*
4. **Hardware Interfaces:** 
   - Implement the Serial interface for the custom DCC EX controller.
   - Implement the generic MQTT client.
5. **Frontend Scaffolding:** Create a Vite/React frontend to issue manual commands for testing.

## Phase 2: Data Modeling & Topology
6. **Domain Modeling:** Design a robust schema that goes far beyond simple points and blocks. Include:
   - *Physical Infrastructure:* Points, Sensors, Blocks, and Track Topology (graph edges linking blocks).
   - *Roster:* Locos, Rolling Stock, Train Consists.
   - *State:* Route Reservations, Active Movements.
   - *Multi-Layout Support:* Layout-scoped identifiers to support exporting/importing different setups.
7. **CRUD APIs:** Build the interfaces for layout config and roster management. Use explicit database migrations for schema evolution.
8. **Layout UI:** Build the grid-based interface using the pre-defined tile vocabulary to visually represent any custom layout.

## Phase 3: Routing, Movements & Automation
*Crucial: Separate Routeing (infrastructure paths) from Movements/Jobs (loco instructions) and Schedules (time/event triggers).*

9. **Route Locking:** Implement reservation logic to lock points/blocks, utilizing the Fail-Safe policy if conflicts occur.
10. **Automation Engine:** Implement collision avoidance and dynamic speed adjustment. This requires a **braking model** per loco class (stopping distance vs direction/speed/topology).
11. **Order & Scheduling Systems:** Build the trigger system for sequential or interval-based jobs.

## Verification & Testing Strategy
A control system requires rigorous, layered testing:
- **Unit Tests:** Pure domain logic (Vitest).
- **Contract Tests:** Validate MQTT payload schemas and serial adapter bindings.
- **Integration Tests:** Run against the simulated MQTT broker and simulated DCC controller.
- **Scenario Tests:** Replay operating sequences (e.g., route grant, occupancy transition, sensor loss, emergency halt).

## Engineering Standards & Production Readiness
- **Testing, Linting & Formatting:** ESLint, Prettier, Husky pre-commit hooks.
- **Architecture:** Layered design (Ports and Adapters). Hardware interfaces ↔ Services/Domain Logic ↔ API/WebSockets. Business logic must be entirely independent of hardware specifics.
- **Linux Operations:** Designed for `systemd` deployment. Include structured logging (`Pino`), SQLite automated backups, configuration management, and log rotation.
- **CI/CD:** GitHub Actions configured from day one to run tests and linters on every push.

## Further Considerations
1. **ESP Controller Refactor:** You will need to update the `bazauto/esp-layout-controller` repo to replace WiThrottle with an MQTT client (like PubSubClient) that respects the JSON payload contracts defined in Phase 0.
2. **State Recovery:** If the system restarts, does it auto-poll the layout or assume an empty layout until sensors are tripped?
