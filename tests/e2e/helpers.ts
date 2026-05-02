import type { Page } from '@playwright/test';

/**
 * Install a fake WebSocket before the app loads so frontend logic sees a
 * connected backend without needing a real backend process in e2e tests.
 */
export async function installMockWebSocket(page: Page) {
  await page.addInitScript(() => {
    class MockWebSocket {
      static OPEN = 1;
      static CLOSED = 3;

      readyState = MockWebSocket.OPEN;
      url: string;
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;

      constructor(url: string) {
        this.url = url;
        // Simulate async open like a real browser WebSocket.
        queueMicrotask(() => {
          this.onopen?.(new Event('open'));
        });
      }

      send(_data: string) {
        // No-op for tests unless a specific test inspects outbound messages.
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }

      addEventListener(type: string, listener: EventListener) {
        if (type === 'open') this.onopen = listener as (ev: Event) => void;
        if (type === 'message') this.onmessage = listener as (ev: MessageEvent) => void;
        if (type === 'close') this.onclose = listener as (ev: CloseEvent) => void;
        if (type === 'error') this.onerror = listener as (ev: Event) => void;
      }

      removeEventListener() {
        // No-op
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: MockWebSocket,
    });
  });
}
