/**
 * SimulatedDccAdapter
 *
 * An in-process simulator for the DCC command station.
 * Logs all commands via the provided logger — no serial port required.
 * Used in development (USE_SIMULATOR=true) and all automated tests.
 *
 * Since #148 it also **answers**. A simulator that only accepted commands could
 * not exercise the read path at all, which would leave the newest safety
 * machinery in the system testable only against hardware — precisely the
 * inversion CLAUDE.md rule 5 exists to prevent. The replies below mirror the
 * bench firmware (`bazauto/PicoDCC` `1e7bb6d`): a throttle command draws `<l>`,
 * an accessory command draws `<O>`, and `<s>` draws identity plus both power
 * states.
 *
 * It is a *cooperative* station by default — every command succeeds. The
 * failures are opt-in through `rejectNext`, `goSilent` and `emitResponse`, so a
 * test asks for the misbehaviour it wants to assert on and no test gets it by
 * accident.
 */

import { EventEmitter } from 'events';
import { IDccController } from '../../ports/IDccController';
import { DccResponse, decodeSpeedByte, encodeSpeedByte } from '../../domain/dccResponse';

export interface SimulatedDccLogger {
  info(msg: string, data?: Record<string, unknown>): void;
}

/** What a simulated station reports as its identity. The commit is what a restart test changes. */
export interface SimulatedStationIdentity {
  version: string;
  product: string;
  commit: string;
}

const DEFAULT_IDENTITY: SimulatedStationIdentity = {
  version: '5.0.0',
  product: 'PICODCC-SIM',
  commit: '0000000',
};

export class SimulatedDccAdapter implements IDccController {
  private connected = false;
  private readonly emitter = new EventEmitter();
  /** Full record of every command issued, useful for test assertions. Status probes are excluded — see `probeStatus`. */
  public readonly commandLog: Array<{ ts: Date; type: string; data: Record<string, unknown> }> = [];
  /** How many `<s>` probes have been asked for (#148). */
  public probeCount = 0;

  private identity: SimulatedStationIdentity = { ...DEFAULT_IDENTITY };
  private mainPowerOn = true;
  private progPowerOn = true;
  private silent = false;
  private rejectCount = 0;
  /** When set, the next `<l>` reports this cab instead of the one commanded — the #147 hazard, on demand. */
  private cabOverride: number | null = null;

  constructor(private readonly log: SimulatedDccLogger) {}

  async connect(): Promise<void> {
    this.connected = true;
    this.log.info('[SimDCC] Connected');
    this.emitter.emit('connectionChange', true);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.log.info('[SimDCC] Disconnected');
    this.emitter.emit('connectionChange', false);
  }

  isConnected(): boolean {
    return this.connected;
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.emitter.on('connectionChange', handler);
  }

  onResponse(handler: (response: DccResponse) => void): void {
    this.emitter.on('response', handler);
  }

  /**
   * Deliberately **not** in `commandLog`. That log means "commands that were
   * meant to move something", and every existing assertion on it is written
   * that way; a probe every five seconds would turn each one into a hunt for
   * the interesting entry. `probeCount` is where a test that cares looks.
   */
  async probeStatus(): Promise<void> {
    this.probeCount++;
    this.respond({
      kind: 'identity',
      version: this.identity.version,
      product: this.identity.product,
      commit: this.identity.commit,
      raw: this.identityBanner(),
    });
    this.respond({ kind: 'power', track: 'main', on: this.mainPowerOn });
    this.respond({ kind: 'power', track: 'prog', on: this.progPowerOn });
  }

  async setSpeed(address: number, speed: number, direction: 'fwd' | 'rev' | 'stop'): Promise<void> {
    const data = { address, speed, direction };
    this.log.info('[SimDCC] SET_SPEED', data);
    this.commandLog.push({ ts: new Date(), type: 'SET_SPEED', data });

    if (this.consumeRejection()) return;

    // Mirrors the station: the reply is built from the command, not from any
    // notion of what the rails are doing.
    const speedByte = encodeSpeedByte(
      direction === 'stop' ? 0 : speed,
      direction === 'rev' ? 'rev' : 'fwd',
    );
    const decoded = decodeSpeedByte(speedByte);
    this.respond({
      kind: 'cab',
      cab: this.cabOverride ?? address,
      register: 0,
      speedByte,
      speed: decoded.speed,
      direction: decoded.direction,
      functionMap: 0,
    });
    this.cabOverride = null;
  }

  async setFunction(address: number, fn: number, state: boolean): Promise<void> {
    // Deliberately still works. #150 guards the *hardware* adapter, because
    // PicoDCC accepts `<F>` and discards it; the model has no such limit and a
    // simulator that threw would make the limitation look like a design choice.
    const data = { address, fn, state };
    this.log.info('[SimDCC] SET_FUNCTION', data);
    this.commandLog.push({ ts: new Date(), type: 'SET_FUNCTION', data });
  }

  async setPoint(dccAddress: number, position: 'normal' | 'reverse'): Promise<void> {
    const data = { dccAddress, position };
    this.log.info('[SimDCC] SET_POINT', data);
    this.commandLog.push({ ts: new Date(), type: 'SET_POINT', data });
    if (this.consumeRejection()) return;
    this.respond({ kind: 'accessory-ok' });
  }

  async emergencyStop(): Promise<void> {
    this.log.info('[SimDCC] EMERGENCY_STOP');
    this.commandLog.push({ ts: new Date(), type: 'EMERGENCY_STOP', data: {} });
  }

  /** Clears the command log. Useful between test cases. */
  clearLog(): void {
    this.commandLog.length = 0;
  }

  // ─── Test controls ────────────────────────────────────────────────────────

  /** Emits an arbitrary response, as if the station had said it unprompted. */
  emitResponse(response: DccResponse): void {
    this.respond(response, { force: true });
  }

  /** Answers `<X>` to the next `count` commands instead of acknowledging them. */
  rejectNext(count = 1): void {
    this.rejectCount = count;
  }

  /** Acknowledges the next throttle command against `cab` rather than the loco addressed (#147's hazard). */
  acknowledgeNextAs(cab: number): void {
    this.cabOverride = cab;
  }

  /** Stops answering anything. The port stays "open", which is exactly the case `isConnected()` cannot see. */
  goSilent(silent = true): void {
    this.silent = silent;
  }

  /** Restarts the station: a new commit, and an unprompted identity banner — the `station-restarted` signal. */
  simulateRestart(commit = 'restart'): void {
    this.identity = { ...this.identity, commit };
    this.respond(
      {
        kind: 'identity',
        version: this.identity.version,
        product: this.identity.product,
        commit: this.identity.commit,
        raw: this.identityBanner(),
      },
      { force: true },
    );
  }

  /** Reports a track power change, as the station does when its own LCD is used, or after a cutoff. */
  setSimulatedPower(track: 'main' | 'prog', on: boolean): void {
    if (track === 'main') this.mainPowerOn = on;
    else this.progPowerOn = on;
    this.respond({ kind: 'power', track, on }, { force: true });
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private identityBanner(): string {
    return `<iDCC-EX V-${this.identity.version} / ${this.identity.product} / BUILD simulated G-${this.identity.commit}>`;
  }

  private consumeRejection(): boolean {
    if (this.rejectCount <= 0) return false;
    this.rejectCount--;
    this.respond({ kind: 'rejected' });
    return true;
  }

  private respond(response: DccResponse, opts: { force?: boolean } = {}): void {
    if (this.silent && !opts.force) return;
    this.emitter.emit('response', response);
  }
}
