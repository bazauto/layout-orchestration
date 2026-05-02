# Claude Review: Project Plan

Overall the direction is sound and the technology choices are good. The observations below are grouped by priority — those that should be resolved *before* writing any code, and those that can be addressed incrementally during the relevant phase.

---

## Must Resolve Before Implementation

### 1. MQTT Broker is Missing from the Architecture
The plan assumes MQTT throughout but never mentions who *runs* the broker. A local **Mosquitto** instance on the same Linux machine is a pre-requisite infrastructure item. Nothing else in the stack works until it exists. It should be added as an explicit setup step in Phase 1.

### 2. MQTT Topic Structure is Undefined
This is the most critical gap. Before writing a single line of code, an agreed topic hierarchy must exist that both the backend and ESP hardware will use. Without it, both ends get built on different assumptions and require a full rewrite to reconcile. A proposed starting structure:

```
layout/{layoutId}/loco/{address}/throttle       # backend → ESP throttle command
layout/{layoutId}/loco/{address}/state          # backend broadcast of loco state
layout/{layoutId}/sensor/{sensorId}/state       # sensor hardware → backend
layout/{layoutId}/point/{pointId}/set           # backend → DCC controller
layout/{layoutId}/point/{pointId}/state         # DCC controller → backend confirmation
layout/{layoutId}/block/{blockId}/occupied      # backend broadcast block occupancy
```

This must be agreed and documented before implementing either the MQTT client (Phase 1 Step 3) or the ESP firmware refactor.

### 3. Operating Modes are Entirely Missing
The original requirements explicitly list Manual, Auto, and Hybrid modes — yet none of the three phases address them. This is a fundamental architectural decision that needs answering before Phase 3:

- Does the system have a single global mode switch, or can individual locos have independent modes?
- In Hybrid mode, which resources (blocks, locos) are under automation and which under manual control?
- What happens to an in-flight automated route when the operator flips to Manual? (Emergency stop? Route completes? Operator takes over?)

### 4. No Real-Time UI Update Strategy
The plan describes a live layout schematic but doesn't specify how the backend *pushes* state changes to the browser. When a block becomes occupied, the signal on the mimic diagram must update immediately without polling. This requires **WebSockets** (or Server-Sent Events) from day one and affects the backend framework choice and structure.

### 5. HTTP API Framework Unspecified
Phase 2 mentions "Build the CRUD APIs" without naming a framework. For a new Node.js/TypeScript project, **Fastify** or **Hono** are significantly better choices than Express (better TypeScript support, faster, more modern). This should be decided before scaffolding begins.

### 6. Database Migration Strategy Absent
SQLite is the right call for local-first. However, as the schema grows, fields will be added to existing tables. Without a migration tool, every schema change risks breaking an existing installation. **Drizzle ORM** is recommended — it has first-class TypeScript support, a clean migration workflow, and works well with SQLite.

---

## Important but Can Be Resolved During the Relevant Phase

### 7. Layout Builder Tile Vocabulary Undefined
"Grid-based UI layout builder" is under-specified. Before building it, a **tile vocabulary** must be defined — what cell types exist? For example: Straight (horizontal/vertical), Curve, Left-hand point, Right-hand point, Buffer stop, Sector plate, Platform, Engine shed road, Uncoupler. This vocabulary also directly drives the data model for storing the layout and should be agreed before Phase 2 modelling begins.

### 8. Route Locking Edge Cases Unresolved
Phase 3 mentions "Route Locking" without defining the behaviour:

- What exactly is locked — points only, blocks, or both?
- What does the system do when a manual command conflicts with a lock — silent rejection, warning, or a deliberate operator override?

This needs a design decision before building the Route Locking service; it directly affects the UI design.

### 9. Automation Engine Complexity is Understated
"Automatically slows/stops locos to prevent collisions" is a deceptively complex problem. It requires:

- Knowing each train's **direction of travel** at all times.
- A map of **block topology** (which blocks are adjacent to which).
- A **braking model** per loco class — a Class 08 shunter and a Britannia have very different stopping distances even at the same DCC speed step.

This should be flagged as a significant sub-project in its own right, not a single implementation step, to ensure realistic planning expectations.

---

## Minor

### 10. Phase 1 Step Ordering is Slightly Off
Step 4 ("Define the JSON over MQTT command protocol") should logically precede Step 3 ("Implement the MQTT client"), not follow it. The protocol definition is an *input* to the client implementation, not an output.

---

## Summary Table

| # | Finding | When to Resolve |
|---|---------|----------------|
| 1 | Mosquitto broker not specified | Before Phase 1 |
| 2 | MQTT topic structure undefined | Before Phase 1 |
| 3 | Operating modes not designed | Before Phase 3 |
| 4 | No real-time UI push strategy | Before Phase 1 |
| 5 | HTTP API framework unspecified | Before scaffolding |
| 6 | No DB migration strategy | Before Phase 2 |
| 7 | Tile vocabulary undefined | Before Phase 2 UI work |
| 8 | Route locking behaviour undefined | Before Phase 3 |
| 9 | Automation engine underscoped | Before Phase 3 planning |
| 10 | Phase 1 step order incorrect | Minor — fix in plan |
