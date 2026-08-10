/**
 * App — the #65 capabilities gate (R4).
 *
 * The gate genuinely lives in `App.tsx` (the `SensorSimulationPanel` wrapper
 * is not rendered at all when the flag is off), so testing it anywhere else
 * would test a copy. This is the repo's first component render test;
 * `@testing-library/react` + jsdom are already wired for hook tests, and
 * `src/test/mockWebSocket.ts` already exists for the socket `useLayoutSocket`
 * opens on mount.
 *
 * `fetch` is stubbed and routed by URL SUBSTRING, not call order — `useAuth`,
 * `useCapabilities`, and `useLayoutConfig` all fire from `useEffect`s that run
 * concurrently, and their order is not a contract this test should depend on.
 * The socket is left in `connecting` (never `.open()`d), so `layoutId` stays
 * null and `useLayoutConfig` never fetches — panels render disabled, which is
 * irrelevant to the gate under test here.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installMockWebSocket, restoreWebSocket } from './test/mockWebSocket';
import App from './App';

interface FetchRoutes {
  capabilities?: { status?: number; body?: unknown; reject?: boolean };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function installFetchMock(routes: FetchRoutes): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.includes('/api/auth/me')) {
        return Promise.resolve(jsonResponse(200, { username: 'test-admin', role: 'admin' }));
      }

      if (url.includes('/api/capabilities')) {
        if (routes.capabilities?.reject) return Promise.reject(new Error('network error'));
        return Promise.resolve(
          jsonResponse(routes.capabilities?.status ?? 200, routes.capabilities?.body ?? { sensorSimulation: false }),
        );
      }

      return Promise.resolve(jsonResponse(200, []));
    }),
  );
}

afterEach(() => {
  restoreWebSocket();
  vi.unstubAllGlobals();
});

describe('App — sensor simulation capability gate (#65)', () => {
  it('renders the sensor simulation panel when /api/capabilities reports sensorSimulation: true', async () => {
    installMockWebSocket();
    installFetchMock({ capabilities: { body: { sensorSimulation: true } } });

    render(<App />);

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /sensor simulation/i })).not.toBeNull(),
    );
  });

  it('does not render it when sensorSimulation is false', async () => {
    installMockWebSocket();
    installFetchMock({ capabilities: { body: { sensorSimulation: false } } });

    render(<App />);

    // Wait for the auth transition (loading -> authenticated) to have
    // settled before asserting absence, so this isn't just "too early".
    await waitFor(() => expect(screen.queryByText(/test-admin/)).not.toBeNull());
    expect(screen.queryByRole('heading', { name: /sensor simulation/i })).toBeNull();
  });

  it('does not render it when /api/capabilities returns 500 (fails closed)', async () => {
    installMockWebSocket();
    installFetchMock({ capabilities: { status: 500, body: { error: 'boom' } } });

    render(<App />);

    await waitFor(() => expect(screen.queryByText(/test-admin/)).not.toBeNull());
    expect(screen.queryByRole('heading', { name: /sensor simulation/i })).toBeNull();
  });

  it('does not render it when the /api/capabilities fetch rejects (fails closed)', async () => {
    installMockWebSocket();
    installFetchMock({ capabilities: { reject: true } });

    render(<App />);

    await waitFor(() => expect(screen.queryByText(/test-admin/)).not.toBeNull());
    expect(screen.queryByRole('heading', { name: /sensor simulation/i })).toBeNull();
  });
});
