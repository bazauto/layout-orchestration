/**
 * `createLogger` (#161): the level lives here, not at each adapter/service
 * call site. The load-bearing behaviour is that `debug` is **absent from the
 * returned object**, not present-but-no-op, when the level is not `'debug'` —
 * that is what makes `this.log.debug?.(...)` free at every call site: no
 * string built, no object allocated, nothing written.
 */

import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/logger';

describe('createLogger', () => {
  it('omits debug entirely at the default level', () => {
    const log = createLogger('info');
    expect(log.debug).toBeUndefined();
  });

  it('omits debug for warn and error levels too — only "debug" turns it on', () => {
    expect(createLogger('warn').debug).toBeUndefined();
    expect(createLogger('error').debug).toBeUndefined();
  });

  it('includes debug when the level is "debug"', () => {
    const log = createLogger('debug');
    expect(log.debug).toBeInstanceOf(Function);
  });

  it('each method writes well-formed JSON to stdout, tagged with its own level', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const log = createLogger('debug');
      log.info('hello', { a: 1 });
      log.warn('careful', { b: 2 });
      log.error('bang', { c: 3 });
      log.debug?.('wire', { d: 4 });

      expect(write).toHaveBeenCalledTimes(4);
      const parsed = write.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
      expect(parsed[0]).toEqual({ level: 'info', msg: 'hello', a: 1 });
      expect(parsed[1]).toEqual({ level: 'warn', msg: 'careful', b: 2 });
      expect(parsed[2]).toEqual({ level: 'error', msg: 'bang', c: 3 });
      expect(parsed[3]).toEqual({ level: 'debug', msg: 'wire', d: 4 });
    } finally {
      write.mockRestore();
    }
  });

  it('a suppressed debug call short-circuits before doing any work — the optional-chain never invokes the missing method', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const log = createLogger('info');
      log.debug?.('never written', { anything: 'here' });
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});
