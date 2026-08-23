/**
 * Port: IDccController
 *
 * Defines the contract for communicating with the DCC command station.
 * Implementations: SerialDccAdapter (real hardware), SimulatedDccAdapter (tests/dev).
 */

import { DccResponse } from '../domain/dccResponse';

export interface IDccController {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  onConnectionChange(handler: (connected: boolean) => void): void;

  /**
   * Every framed response the command station sends (#148, `docs/dcc-link.md`).
   *
   * Distinct from `onConnectionChange`, which reports on the *port*: a USB
   * device node stays open across a station reboot, a power cutoff and a
   * maintenance-mode lockout, so it cannot report any of them. This is the
   * channel that can.
   *
   * Handlers see responses in arrival order, already framed and validated.
   * Nothing here is request-scoped — replies are correlated to commands by
   * `domain/dccLink.ts`, not by a promise on the call that caused them.
   */
  onResponse(handler: (response: DccResponse) => void): void;

  /**
   * Asks the station to identify itself and report both track power states —
   * DCC-EX's `<s>`, whose reply is `<iDCC-EX …><p? MAIN><p? PROG>`.
   *
   * Resolving means the request went out, never that it was answered. The
   * answer, or its absence, arrives through `onResponse` and is what
   * `DccLinkService` judges liveness on.
   */
  probeStatus(): Promise<void>;

  /**
   * Sets the speed and direction of a loco.
   *
   * The ranges are the command station's, not this interface's — it validates
   * and rejects, nothing here does (`domain/dccWireFormat.ts`).
   *
   * @param address DCC address (1–10239, the 14-bit long-address space)
   * @param speed DCC speed step (0–126)
   * @param direction Direction of travel
   */
  setSpeed(address: number, speed: number, direction: 'fwd' | 'rev' | 'stop'): Promise<void>;

  /**
   * Sets a DCC decoder function on or off.
   *
   * **Rejected by `SerialDccAdapter` against PicoDCC** (#150): the station
   * validates the cab, accepts the command, and then does nothing with it —
   * `updateFunct()` is an empty body. The adapter throws rather than writing,
   * so a caller finds out on the first attempt instead of watching a headlight
   * not come on. `SimulatedDccAdapter` is unaffected; this is a hardware limit,
   * not a model limit.
   *
   * @param address DCC address
   * @param fn Function number (0–28)
   * @param state On/off
   */
  setFunction(address: number, fn: number, state: boolean): Promise<void>;

  /**
   * Commands a DCC-controlled point motor.
   * @param dccAddress DCC accessory address of the point
   * @param position Desired position
   */
  setPoint(dccAddress: number, position: 'normal' | 'reverse'): Promise<void>;

  /**
   * Broadcasts an emergency stop to all locos on the track.
   */
  emergencyStop(): Promise<void>;
}
