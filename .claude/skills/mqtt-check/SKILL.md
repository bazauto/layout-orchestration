---
name: mqtt-check
description: Validate MQTT publish/subscribe code against docs/mqtt-contract.md — topic shape, payload schema, QoS, and the safety-critical retention rules. Use before or after writing any code that publishes, subscribes, or parses an MQTT message, when amending the MQTT contract, or when reviewing a diff that touches src/adapters/mqtt/ or the ESP firmware protocol.
---

# MQTT contract check

`docs/mqtt-contract.md` is binding. The ESP firmware in `bazauto/esp-layout-controller`
is built against it, so a drift here is a field bug on real hardware, not a refactor.

Read `docs/mqtt-contract.md` in full before checking anything — do not work from memory
of it.

## Checklist

Run every item against the code under review. Report pass/fail per item with a
`file:line` reference for each failure.

**Topic**
1. Prefixed `layout/{layoutId}/` — no unscoped topics.
2. The segment structure matches a row in the Topic Reference table exactly.
3. `layoutId` comes from config/state, never hardcoded.

**Direction**
4. The code publishes on topics listed as outbound for this component, and subscribes
   only to inbound ones. Backend must never subscribe to its own `*/state` broadcasts.

**Payload**
5. Every field in the contract's schema table is present and correctly typed.
6. No extra fields. Adding one requires amending the contract first.
7. `updatedAt` is ISO 8601, generated from the injected clock.
8. **Inbound payloads are Zod-validated before reaching the domain layer.** A validation
   failure must route to Safe-Stop, per contract §Fail-Safe Triggers — not a silent
   drop or a bare log line.

**QoS and retention** — the safety-critical section
9. QoS matches the table (1 for everything except `system/heartbeat` at 0).
10. `loco/*/command` and `point/*/command` are published with `retain: false`.
    A retained control command causes a ghost movement on controller reconnect.
    **This is the single highest-severity failure in this checklist.**
11. All `*/state` topics and `system/status` are published with `retain: true`.
12. `system/status` is registered as the MQTT Last Will and Testament with the
    `"offline"` payload on connect.

**Layering**
13. No business logic inside the message callback — parse, validate, delegate to a
    service. See `CLAUDE.md` safety rule 2.

## Output

A short table: item, pass/fail, `file:line`. Then the failures in severity order —
retention violations first, then missing validation, then schema drift, then style.

If the code needs a topic or field the contract does not define, do not add it silently.
State that the contract must be amended, propose the exact table row and schema block to
add to `docs/mqtt-contract.md`, and flag that `esp-layout-controller` needs the matching
change.
