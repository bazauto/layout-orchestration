---
name: scenario
description: Write a replay scenario test for the layout orchestrator from a plain-English operating sequence. Use when the user describes a sequence of layout events to verify ("train enters block 3, sensor drops out, system should safe-stop"), asks for a scenario/replay test, or changes routing, occupancy, reservation, or safe-stop logic and needs failure-path coverage.
---

# Scenario test scaffolding

Scenario tests replay an operating sequence against the simulated adapters and assert on
emitted `LayoutEvent`s and final runtime state. They are the primary safety net for
Phase 3 (routing and automation) and must cover failure paths, not just happy paths.

Tests live in `packages/backend/tests/scenario/` as `<sequence-name>.scenario.test.ts`.

## Procedure

1. **Read the sequence back as discrete steps.** Turn the user's prose into an ordered
   list of stimuli (sensor reading, throttle command, point command, broker disconnect,
   restart) and expected observations. If a step is ambiguous about *timing* or *who
   holds authority*, ask before writing — those two things determine the assertion.

2. **Check the contract.** Every MQTT stimulus must use a real topic and payload shape
   from `docs/mqtt-contract.md`. Do not invent fields.

3. **Check existing coverage** in `packages/backend/tests/` before writing — extend an
   existing scenario rather than duplicating setup.

4. **Build the harness** using `SimulatedMqttAdapter` and `SimulatedDccAdapter` wired
   into a real `LayoutService` with an in-memory or temp-file repository. The domain and
   service layers under test must be the real ones. Follow the wiring already used in
   `packages/backend/tests/unit/services/layoutService.test.ts`.

5. **Assert on three things** for each scenario:
   - the **event sequence** emitted by `LayoutService` (order matters),
   - the **final runtime state** (`LayoutRuntimeState` — occupancy, point positions,
     locks, system status),
   - the **commands actually published** to the simulated adapters, including that
     control-topic publishes were not retained.

6. **Always include the failure variant.** For any scenario the user describes, also
   write the degraded version: the sensor never reports, the broker drops, the DCC
   controller never acknowledges, the process restarts mid-sequence. Assert Safe-Stop
   with a populated `safeStopReason`.

7. **Run it.** `npm test --workspace=packages/backend`. Report real output.

## Shape

```ts
describe('scenario: <plain-English sequence>', () => {
  it('reaches <expected state> when <stimuli>', async () => {
    const h = await createScenarioHarness();       // simulated adapters + real service

    await h.sensorReports('s1', 'occupied');
    await h.throttle({ locoAddress: 3, speed: 40, direction: 'fwd' });
    await h.sensorReports('s2', 'occupied');

    expect(h.events).toMatchEventSequence([...]);
    expect(h.state.blocks.get('b2')?.occupancy).toBe('occupied');
    expect(h.publishedRetained('layout/wgh/loco/3/command')).toBe(false);
  });

  it('safe-stops when s2 never reports', async () => { /* degraded variant */ });
});
```

If `createScenarioHarness` does not exist yet, build it in
`packages/backend/tests/scenario/harness.ts` on first use and keep it reusable —
deterministic clock, event recorder, publish recorder. No real timers; scenarios must
run in milliseconds.

## Rules

- Never assert against a hardcoded timestamp. Inject the clock.
- Never `await` a real delay. Advance the fake clock.
- A scenario that only covers the happy path is incomplete work — say so rather than
  reporting it as done.
