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
| `sensor/{sensorId}/reading` | Sensor HW → Backend | 1 | YES | Sensor occupancy change |
| `point/{pointId}/command` | Backend → DCC | 1 | **NO** | Point position command |
| `point/{pointId}/state` | Backend → Subscribers | 1 | YES | Broadcast current point state |
| `block/{blockId}/state` | Backend → Subscribers | 1 | YES | Block occupancy broadcast |
| `system/status` | Backend → Subscribers | 1 | YES | System status (also used as LWT) |
| `system/heartbeat` | Backend → Subscribers | 0 | NO | Liveness pulse every 5 seconds |

> **Critical — Retention Policy for Control Topics:**
> `loco/*/command` and `point/*/command` MUST NOT be retained. A retained throttle command would trigger a ghost movement immediately on any new subscriber connecting to the broker (e.g., after an ESP controller reboot). This is a safety requirement.

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
Published by sensor hardware (block detectors, IR sensors) when occupancy changes. The `sensorId` matches the sensor's configured identifier in the layout database.

```json
{
  "state": "occupied",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `state` | `"occupied"` \| `"clear"` | Current sensor reading |
| `updatedAt` | ISO 8601 string | Timestamp on the sensor device |

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

### `point/{pointId}/state`
Published by the backend after confirming or issuing a point command. Retained.

```json
{
  "pointId": "p1",
  "position": "normal",
  "locked": false,
  "lockedByRoute": null,
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

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
| Sensor hardware restarts | Backend receives the retained `sensor/*/reading` on subscribe and re-validates block state. |
| New frontend client connects | Receives all retained `block/*/state`, `point/*/state`, `loco/*/state`, and `system/status` immediately without needing a REST poll. |

---

## Fail-Safe Triggers

The following MQTT conditions MUST trigger a Safe-Stop in the backend:

1. MQTT broker disconnection (detected via client `close` event) lasting more than 5 seconds.
2. Receiving `system/status` with `status: "offline"` from another orchestrator instance on the same broker.
3. Receiving a malformed payload that fails Zod validation on a sensor or control topic.
