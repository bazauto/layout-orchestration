/**
 * SerialDccAdapter
 *
 * Communicates with the PicoDCC command station over a serial/USB connection,
 * speaking a subset of DCC EX.
 *
 * **The command strings are not here.** They live in `domain/dccWireFormat.ts`,
 * pure and unit-tested, because this file is excluded from test coverage —
 * it needs physical hardware — and that exclusion is exactly how #147's
 * wrong-loco throttle command survived. This adapter opens the port, writes,
 * and reports connection changes; what the bytes mean is the domain's.
 *
 * Use SimulatedDccAdapter in all tests.
 */

import { EventEmitter } from 'events';
import { IDccController } from '../../ports/IDccController';
import {
  formatEmergencyStop,
  formatSetFunction,
  formatSetPoint,
  formatSetSpeed,
} from '../../domain/dccWireFormat';

export interface SerialDccLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface SerialDccConfig {
  path: string;
  baudRate: number;
}

/**
 * Lazily imports serialport to allow the rest of the application to boot
 * without native bindings when the simulator is active.
 */
async function openPort(path: string, baudRate: number): Promise<import('serialport').SerialPort> {
  const { SerialPort } = await import('serialport');
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate }, (err) => {
      if (err) reject(err);
      else resolve(port);
    });
  });
}

export class SerialDccAdapter implements IDccController {
  private port: import('serialport').SerialPort | null = null;
  private connected = false;
  private readonly emitter = new EventEmitter();

  constructor(
    private readonly config: SerialDccConfig,
    private readonly log: SerialDccLogger,
  ) {}

  async connect(): Promise<void> {
    try {
      this.port = await openPort(this.config.path, this.config.baudRate);
      this.connected = true;
      this.log.info('[SerialDCC] Connected', { path: this.config.path });
      this.emitter.emit('connectionChange', true);

      this.port.on('close', () => {
        this.connected = false;
        this.log.warn('[SerialDCC] Port closed unexpectedly');
        this.emitter.emit('connectionChange', false);
      });

      this.port.on('error', (err: Error) => {
        this.connected = false;
        this.log.error('[SerialDCC] Port error', { error: err.message });
        this.emitter.emit('connectionChange', false);
      });
    } catch (err) {
      this.log.error('[SerialDCC] Failed to connect', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.emitter.emit('connectionChange', false);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.port?.isOpen) {
      await new Promise<void>((resolve, reject) => {
        this.port!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    this.connected = false;
    this.emitter.emit('connectionChange', false);
  }

  isConnected(): boolean {
    return this.connected;
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.emitter.on('connectionChange', handler);
  }

  async setSpeed(address: number, speed: number, direction: 'fwd' | 'rev' | 'stop'): Promise<void> {
    await this.write(formatSetSpeed(address, speed, direction));
  }

  async setFunction(address: number, fn: number, state: boolean): Promise<void> {
    await this.write(formatSetFunction(address, fn, state));
  }

  async setPoint(dccAddress: number, position: 'normal' | 'reverse'): Promise<void> {
    await this.write(formatSetPoint(dccAddress, position));
  }

  async emergencyStop(): Promise<void> {
    await this.write(formatEmergencyStop());
  }

  private write(cmd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port?.isOpen) {
        return reject(new Error('Serial port is not open'));
      }
      this.log.info('[SerialDCC] TX', { cmd });
      this.port.write(`${cmd}\n`, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
