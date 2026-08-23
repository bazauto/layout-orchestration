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
  formatSetPoint,
  formatSetSpeed,
  formatStatusRequest,
} from '../../domain/dccWireFormat';
import { DccResponse, readResponses } from '../../domain/dccResponse';

/**
 * Thrown by `SerialDccAdapter.setFunction` (#150). PicoDCC validates the cab,
 * accepts the command and then discards it — `updateFunct()` is empty — so a
 * write here would report success for a function that never happens. Throwing
 * is the lesser of the two silences: a caller that wanted a headlight finds out
 * immediately rather than from the layout.
 *
 * Delete this, and the guard, when `bazauto/PicoDCC#1` lands **both** halves:
 * the split from the throttle path (done, `PicoDCC#43`) and an actual function
 * implementation (not done).
 */
export class DccFunctionUnsupportedError extends Error {
  constructor(address: number, fn: number) {
    super(
      `Decoder functions are not implemented by the PicoDCC command station (bazauto/PicoDCC#1); refused F${fn} for loco ${address}`,
    );
    this.name = 'DccFunctionUnsupportedError';
  }
}

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
  /** Bytes received but not yet a complete `<…>` frame. */
  private rxBuffer = '';

  constructor(
    private readonly config: SerialDccConfig,
    private readonly log: SerialDccLogger,
  ) {}

  async connect(): Promise<void> {
    try {
      this.port = await openPort(this.config.path, this.config.baudRate);
      this.connected = true;
      // A fresh port starts a fresh stream: whatever half-frame was in flight
      // when the last one closed describes a session that no longer exists.
      this.rxBuffer = '';
      this.log.info('[SerialDCC] Connected', { path: this.config.path });
      this.emitter.emit('connectionChange', true);

      this.port.on('data', (chunk: Buffer) => this.handleData(chunk));

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

  onResponse(handler: (response: DccResponse) => void): void {
    this.emitter.on('response', handler);
  }

  async probeStatus(): Promise<void> {
    await this.write(formatStatusRequest());
  }

  /**
   * Frames and parses whatever arrived, then emits it. Parse and delegate,
   * nothing else — the safety rule about transport callbacks applies to serial
   * exactly as it does to MQTT, and everything that decides anything about
   * these responses lives in `domain/dccLink.ts` and `DccLinkService`.
   *
   * The buffer is a plain string carried between chunks because a frame can
   * split across reads; `extractFrames` bounds its growth, so a station that
   * emits a `<` and then dies cannot leak.
   */
  private handleData(chunk: Buffer): void {
    this.rxBuffer += chunk.toString('utf8');
    const { responses, rest, discarded } = readResponses(this.rxBuffer);
    this.rxBuffer = rest;

    if (discarded > 0) {
      // Not a fault: the station's UART carries a boot message or two, and a
      // stray newline is ordinary. Worth a line, because a *growing* count is
      // the signature of a garbled link.
      this.log.warn('[SerialDCC] Discarded unframed bytes', { discarded });
    }

    for (const response of responses) {
      this.log.info('[SerialDCC] RX', { response: response.kind });
      this.emitter.emit('response', response);
    }
  }

  async setSpeed(address: number, speed: number, direction: 'fwd' | 'rev' | 'stop'): Promise<void> {
    await this.write(formatSetSpeed(address, speed, direction));
  }

  /**
   * Refuses (#150). See `DccFunctionUnsupportedError` above for why a throw
   * beats a write here, and what has to land before the guard comes off.
   *
   * `state` is unused and that is the point — nothing is sent.
   */
  async setFunction(address: number, fn: number, state: boolean): Promise<void> {
    this.log.warn('[SerialDCC] Refused function command', {
      locoAddress: address,
      fn,
      state,
      reason: 'PicoDCC accepts <F> and does nothing with it (bazauto/PicoDCC#1)',
    });
    throw new DccFunctionUnsupportedError(address, fn);
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
