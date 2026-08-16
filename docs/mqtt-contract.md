# MQTT Contract — Layout Orchestrator

This document defines the complete MQTT communication contract between the orchestrator backend, sensor hardware, and the ESP layout controller. It is the authoritative reference for implementing any component that publishes or subscribes to MQTT topics.

---

## Topic Structure

All topics are scoped to a specific layout using `layout/{layoutId}/` as a root prefix. This supports multiple concurrent layout configurations in a single broker deployment.

```
layout/{layoutId}/loco/{address}/command
layout/{layoutId}/loco/{address}/state
layout/{layoutId}/sensor/{sensorId}/reading
layout/{layoutId}/point/{pointId}/command
layout/{layoutId}/point/{pointId}/state
layout/{layoutId}/point/{pointId}/reading
layout/{layoutId}/point/{pointId}/query
layout/{layoutId}/block/{blockId}/state
layout/{layoutId}/system/status
layout/{layoutId}/system/heartbeat
```

---

## Topic Reference

| Topic | Direction | QoS | Retained | Purpose |
|---|---|---|---|---|
| `loco/{address}/command` | Backend → ESP | 1 | **NO** | Throttle command for a specific DCC address |
| `loco/{address}/state` | Backend → Subscribers | 1 | YES | Broadcast current loco state |
| `sensor/{sensorId}/reading` | Sensor HW (or backend sim) → Backend | 1 | YES | Current sensor occupancy. Published on change **and** re-asserted at least every 30 s |
| `point/{pointId}/command` | Backend → DCC | 1 | **NO** | Point position command |
| `point/{pointId}/state` | Backend → Subscribers | 1 | YES | Broadcast current point state |
| `point/{pointId}/reading` | Point Controller → Backend | 1 | **NO** | Physical position as observed by the point controller |
| `point/{pointId}/query` | Backend → Point Controller | 1 | **NO** | Request an immediate `reading` for this point |
| `block/{blockId}/state` | Backend → Subscribers | 1 | YES | Block occupancy broadcast |
| `system/status` | Backend → Subscribers | 1 | YES | System status (also used as LWT) |
| `system/heartbeat` | Backend → Subscribers | 0 | NO | Liveness pulse every 5 seconds |

> **Critical — Retention Policy for Control Topics:**
> `loco/*/command` and `point/*/command` MUST NOT be retained. A retained throttle command would trigger a ghost movement immediately on any new subscriber connecting to the broker (e.g., after an ESP controller reboot). This is a safety requirement.
>
> **`point/*/reading` is also NOT retained**, for a different reason from the
> control topics. Occupancy is continuously re-asserted by a live sensor and
> self-corrects on the next movement, which is why `sensor/*/reading` **is**
> retained. A point's position is re-asserted by nothing, and it can change while
> its controller is offline — hand-thrown during a shutdown, power lost
> mid-travel, a linkage dropped. A retained point reading is therefore a
> confident assertion with no correction path, and believing a stale point
> position is the direct cause of a wrong-route movement. Restart recovery is
> provided instead by `point/*/query`, which recovers position **live**.

> **Critical — Retention Is Not Evidence of Liveness:**
> A retained message tells a new subscriber what was last published. It says nothing
> about whether the publisher is still alive. A sensor controller that died while
> reporting `"clear"` replays that `"clear"` to every future subscriber, including a
> backend that has just restarted and has no other information about that block.
>
> Therefore: **telemetry may be retained only where the publisher is contractually
> obliged to re-assert it, and a retained delivery is never trusted on its own.**
>
> `sensor/*/reading` is retained *and* its publisher MUST re-assert it at least every
> 30 s (see its payload section below), so the retained copy is a bootstrap for a value
> that is about to be reconfirmed. `point/*/reading` is **not** retained, because
> nothing re-asserts a point: its position can change while its controller is offline,
> so a retained position is an archived belief with nothing behind it.
>
> The backend distinguishes a message delivered because of a **new subscription**
> (RETAIN flag set, [MQTT-3.3.1-8]) from one delivered on an **established
> subscription** (RETAIN flag clear, [MQTT-3.3.1-9]). The first is provisional: it is
> recorded and displayed, but never counted as confirmation that track is clear.
>
> This rule is what makes the two `reading` topics' opposite retention one decision
> rather than two. See `docs/sensor-trust.md`.

---

## Payload Schemas

All payloads are UTF-8 encoded JSON objects.

### `loco/{address}/command`
Sent by the backend to command a specific DCC loco address. The ESP controller subscribes to this topic.

```json
{
  "speed": 50,
  "direction": "fwd",
  "functions": {
    "0": true,
    "1": false
  }
}
```

| Field | Type | Description |
|---|---|---|
| `speed` | integer (0–126) | DCC speed step. 0 = stop. |
| `direction` | `"fwd"` \| `"rev"` \| `"stop"` | Direction of travel. `"stop"` implies speed 0. |
| `functions` | object | Map of DCC function number to boolean state. Only changed functions need to be included. |

---

### `loco/{address}/state`
Published by the backend after every state change. Retained so new subscribers get current state immediately.

