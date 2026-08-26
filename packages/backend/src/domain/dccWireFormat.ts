/**
 * DCC-EX command strings, as pure functions.
 *
 * ## Why this is a domain module and not adapter privates
 *
 * The bytes we put on the serial line are a *contract* with the PicoDCC command
 * station (`bazauto/PicoDCC`), in the same sense `docs/mqtt-contract.md` is a
 * contract with the ESP firmware. `SerialDccAdapter` is excluded from coverage
 * because it needs a serial port — and that exclusion is how #147 survived: for
 * months every throttle command we sent named the wrong loco, at the wrong
 * speed, in the wrong direction, and nothing could have caught it, because the
 * only place the format existed was inside the untestable file.
 *
 * The command *strings* need no hardware. They live here, pure, with unit tests
 * asserting the exact bytes; the adapter is left with opening the port, writing
 * to it, and reconnecting.
 *
 * ## The hazard this file exists to prevent
 *
 * The station parses a throttle command with `sscanf(buffer, "%*c %d %d %d")` —
 * three positional integers after the opcode, no field names. A field inserted
 * at the front does not fail to parse; it *shifts*, and every value lands in the
 * neighbouring slot's meaning. `<t 1 3 60 1>` — the legacy DCC++ register form
 * this adapter used to send, meaning "loco 3, speed 60, forward" — is read as
 * cab 1, speed 3, direction 60, and since direction is evaluated as `== 1`, that
 * is loco 1 crawling in reverse. It parses cleanly, the station acknowledges it,
 * and nothing anywhere in the chain says no.
 *
 * So: positional fields, and never a stray leading register. The three-field
 * form below is the one DCC-EX documents as current, so this is not a
 * PicoDCC-specific accommodation.
 *
 * ## Ranges
 *
 * The station validates (`lib/dcc_types.h`): cab `1..10239`, throttle speed `-1`
 * (its emergency-stop sentinel) or `0..126`. These functions **format, they do
 * not validate** — a value out of range is the caller's bug, and the station is
 * the authority that rejects it. Rejections are about to become visible on the
 * wire as `<X>`; reading that back is #148, and validating a point's DCC address
 * before it ever gets here is #152.
 */

import { Direction } from './types';

/**
 * Wraps a command body in the `<>` framing every DCC-EX command uses. The
 * station reads up to the closing bracket, so the framing is the message
 * boundary, not decoration.
 */
function frame(body: string): string {
  return `<${body}>`;
}

/**
 * `<t CAB SPEED DIR>` — the current three-field DCC-EX throttle form (#147).
 *
 * `DIR` is `1` forward, `0` reverse. `'stop'` is not a third direction on the
 * wire: it is speed `0` with the forward bit set, because a decoder holding a
 * direction at speed zero is stationary either way, and the alternative —
 * carrying the last commanded direction through a stop — would need state this
 * function deliberately does not have.
 *
 * Speed is a DCC speed step, `0..126` (`LocoState.speed`). DCC-EX's `-1`
 * emergency-stop speed is deliberately not reachable from here; a broadcast
 * `<!>` is what `formatEmergencyStop` is for.
 */
export function formatSetSpeed(address: number, speed: number, direction: Direction): string {
  const dir = direction === 'rev' ? 0 : 1;
  const effectiveSpeed = direction === 'stop' ? 0 : speed;
  return frame(`t ${address} ${effectiveSpeed} ${dir}`);
}

/**
 * `<F CAB FUNC STATE>` — a decoder function on or off.
 *
 * **Not safe to send to PicoDCC today** (#150): the firmware routes `F` through
 * the same three-integer branch as `t`, so a function command is decoded as a
 * throttle and overwrites the loco's speed and direction. The firmware half is
 * `bazauto/PicoDCC#1`. The string below is the correct DCC-EX one and is kept
 * here so it stays testable; what #150 decides is whether anything calls it.
 */
export function formatSetFunction(address: number, fn: number, state: boolean): string {
  return frame(`F ${address} ${fn} ${state ? 1 : 0}`);
}

/**
 * `<a ADDR SUBADDR ACTIVATE>` — a DCC accessory (point motor) command.
 *
 * Subaddress is always `0`, and `ACTIVATE` carries the position: `1` normal, `0`
 * reverse. Which way a physical point throws for a given position is authored
 * data nothing can verify (`docs/track-grid.md` D9); this function only decides
 * the byte.
 */
export function formatSetPoint(dccAddress: number, position: 'normal' | 'reverse'): string {
  const activate = position === 'normal' ? 1 : 0;
  return frame(`a ${dccAddress} 0 ${activate}`);
}

/** `<!>` — broadcast emergency stop, every loco on the track. Takes no fields. */
export function formatEmergencyStop(): string {
  return frame('!');
}

/**
 * `<1 MAIN>` / `<0 MAIN>` — main track power on or off (#149, #180).
 *
 * **The track argument is load-bearing.** #149 sent a bare `<1>`, which DCC-EX
 * reads as `DCCEX_TRACK_ALL` and PicoDCC implements as both tracks, on the
 * argument that the operator-facing concept is "the layout is live". It is — but
 * the programming track is not part of that layout. It belongs to a service-mode
 * process that does not exist here yet, and when it does it will want to own its
 * own power rather than find it switched underneath by an operator turning the
 * running lines on. Naming MAIN keeps the orchestrator out of it (#180).
 *
 * `progPowerOn` stays **observed**: the `<s>` probe still reports `<p? PROG>`
 * every five seconds and `DccLinkService.notePower` still records it. What has
 * gone is the orchestrator ever writing it.
 *
 * The reply is `<p1 MAIN>` (or `p0`), one frame per command, which is why this
 * command is worth sending even when the station is believed to be in the
 * desired state: the answer is the only thing that makes the belief evidence.
 */
export function formatTrackPower(on: boolean): string {
  return frame(on ? '1 MAIN' : '0 MAIN');
}

/**
 * `<s>` — ask the station what it is and how it stands (#148).
 *
 * One round trip, three facts: the identity banner (carrying the git hash of the
 * running image), `<p? MAIN>`, and `<p? PROG>`. That is why it is the liveness
 * probe rather than something cheaper — a reply proves the station is listening
 * *and* refreshes the two power states, and a station that has restarted
 * announces a different commit.
 */
export function formatStatusRequest(): string {
  return frame('s');
}
