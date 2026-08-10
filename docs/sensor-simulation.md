# Sensor Simulation — Decision Record (#65)

A flag-gated bench-testing tool: inject a sensor reading by hand and have it processed by
the system exactly as if it had come from real hardware. Same posture as
`docs/sensor-fault-recovery.md` and `docs/route-locking.md` — not binding the way
`docs/mqtt-contract.md` is, but it explains *why*, not just *what*.

## Safety

**`SENSOR_SIMULATION=true` lets this process FABRICATE sensor readings.** It can make the
orchestrator believe a block is clear while a train stands in it. Off by default. Do not
enable it on a live layout.

## The situation this closes

Exercising the fault → three valid readings → acknowledge loop (#34, D1) by hand today
means physically interrupting a sensor's wiring three times in sequence, or waiting for a
real fault. Neither is a workable bench test. This gives an operator a panel that publishes
the same bytes hardware would, through the same MQTT round trip, so the path under test is
never a shortcut.

## Decisions

Carried over from the issue as written; not re-opened here.

| # | Decision | Why |
|---|---|---|
| D1 | Backend publishes to the real sensor topic; the broker echoes it back | Only mechanism that is genuinely indistinguishable from hardware — real QoS, real retention, real Zod parse, real fault path. Alternatives (injecting into the adapter, or MQTT-over-WS from the browser) either add a test-only method to `IMqttAdapter` that the hardware path never exercises, or bypass the Fastify session hook and die entirely in `USE_SIMULATOR` mode |
| D2 | Gated by a `SENSOR_SIMULATION` flag, off by default. Any authenticated user when on — no role check | This is the one control in the system that can make the orchestrator believe a block is CLEAR while a train sits in it. A role check is a runtime decision; a flag means the capability does not exist in the live process. The service and route are constructed only when the flag is on |
| D3 | New `GET /api/capabilities` → `{ sensorSimulation: boolean }`, authenticated, no role check. The panel renders only when true and **fails closed** if the fetch errors | Beats teaching the frontend to interpret a 404, and a capabilities endpoint is wanted again for the optional subsystems in #6 and #25 |
| D4 | The panel sends: `occupied`, `clear`, a canned-malformed payload, and clear-retained — with a retain toggle | Valid-only injection tests the path that already works. The fault → 3 valid readings → acknowledge loop (#34, D1) is the flow that is painful to exercise by hand today |
| D5 | Malformed means three canned payloads chosen for distinct Zod failures: `{"state":"banana"}` (bad enum), `{}` (missing field), `null` (not an object). No free-text box | Predictable, documentable Safe-Stop outcomes that a scenario test can assert. Note the transport-level non-JSON path (`MqttAdapter.ts:96`) stays unreachable: `IMqttAdapter.publish` JSON-stringifies unconditionally and is **not** being widened for raw bytes |
| D6 | Retain defaults on. Clear-retained publishes a zero-length retained message — the only thing MQTT accepts as "forget this" | A fabricated reading for a detector that is not wired yet is never corrected by real hardware; it replays into the backend on every restart, forever. `IMqttAdapter` gains empty-payload support, and `SimulatedMqttAdapter` must also **delete** from its `retained` map or clear-retained is untested in simulator mode |
| D7 | **An empty payload is a retained-clear, not a malformed reading.** New step 2b in `LayoutService.handleSensorReading`, before the Zod parse | Currently a zero-byte message fails `JSON.parse`, is forwarded as a raw `''` by `MqttAdapter` (deliberately — `MqttAdapter.ts:96-108`), fails Zod, and trips a sensor fault plus Safe-Stop. So tidying up after a test would halt the layout every time. An empty message asserts nothing about occupancy, so ignoring it leaves derived state exactly where the last real reading put it — halting because a retained flag was cleared is a nuisance, not a safety win. Domain layer, never the adapter (safety rule 2). See D9 in `docs/sensor-fault-recovery.md` for the implemented ordering |
| D8 | The panel keeps its own injection history client-side, labelled "last injected", never "current" | `DD10` in `docs/sensor-fault-recovery.md` says per-sensor last-reading is deliberately absent from `STATE_SNAPSHOT` — *"Do not 'complete' this snapshot with it later."* That decision stands. A record of your own keystrokes is not a claim about the layout, and it correctly resets on reload |
| D9 | Out-of-service sensors are listed but disabled, and the route refuses them with **409** | Injecting at one is silent by design (`subscribeSensors` never subscribes it), so a live button would look broken. Disabling is presentation, not enforcement — curl exists — and publishing anyway would leave a retained value on a topic nobody is watching, which surfaces later as truth when the sensor is re-enabled. 409 mirrors the existing `SensorNotFaultedError` / `SensorFaultNotArmedError` pattern in `routes/sensors.ts` |
| D10 | Injection is allowed during Safe-Stop | Refusing would break the most valuable manual test this enables: trip a fault, then feed the three consecutive valid readings that arm the acknowledge. Safe-Stop halts automated movement; real hardware does not stop publishing |
| D11 | Single-shot only. No timed sequences, no scripted walk-through, no record/replay | A timed sequence is a train simulator: it needs backend playback state, cancellation semantics, and an answer for what a half-run sequence does when Safe-Stop trips. Ship the primitive; the scenario tests already cover scripted sequences in code |
| D12 | Logged at publish time only — a `warn` naming the sensor, topic, exact fabricated payload, retain flag and username. No marker field in the payload | The payload stays byte-identical, which is the whole feature. `handleSensorReading` never branches on provenance. Reading the log in order gives "fabricated X" immediately followed by the genuine ingestion line, so provenance is recoverable without the domain knowing |
| D13 | Logic lives in a new `SensorSimulationService`, injected with `IMqttAdapter` / `ILayoutRepository` / `INameBook`. The route parses and delegates | Safety rule 2. It is a separate concern — it consumes the sensor registry but owns no layout state — and `LayoutService` is already over 1,000 lines carrying the ingestion path this must not perturb. It also lets the flag gate constructing the service, not just mounting the route |

## Resolutions

Mechanical choices made during implementation, so a later session does not re-derive them.

### R1 — `IMqttAdapter.clearRetained(topic)`, a distinct method

D6's zero-byte retained publish needed an API shape. A sentinel payload value is invisible
to the type system; a `PublishOptions` flag makes `payload` meaningless in one branch. A
method with no payload parameter makes the zero-byte case unreachable except deliberately.

`MqttAdapter.clearRetained` publishes `Buffer.alloc(0)` at `{ qos: 1, retain: true }` and
rejects when not connected, mirroring `publish`. `SimulatedMqttAdapter.clearRetained`
deletes the topic from `retained` (so a later subscribe replays nothing — D6's explicit
requirement), appends a `{ payload: '', qos: 1, retain: true }` entry to `publishLog`, and
**delivers `''` to every matching live subscriber with `retained: false`** via
`setImmediate`, exactly like `publish` — a real broker delivers an empty retained PUBLISH
to current subscribers, and live delivery is what makes D7 reachable in simulator mode at
all. `''` specifically, because `MqttAdapter`'s message handler forwards a raw string for
anything `JSON.parse` cannot parse — including an empty string — so the two adapters are
byte-identical at the subscriber boundary.

### R2 — D7 step 2b: `payload === ''`, between the in-service check and the Zod parse

See D9 in `docs/sensor-fault-recovery.md` for the implemented ordering and the doc-comment
requirement on `handleSensorReading`. The predicate lives in `domain/sensorPayload.ts` as
`isEmptySensorPayload`, ingestion-side only, importing nothing.

### R3 — `GET /api/capabilities`: new route file, derived from service existence, fails closed

`src/transport/http/routes/capabilities.ts` — process-scoped, not layout-scoped, so it is
not folded into a `/api/layouts/:layoutId/` resource file. `buildServer` gains one trailing
optional parameter, `sensorSimulation?: SensorSimulationService`, and computes
`{ sensorSimulation: sensorSimulation !== undefined }` — the capability is literally "the
service exists in this process" (D2's wording), so the flag cannot drift from the mounted
surface. Authenticated by the global hook, no `requireAdmin` (D3), always mounted in every
mode.

The frontend hook `useCapabilities` lives alongside `useAuth`, not folded into
`useLayoutConfig` (different failure domain, different lifecycle). It fails closed: starts
`{ sensorSimulation: false }`, only ever set true on `res.ok && body.sensorSimulation ===
true`. No `loading` flag — "not yet known" and "not available" render identically.

### R4 — The gate test is `App.test.tsx`

The gate genuinely lives in `App.tsx` — the panel wrapper is not rendered when the flag is
off — so testing it anywhere else tests a copy. Renders `App` with `installMockWebSocket()`
and a path-routed `fetch` mock (`useAuth`, `useCapabilities`, and `useLayoutConfig` fire
concurrently; routing by URL substring rather than call order is what makes that safe). The
socket is left `connecting`, so `layoutId` stays null and panels render disabled — which is
irrelevant to the gate under test.

### R5 — One route, one Zod-discriminated body

`POST /api/layouts/:layoutId/sensors/:sensorId/simulate-reading`, `simulateReadingSchema` a
`z.discriminatedUnion('action', [...])` over `reading` / `malformed` / `clear-retained`. One
route rather than four: the four operator actions differ only in the bytes published and
share lookup, in-service check, logging, and response shape. `clear-retained` carries no
`retain` field and `.strict()` rejects one — a non-retained zero-byte publish clears
nothing, so accepting `retain: false` there would silently no-op. `retain` defaults `true`
elsewhere (D6). The request body is strictly validated even though the *published* bytes
are deliberately invalid for `malformed` — the malformed payload is selected by name from a
server-side table (D5), never client-supplied bytes, so a bad request body is an ordinary
400 (the "malformed operator UI request is a 400, not a layout halt" rule), while the
published bytes are invalid on purpose and correctly Safe-Stop when they round-trip back
through MQTT. Response is 202 Accepted (the publish has happened; the effect arrives
asynchronously over the broker round trip), echoing the exact payload published — that echo
is what D8's client-side history records.

### R6 — Config: `config.sensors.simulationEnabled`

`SENSOR_SIMULATION` env var, `config.sensors.simulationEnabled`, default `false`. Gates
*constructing* `SensorSimulationService` at all (D2), not a runtime check inside it.
`index.ts`'s `LayoutService` construction site is narrowed to pass only
`{ clearAfterValidReadings: config.sensors.clearAfterValidReadings }` rather than
`config.sensors` wholesale, so a simulation flag is never structurally handed to a service
that has nothing to do with it.

## Out of scope

- Timed or scripted sequences, record/replay, cancellation semantics (D11).
- Any `STATE_SNAPSHOT` change, including per-sensor last-reading (D8, and `DD10` in
  `docs/sensor-fault-recovery.md` explicitly forbids it).
- Widening `IMqttAdapter.publish` for raw non-JSON bytes (D5). `clearRetained` takes no
  payload precisely so it is not that.
- A persisted audit table for injections (D12). The `warn` log line is the record.
- Playwright coverage — the e2e environment would need two flag configurations.
- Any `schema.ts` change or migration. This feature needs neither: the flag is env config,
  the injection history is client-side, and there is no audit table.
