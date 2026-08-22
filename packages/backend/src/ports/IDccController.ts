/**
 * Port: IDccController
 *
 * Defines the contract for communicating with the DCC command station.
 * Implementations: SerialDccAdapter (real hardware), SimulatedDccAdapter (tests/dev).
 */

export interface IDccController {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  onConnectionChange(handler: (connected: boolean) => void): void;

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
