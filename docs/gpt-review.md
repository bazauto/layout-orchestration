# GPT Review: Project Plan

Overall assessment: the direction is sound, the local-first constraint is sensible, and the stack choice is practical. I would not treat the plan as implementation-ready yet. The main gaps are around safety behaviour, protocol contracts, and the domain model needed to support automation without later rework.

## Findings

### 1. Critical: the plan does not define a fail-safe operating model for loss of certainty
Reference: `docs/project-plan.md` lines 19-29 and 44-46.

The plan talks about collision avoidance, block detection, and state recovery, but it never states what the system must do when it is uncertain. Examples:

- MQTT broker disconnects.
- A sensor stops reporting.
- The DCC controller stops acknowledging commands.
- A throttle controller disappears mid-move.
- On restart, the orchestrator does not know where a locomotive actually is.

For a control system, this cannot be left implicit. You need a clear safety rule such as: when state is uncertain, automation degrades to safe-stop, new routes cannot be granted, and the operator must explicitly recover the affected area or locomotive. If you leave this until later, the automation and manual-control flows will be built on assumptions that are unsafe or inconsistent.

### 2. Critical: MQTT is chosen, but the control semantics are still undefined
Reference: `docs/project-plan.md` lines 10-11, 26-28, and 34.

The plan says MQTT will carry controller and sensor traffic, but the review needs to go beyond topic naming. For control traffic you need to define:

- Topic hierarchy.
- Payload schema.
- QoS level per message type.
- Whether messages are retained.
- Acknowledgement and timeout behaviour.
- Heartbeat or presence topics.
- Duplicate delivery handling.

This matters because safe control traffic behaves differently from telemetry. For example, retained throttle commands are dangerous after reconnect, while retained configuration or presence state may be useful. Without this contract defined first, the backend and ESP firmware will either diverge or, worse, behave unpredictably during reconnects.

### 3. High: the domain model is too thin for routeing and automation
Reference: `docs/project-plan.md` lines 15-23.

The proposed schema lists locos, rolling stock, points, sensors, and blocks, but that is not enough to drive automated movement. The system will also need explicit modelling for at least some of the following:

- Track sections or graph edges between blocks.
- Point leg topology.
- Route definitions and route reservations.
- Train consists or active movements.
- Commands and jobs distinct from infrastructure routes.
- Optional signalling state if you ever surface route authority visually.

If you only model points and blocks, routeing logic ends up encoded in application code or hard-coded per layout. That would directly undermine the stated goal of keeping the platform layout-agnostic.

### 4. High: manual, auto, and hybrid control are requirements but not system concepts yet
Reference: `docs/project-plan.md` lines 19-23.

The plan mentions Auto mode in the automation engine step, but there is no model for control authority. Before implementation, define whether authority is granted at the level of:

- Entire layout.
- Individual locomotive.
- Individual block or route.
- Operator session.

Hybrid mode especially needs a precise rule set. If an operator takes manual control of a loco already participating in an automated job, what happens to the reservation, scheduler, and safety logic? If this is not designed up front, hybrid mode will become a collection of exceptions rather than a coherent operating model.

### 5. High: the testing section is good in intent, but too shallow for a control system
Reference: `docs/project-plan.md` lines 25-29 and 37-42.

The plan says to use Vitest and simulate hardware, which is the right direction. What is missing is the structure of the test strategy. For this project, I would expect at least four layers:

- Unit tests for pure domain logic.
- Contract tests for MQTT payload schemas and serial protocol adapters.
- Integration tests with simulated broker, DCC controller, and sensor streams.
- Scenario tests that replay operating sequences such as route grant, occupancy transition, sensor loss, and emergency halt.

The important point is that core automation logic must be testable without real hardware. That means designing around ports/adapters from day one, not adding mocks after the fact.

### 6. Medium: the plan is missing an explicit simulator and replay harness
Reference: `docs/project-plan.md` lines 8-12 and 25-29.

For a hardware-heavy system, a simulator is not just a testing aid; it is a development tool. You will move faster if the project has a first-class simulated DCC controller, simulated sensors, and a way to replay recorded MQTT traffic and command sequences. That allows you to test timetable logic, locking, recovery, and UI updates without the layout powered up.

I would elevate this into Phase 1 rather than treating it as an incidental testing detail.

### 7. Medium: production-readiness for a local Linux service is under-specified
Reference: `docs/project-plan.md` lines 8, 37-42, and 44-46.

The plan says local-only and production-ready, but operational concerns are not yet called out. You will want to decide early on:

- How the service runs on Linux, likely via `systemd`.
- Where configuration lives.
- How secrets or broker credentials are stored.
- How logs rotate.
- How backups of the SQLite database and layout configuration are taken.
- How health and readiness are exposed.

These are not glamorous, but they are exactly the pieces that separate a hobby prototype from something you can leave running reliably.

### 8. Medium: multi-layout support is implied but not planned explicitly
Reference: `docs/project-plan.md` line 3 and lines 15-17.

The plan says the platform should support future layouts, but there is no explicit concept of layout identity, configuration versioning, or export/import. If you want to carry the software forward from Westgate Hollow to a bigger layout, you should plan for:

- Multiple saved layouts.
- Layout-scoped identifiers.
- Import/export of layout definitions.
- Versioned configuration migrations.
- Separation between reusable engine logic and layout-specific data.

This is much easier to get right now than after the first layout becomes the implicit data shape.

### 9. Medium: the scheduler and route concepts need separating
Reference: `docs/project-plan.md` lines 21-23.

The plan currently treats routes, orders, and scheduling as a single flow. I would separate them explicitly:

- A route is an infrastructure path through points and blocks.
- A movement or job is an instruction for a locomotive or consist.
- A schedule is a timed or conditional trigger for jobs.

If these remain blurred, the scheduler will either become too layout-specific or the routeing engine will carry business rules it should not own.

### 10. Low: Phase 1 order should be adjusted so protocol design comes before transport implementation
Reference: `docs/project-plan.md` lines 10-11.

The plan currently puts MQTT client implementation before protocol definition. Reverse those. Payload and topic contracts are an input to implementation, not a product of it.

## Recommendation

I would commit to implementation after tightening five things in the main plan:

1. Add an explicit fail-safe and recovery policy.
2. Define the MQTT command and telemetry contract in detail.
3. Expand the domain model beyond points and blocks to include topology and reservations.
4. Define control authority for manual, auto, and hybrid operation.
5. Add a simulator/replay harness as a first-class Phase 1 deliverable.

With those in place, the rest of the plan looks like a sensible basis for a strong first implementation.
