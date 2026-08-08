/**
 * MockWebSocket
 *
 * Installed onto `globalThis.WebSocket` for hook tests (`useLayoutSocket.test.ts`)
 * that exercise the connection lifecycle without a real broker or backend.
 *
 * This is the vitest-process sibling of the Playwright mock in
 * `tests/e2e/helpers.ts#installMockWebSocket` — that one is injected into a
 * real browser via `page.addInitScript`, which stringifies it across the
 * Playwright/browser boundary, so it cannot be imported here; a vitest
 * process and a Playwright-controlled browser are different realms that
 * share only the shape of the thing being mocked, not code. Extraction into
 * a common module was considered for issue #8 and rejected for that reason
 * — do not retry it.
 *
 * Unlike the e2e mock, construction does NOT auto-open: these tests need to
 * assert the `'connecting'` state that exists before `open()`, so every
 * transition (`open`, `emit`, `serverClose`, `fail`) is driven explicitly by
 * the test.
 */

export class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  /** Every instance constructed since the last `reset()`, in construction order. */
  static instances: MockWebSocket[] = [];

  static reset(): void {
    MockWebSocket.instances = [];
  }

  readyState = 0; // CONNECTING, matching a real WebSocket's initial state
  url: string;
  sent: string[] = [];

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  /** Test-driven: the server accepts the connection. */
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  /** Test-driven: a server frame arrives. JSON-stringifies `msg` before firing `onmessage`. */
  emit(msg: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(msg) }));
  }

  /** Test-driven: a malformed (non-JSON) frame arrives — passed through verbatim, unlike `emit`. */
  emitRaw(data: string): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** Test-driven: the server closes the connection. */
  serverClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  /** Test-driven: a socket error fires. A real browser follows this with a close; so does this mock's `close()`. */
  fail(): void {
    this.onerror?.(new Event('error'));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Matches the real WebSocket API — this is what the hook itself calls on unmount and on `onerror`. */
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

let previousWebSocket: typeof WebSocket | undefined;

/** Replaces `globalThis.WebSocket` with `MockWebSocket` and clears `instances`. */
export function installMockWebSocket(): void {
  previousWebSocket = globalThis.WebSocket;
  MockWebSocket.reset();
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
}

/** Restores whatever `globalThis.WebSocket` was before `installMockWebSocket()`. */
export function restoreWebSocket(): void {
  if (previousWebSocket) {
    globalThis.WebSocket = previousWebSocket;
  }
  MockWebSocket.reset();
}