```json
{
  "address": 3,
  "speed": 50,
  "direction": "fwd",
  "functions": { "0": true, "1": false },
  "authority": "manual",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `address` | integer | DCC address |
| `speed` | integer (0–126) | Current speed |
| `direction` | `"fwd"` \| `"rev"` \| `"stop"` | Current direction |
| `functions` | object | Full current function state |
| `authority` | `"manual"` \| `"auto"` | Who currently controls this loco |
| `updatedAt` | ISO 8601 string | Timestamp of last change |

---

### `sensor/{sensorId}/reading`
Published by sensor hardware (block detectors, IR sensors) whenever occupancy changes,
**and** re-published unchanged at least every **30 seconds** as a liveness assertion.
Both cases are the same message, published with retain set; the backend does not
distinguish them by content, only by whether the broker delivered them live or as a
retained replay.

The re-assertion is a hard requirement, not an optimisation. A sensor from which the
backend has received no **live** message inside its freshness window
(`SENSOR_FRESHNESS_TIMEOUT_MS`, default 90 s) is untrusted, and every block it reports
degrades to `"unknown"` — which, per the fail-safe rule, is treated as occupied.
Silence is not consent.

The `sensorId` matches the sensor's configured identifier in the layout database.

```json
{
  "state": "occupied",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `state` | `"occupied"` \| `"clear"` | Current sensor reading |
| `updatedAt` | ISO 8601 string, **optional** | Timestamp from the sensor device's own clock. **Advisory and diagnostic only.** The backend measures freshness with its own receipt clock and never makes a safety decision from a device-supplied timestamp — that timestamp is produced by the same device whose liveness is in question. A device with no synchronised clock may omit the field; a wrong value degrades log quality, never safety. |

#### Simulated readings (test only)

When `SENSOR_SIMULATION=true` (#65, see `docs/sensor-simulation.md`), the backend itself
may publish to a sensor's own `sensor/{sensorId}/reading` topic — the same topic hardware
publishes to, at the same QoS and retention, so the broker echoes it back into the
backend's existing subscription exactly as if it had come from a real device. The payload
is **byte-identical** to a hardware reading and carries **no marker field**; nothing about
the wire format distinguishes a fabricated reading from a genuine one. The flag is off by
default and MUST NOT be enabled on a live layout — see the safety preamble in
`docs/sensor-simulation.md`. **The ESP firmware in `bazauto/esp-layout-controller` is
unchanged by this** and needs no rebuild: it neither knows nor cares that the backend can
also publish here.

#### Clearing a retained reading

A zero-length (empty-body) retained publish to `sensor/{sensorId}/reading` clears the
broker's retained value for that topic. This is the only defined zero-length payload
anywhere in this contract. The backend treats an empty payload on a sensor topic as a
retained-clear and **ignores it** — it asserts nothing about occupancy and is explicitly
**not** a Fail-Safe Trigger (see the exception on item 3 below, and D9 in
`docs/sensor-fault-recovery.md`).

---

### `point/{pointId}/command`
Sent by the backend to set a point position. NOT retained.

```json
{
  "position": "normal"
}
```

| Field | Type | Description |
|---|---|---|
| `position` | `"normal"` \| `"reverse"` | Requested position |

---

### `point/{pointId}/reading`
Published by the point controller whenever its observed position changes, and in
response to a `point/{pointId}/query`. NOT retained — see the retention callout.

```json
{
  "pointId": "p1",
  "position": "normal",
  "source": "sensor",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `pointId` | string | Must equal the `{pointId}` topic segment. A mismatch is a Fail-Safe Trigger. |
| `position` | `"normal"` \| `"reverse"` \| `"unknown"` | Observed position. `"unknown"` = cannot determine (no sensor, both sensors open, mid-travel). Unlike `command`, a reading MAY be `"unknown"`. |
| `source` | `"sensor"` \| `"driver"` | `"sensor"` = independently sensed. `"driver"` = the controller believes it drove the motor there, with no independent sensing — a delivery acknowledgement, not a position confirmation. A `"driver"` reading never confirms a point configured as requiring feedback. |
| `updatedAt` | ISO 8601 string | Timestamp on the controller. Advisory — the backend timestamps from its own clock. |

---

### `point/{pointId}/query`
Sent by the backend on startup, on broker reconnect, and on operator request, for
every point configured as requiring position feedback. NOT retained. The
controller SHOULD respond with a `point/{pointId}/reading`. The backend remains
correct if no response ever arrives — the point simply remains at position
"unknown", and every edge gated on it is untraversable until it reports.

```json
{ "requestedAt": "2026-01-01T00:00:00.000Z" }
```

---

### `point/{pointId}/state`
Published by the backend after confirming or issuing a point command. Retained.

```json
{
  "pointId": "p1",
  "commandedPosition": "normal",
  "confirmedPosition": "normal",
  "confirmation": "confirmed",
  "positionFeedback": "required",
  "locked": false,
  "lockedByRoute": null,
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `pointId` | string | Point identifier |
| `commandedPosition` | `"normal"` \| `"reverse"` \| `null` | Last position the backend commanded this session. `null` = never commanded. NOT a confirmation of physical position. |
| `confirmedPosition` | `"normal"` \| `"reverse"` \| `"unknown"` | Last position the point controller reported. `"unknown"` until a reading lands, and again after a confirmation timeout. |
| `confirmation` | `"unreported"` \| `"pending"` \| `"confirmed"` \| `"mismatch"` \| `"indeterminate"` \| `"timed-out"` | Confirmation status of `commandedPosition` against `confirmedPosition`. See `docs/point-feedback.md` for the full state model. |
| `positionFeedback` | `"none"` \| `"required"` | Whether this point is configured to require a confirmed reading. |
| `locked` | boolean | Whether a route currently holds this point |
| `lockedByRoute` | string \| null | Route ID that holds this point, if any |
| `updatedAt` | ISO 8601 string | Timestamp of last change |

> **Breaking change (2026-08):** the previous `position` field is replaced by
> `commandedPosition` + `confirmedPosition` + `confirmation`. A single `position`
> field could not distinguish a point that threw from one that failed to, which
> is the defect this amendment removes.

---

### `block/{blockId}/state`
Published by the backend when block occupancy changes. Retained.

```json
{
  "blockId": "b1",
  "occupancy": "occupied",
  "locoAddress": 3,
  "lockedByRoute": null,
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `occupancy` | `"occupied"` \| `"clear"` \| `"unknown"` | Current occupancy. `"unknown"` is the initial state and the state after sensor timeout. |
| `locoAddress` | integer \| null | DCC address of occupying loco if known |
| `lockedByRoute` | string \| null | Route ID that holds a reservation on this block |

---

### `system/status`
Published by the backend on startup and on any status change. Also configured as the Last Will and Testament (LWT) topic with the `"offline"` payload.

```json
{
  "status": "online",
  "mode": "manual",
  "reason": null,
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `status` | `"online"` \| `"safe-stop"` \| `"offline"` | System operating status |
| `mode` | `"manual"` \| `"auto"` \| `"hybrid"` | Current control authority mode |
| `reason` | string \| null | Human-readable reason for a safe-stop or offline status |

---

## QoS and Retained — Rationale

| Scenario | Behaviour |
|---|---|
| Backend restarts | Retained `system/status` LWT publishes `"offline"` automatically. On reconnect, backend publishes `"online"`. |
| ESP controller restarts | It receives NO retained throttle command (non-retained), so no ghost movement. It reads retained `loco/*/state` to recover last known state. |
| Sensor hardware restarts | Its first **live** reading after boot — a change or a re-assert — restores trust. Until one arrives, every block it reports reads `unknown`. |
| Backend restarts, sensor alive | Retained readings arrive with the RETAIN flag set and are provisional. Those blocks read `unknown` until the first re-assert, i.e. within 30 s. |
| Backend restarts, sensor dead | The same retained readings arrive, but no re-assert ever follows, so those blocks stay `unknown` indefinitely. Retention alone got this case wrong — it reported a dead sensor's last `clear` as live track (#28). |
| Point controller restarts | The backend receives NO retained point reading. Every point configured `positionFeedback: "required"` remains or becomes `"unknown"` until it answers a live `point/*/query`. |
| New frontend client connects | Receives all retained `block/*/state`, `point/*/state`, `loco/*/state`, and `system/status` immediately without needing a REST poll. |

---

## Fail-Safe Triggers

The following MQTT conditions MUST trigger a Safe-Stop in the backend:

1. MQTT broker disconnection (detected via client `close` event) lasting more than 5 seconds.
2. Receiving `system/status` with `status: "offline"` from another orchestrator instance on the same broker.
3. Receiving a malformed payload that fails Zod validation on a sensor,
   feedback, or control topic — **except a zero-length payload on
   `sensor/*/reading`, which is a retained-clear (see Clearing a retained
   reading)**.
4. Receiving a `point/{pointId}/reading` whose payload `pointId` does not match
   the `{pointId}` topic segment.

## Degradation Triggers

The following conditions degrade **specific track** to `"unknown"` — which the domain
layer already treats as occupied, so routes over it cannot be granted and a live route
holding it is suspended — rather than triggering a system-wide Safe-Stop. The failure is
scoped to the track the failing device actually observes, so a layout that is otherwise
fully observed keeps running.

1. No **live** sensor reading received inside the sensor freshness window
   (`SENSOR_FRESHNESS_TIMEOUT_MS`, default 90 s = 3 × the 30 s re-assert interval).
2. A sensor reading known only from a **retained** message, with no live reading since
   the backend connected.

Both set every affected block to `"unknown"` and emit a `BLOCK_STATE` event, so the
condition is visible to the operator rather than silent.

> **A malformed sensor payload is NOT in this list.** It remains Fail-Safe Trigger 3
> above — a system-wide Safe-Stop, on the first message, with no tolerance. The two
> failures are different and are answered differently: a malformed payload is a device
> **lying**, which is immediate and sharp; an unrefreshed reading is a device **dying**,
> which is a freshness window and a scoped degrade. Do not merge them into one rule.
> See `docs/sensor-trust.md` and `docs/sensor-fault-recovery.md`.
