# Model Railway Layout Orchestrator - Engineering Standards

This file defines the strict architectural and engineering standards for the Westgate Hollow / Layout Orchestrator project. Whenever you write code or design architecture for this project, you MUST adhere to the following principles.

## 1. Safety and Fail-Safe Posture
- Assume an unreliable network.
- **Fail-Safe First:** If the state of a sensor, block, MQTT connection, or DCC sequence becomes uncertain, the default action is a **Safe-Stop** (halt all automated movements, lock points, and require operator intervention).
- Avoid implicit assumptions about train locations.

## 2. Hardware and Protocol Separation (Ports and Adapters)
- Business logic (routing, collisions, automation) MUST be strictly separated from the transport layer.
- Never write business logic inside an MQTT callback, Serial event handler, or HTTP/WebSocket controller.
- Use explicit Adapters for the Mosquitto MQTT broker, DCC EX Serial connection, and WebSockets.
- Always validate incoming payloads (e.g., using Zod or a JSON Schema validation tool) before processing them in the domain layer.

## 3. Communication Standards
- **Real-Time Data:** Use WebSockets or Server-Sent Events (SSE) for pushing layout state updates to the React frontend. Do not use polling.
- **Control vs. Telemetry:** Distinguish between Control commands (Throttles, Point settings) and Telemetry (Sensor states, Block occupancy). Apply appropriate QoS and retention policies in MQTT (e.g., do not retain throttle commands to avoid ghost movements on reconnection).
- **Structured Logging:** Use `Pino` (or similar) to output structured JSON logs. Include context like `layoutId`, `locoAddress`, `blockId`, or `commandId` for tracing asynchronous behaviors.

## 4. Modeling & State
- **Domain Accuracy:** Model explicit track topology (graphs, edges), route reservations, consists, and control authority modes (Manual, Auto, Hybrid).
- **Control Authority:** Clearly encode who or what has control over a block or loco (e.g., Operator vs. Automation Engine). Reject conflicting commands gracefully.

## 5. Testing & Simulation
- **Simulator-Driven Validation:** The backend must be testable without the physical DCC controller or actual sensor hardware.
- Write Unit Tests for pure domain logic.
- Write Integration and Scenario Tests using a simulated MQTT broker and simulated DCC serial stream.
- **Framework:** Use `Vitest` unified across frontend and backend.

## 6. Local Node.js Production Readiness
- **Database:** Use SQLite via a strong ORM (e.g., `Drizzle ORM`) with explicit schema migration scripts.
- **Deployment:** Target local Linux execution (e.g., via `systemd`). Ensure paths to databases and config files are environment-agnostic or configurable.
