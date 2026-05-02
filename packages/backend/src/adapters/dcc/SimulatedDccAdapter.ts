/**
 * SimulatedDccAdapter
 *
 * An in-process simulator for the DCC command station.
 * Logs all commands via the provided logger — no serial port required.
 * Used in development (USE_SIMULATOR=true) and all automated tests.
 */

import { EventEmitter } from 'events';
import { IDccController } from '../../ports/IDccController';

export interface SimulatedDccLogger {
  info(msg: string, data?: Record<string, unknown>): void;
}

export class SimulatedDccAdapter implements IDccController {
  private connected = false;
  private readonly emitter = new EventEmitter();
  /** Full record of every command issued, useful for test assertions. */
  public readonly commandLog: Array<{ ts: Date; type: string; data: Record<string, unknown> }> = [];

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

  async setSpeed(
    address: number,
    speed: number,
    direction: 'fwd' | 'rev' | 'stop',
  ): Promise<void> {
    const data = { address, speed, direction };
    this.log.info('[SimDCC] SET_SPEED', data);
    this.commandLog.push({ ts: new Date(), type: 'SET_SPEED', data });
  }

  async setFunction(address: number, fn: number, state: boolean): Promise<void> {
    const data = { address, fn, state };
    this.log.info('[SimDCC] SET_FUNCTION', data);
    this.commandLog.push({ ts: new Date(), type: 'SET_FUNCTION', data });
  }

  async setPoint(dccAddress: number, position: 'normal' | 'reverse'): Promise<void> {
    const data = { dccAddress, position };
    this.log.info('[SimDCC] SET_POINT', data);
    this.commandLog.push({ ts: new Date(), type: 'SET_POINT', data });
  }

  async emergencyStop(): Promise<void> {
    this.log.info('[SimDCC] EMERGENCY_STOP');
    this.commandLog.push({ ts: new Date(), type: 'EMERGENCY_STOP', data: {} });
  }

  /** Clears the command log. Useful between test cases. */
  clearLog(): void {
    this.commandLog.length = 0;
  }
}
