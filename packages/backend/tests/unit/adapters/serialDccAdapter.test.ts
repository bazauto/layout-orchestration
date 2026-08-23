/**
 * `SerialDccAdapter` is excluded from coverage because it needs a serial port
 * — but two of its behaviours need no port at all, and both are safety
 * behaviours, which is exactly the combination that went untested before #147.
 *
 * 1. `setFunction` refuses (#150). It throws before it touches the port.
 * 2. Every write refuses when the port is shut, rather than resolving as though
 *    the command went out.
 *
 * Everything else about this adapter — the framing, the command strings — lives
 * in `domain/` precisely so it can be tested properly. See
 * `dccResponse.test.ts` and `dccWireFormat.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DccFunctionUnsupportedError,
  SerialDccAdapter,
} from '../../../src/adapters/dcc/SerialDccAdapter';

function makeAdapter() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { adapter: new SerialDccAdapter({ path: '/dev/null', baudRate: 115200 }, log), log };
}

describe('SerialDccAdapter.setFunction (#150)', () => {
  it('throws instead of writing, because PicoDCC accepts <F> and does nothing with it', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.setFunction(3, 0, true)).rejects.toBeInstanceOf(
      DccFunctionUnsupportedError,
    );
  });

  it('names the firmware issue in the error, so the next person does not re-derive it', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.setFunction(3, 2, true)).rejects.toThrow(/PicoDCC#1/);
  });

  it('warns as well as throwing — a refused command an operator asked for is worth a log line', async () => {
    const { adapter, log } = makeAdapter();
    await adapter.setFunction(3, 0, true).catch(() => {});
    expect(log.warn).toHaveBeenCalledWith(
      '[SerialDCC] Refused function command',
      expect.objectContaining({ locoAddress: 3, fn: 0 }),
    );
  });

  it('refuses even when the port is shut, and with the SAME error — the guard is not a side effect of being offline', async () => {
    const { adapter } = makeAdapter();
    expect(adapter.isConnected()).toBe(false);
    await expect(adapter.setFunction(3, 0, true)).rejects.toBeInstanceOf(
      DccFunctionUnsupportedError,
    );
  });
});

describe('SerialDccAdapter writes with no port', () => {
  it('rejects a throttle command rather than reporting it sent', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.setSpeed(3, 50, 'fwd')).rejects.toThrow(/not open/);
  });

  it('rejects a status probe too', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.probeStatus()).rejects.toThrow(/not open/);
  });
});
