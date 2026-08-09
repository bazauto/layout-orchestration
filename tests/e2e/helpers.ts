import type { Page } from '@playwright/test';

/**
 * Mocks GET /api/auth/me as an already-authenticated session, so specs that
 * exercise the operate/configure/track-editor UI (not the login flow
 * itself) can skip straight past LoginScreen — matching this suite's
 * existing "no real backend process" approach (see installMockWebSocket
 * below). tests/e2e/auth.spec.ts covers the actual login/logout UI, with
 * its own mocked /api/auth/login and /api/auth/logout responses.
 *
 * `options.role` defaults to `'admin'` so every existing call site is
 * unaffected (issue #53) — pass `{ role: 'operator' }` for specs exercising
 * the operator-role posture (e.g. the Users tab must not render).
 */
export async function installMockAuth(page: Page, options: { role?: 'admin' | 'operator' } = {}) {
  const role = options.role ?? 'admin';
  await page.route('**://localhost:3000/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ username: role === 'admin' ? 'e2e-admin' : 'e2e-operator', role }),
    }),
  );
}

/**
 * Install a fake WebSocket before the app loads so frontend logic sees a
 * connected backend without needing a real backend process in e2e tests.
 *
 * `options.snapshot` is delivered as a `STATE_SNAPSHOT` frame immediately
 * after open. Callers that only need the socket to *exist* (most of them —
 * the Configure and Track Editor screens do not read system status) can omit
 * it and get the previous behaviour: no frame, so `systemStatus` stays
 * `'offline'`. Anything exercising the Operate screen needs it, because the
 * throttle, point, and route controls are all deliberately disabled until
 * the system reports itself online.
 */
export async function installMockWebSocket(
  page: Page,
  options: { snapshot?: Record<string, unknown> } = {},
) {
  await page.addInitScript((snapshot) => {
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
          if (snapshot) {
            this.onmessage?.(
              new MessageEvent('message', {
                data: JSON.stringify({ type: 'STATE_SNAPSHOT', payload: snapshot }),
              }),
            );
          }
        });
      }

      send(_data: string) {
        // No-op for tests unless a specific test inspects outbound messages.
        //
        // Know what this costs you: with `send` inert and no backend process
        // behind it, **no spec in this suite can observe backend behaviour**.
        // A defect in the WebSocket transport, a service, or the domain leaves
        // this suite green — a broadcast bug that made every live update stop
        // reaching the browser was invisible here, and the tempting "fix" is to
        // make the mock echo, which proves nothing about the real server.
        // Reproduce below-the-browser bugs in the backend integration or
        // scenario suites instead; Playwright's job here is the DOM.
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
  }, options.snapshot);
}
