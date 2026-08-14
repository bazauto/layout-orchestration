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

import { render, screen, waitFor, within } from '@testing-library/react';
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

/**
 * App — operator UI scope (#61).
 *
 * `docs/auth.md`'s "Operator UI scope" decision: an operator sees the
 * Operate screen and nothing else — the Track Editor and Configure nav
 * entries are absent (not merely disabled), and their panels do not render.
 * Separate `describe` from the #65 gate above since it needs its own
 * `installMockAuth`-style fetch mock keyed by role, rather than the fixed
 * admin identity the #65 tests assume.
 */
const TAB_NAMES = ['Operate', 'Track Editor', 'Configure'];

function installRoleFetchMock(role: 'admin' | 'operator'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const username = role === 'admin' ? 'test-admin' : 'test-operator';

      if (url.includes('/api/auth/me')) {
        return Promise.resolve(jsonResponse(200, { username, role }));
      }

      if (url.includes('/api/capabilities')) {
        return Promise.resolve(jsonResponse(200, { sensorSimulation: false }));
      }

      return Promise.resolve(jsonResponse(200, []));
    }),
  );
}

describe('App — operator UI scope (#61)', () => {
  it('renders exactly one nav button (Operate) for an operator session, with no Track Editor / Configure panel', async () => {
    installMockWebSocket();
    installRoleFetchMock('operator');

    render(<App />);

    await waitFor(() => expect(screen.queryByText(/test-operator/)).not.toBeNull());

    const nav = screen.getByRole('navigation');
    const tabButtons = within(nav)
      .getAllByRole('button')
      .filter((b) => TAB_NAMES.includes(b.textContent ?? ''));

    expect(tabButtons.map((b) => b.textContent)).toEqual(['Operate']);

    // appTab defaults to 'operate' so these panels were never going to be on
    // screen either way — the nav assertion above is the real coverage —
    // but assert their absence too, since a state-restore or deep link is
    // exactly the case the render guards (not just the nav) exist for.
    expect(screen.queryByRole('heading', { name: 'Configuration' })).toBeNull();
    expect(screen.queryByRole('application')).toBeNull();
  });

  it('renders all three nav buttons for an admin session', async () => {
    installMockWebSocket();
    installRoleFetchMock('admin');

    render(<App />);

    await waitFor(() => expect(screen.queryByText(/test-admin/)).not.toBeNull());

    const nav = screen.getByRole('navigation');
    const tabButtons = within(nav)
      .getAllByRole('button')
      .filter((b) => TAB_NAMES.includes(b.textContent ?? ''));

    expect(tabButtons.map((b) => b.textContent)).toEqual(['Operate', 'Track Editor', 'Configure']);
  });
});
