/**
 * The throttle card (#165).
 *
 * The rules, not the markup: the slider commands without a **Set** press, the
 * final value of a drag is never dropped, `Stop` is one step, a card for a loco
 * under automation is armed rather than live, and direction cannot change under
 * a moving train.
 *
 * `fireEvent`, not `@testing-library/user-event` — the latter is not a
 * dependency of this workspace, and every interaction here is a single change
 * or click.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThrottleCard } from './ThrottleCard';
import { ClientMessage, LocoState } from '../types';

function locoState(overrides: Partial<LocoState> = {}): LocoState {
  return {
    address: 3,
    speed: 0,
    direction: 'stop',
    functions: {},
    authority: 'manual',
    lastUpdated: '2026-08-24T10:00:00.000Z',
    ...overrides,
  };
}

function renderCard(overrides: Partial<React.ComponentProps<typeof ThrottleCard>> = {}) {
  const send = vi.fn<(msg: ClientMessage) => void>();
  const onBrake = vi.fn(async () => ({ ok: true }));
  const onClose = vi.fn();

  render(
    <ThrottleCard
      layoutId="layout-1"
      address={3}
      name="Jinty"
      maxSpeed={126}
      state={locoState()}
      autoRouteId={null}
      disabled={false}
      index={0}
      send={send}
      onBrake={onBrake}
      onClose={onClose}
      {...overrides}
    />,
  );

  return { send, onBrake, onClose };
}

const slider = () => screen.getByRole('slider', { name: /Speed for Jinty/ });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ThrottleCard — the slider commands', () => {
  it('sends a throttle command on the first move, with no Set press', () => {
    const { send } = renderCard();

    fireEvent.change(slider(), { target: { value: '40' } });

    expect(send).toHaveBeenCalledWith({
      type: 'THROTTLE_COMMAND',
      payload: { locoAddress: 3, speed: 40, direction: 'fwd' },
    });
  });

  it('throttles a drag but never drops the final value', async () => {
    const { send } = renderCard();

    // A drag: the first move goes immediately, the rest land inside the
    // interval and must collapse to one trailing send carrying the LAST
    // value — the one that decides where the train ends up.
    fireEvent.change(slider(), { target: { value: '10' } });
    fireEvent.change(slider(), { target: { value: '20' } });
    fireEvent.change(slider(), { target: { value: '30' } });

    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(200);

    expect(send).toHaveBeenLastCalledWith({
      type: 'THROTTLE_COMMAND',
      payload: { locoAddress: 3, speed: 30, direction: 'fwd' },
    });
  });

  it('sends the released value immediately, ahead of a timer holding an older one', () => {
    const { send } = renderCard();

    fireEvent.change(slider(), { target: { value: '10' } });
    fireEvent.change(slider(), { target: { value: '55' } });
    fireEvent.pointerUp(slider());

    expect(send).toHaveBeenLastCalledWith({
      type: 'THROTTLE_COMMAND',
      payload: { locoAddress: 3, speed: 55, direction: 'fwd' },
    });
  });

  it('sends direction stop when the slider reaches zero', () => {
    const { send } = renderCard({ state: locoState({ speed: 40, direction: 'fwd' }) });

    fireEvent.change(slider(), { target: { value: '0' } });

    expect(send).toHaveBeenLastCalledWith({
      type: 'THROTTLE_COMMAND',
      payload: { locoAddress: 3, speed: 0, direction: 'stop' },
    });
  });
});

describe('ThrottleCard — Stop and Brake', () => {
  it('Stop commands speed 0 in one step', () => {
    const { send } = renderCard({ state: locoState({ speed: 70, direction: 'fwd' }) });

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(send).toHaveBeenCalledWith({
      type: 'THROTTLE_COMMAND',
      payload: { locoAddress: 3, speed: 0, direction: 'stop' },
    });
  });

  it('Brake runs the ramp rather than sending a throttle command', () => {
    const { send, onBrake } = renderCard({ state: locoState({ speed: 70, direction: 'fwd' }) });

    fireEvent.click(screen.getByRole('button', { name: 'Brake' }));

    expect(onBrake).toHaveBeenCalledWith(3);
    expect(send).not.toHaveBeenCalled();
  });

  it('shows the refusal when the backend declines the brake', async () => {
    const onBrake = vi.fn(async () => ({ ok: false, message: 'already stopped' }));
    renderCard({ onBrake, state: locoState({ speed: 70, direction: 'fwd' }) });

    fireEvent.click(screen.getByRole('button', { name: 'Brake' }));

    await waitFor(() => expect(screen.queryByText('already stopped')).not.toBeNull());
  });
});

describe('ThrottleCard — the automation interlock', () => {
  it('opens armed for a loco under an auto-authority route, naming the route', () => {
    renderCard({ autoRouteId: 'r-7' });

    expect(screen.queryByText('r-7')).not.toBeNull();
    expect((slider() as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not command while armed', () => {
    const { send } = renderCard({ autoRouteId: 'r-7' });

    fireEvent.change(slider(), { target: { value: '40' } });

    expect(send).not.toHaveBeenCalled();
  });

  it('goes live once control is taken', () => {
    const { send } = renderCard({ autoRouteId: 'r-7' });

    fireEvent.click(screen.getByRole('button', { name: /Take control/ }));
    fireEvent.change(slider(), { target: { value: '40' } });

    expect(send).toHaveBeenCalledWith({
      type: 'THROTTLE_COMMAND',
      payload: { locoAddress: 3, speed: 40, direction: 'fwd' },
    });
  });

  it('is inert while the connection or system is down, without an arming story', () => {
    const { send } = renderCard({ disabled: true });

    expect((slider() as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Take control/ })).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('ThrottleCard — direction', () => {
  it('refuses to change direction while the loco is commanded to move', () => {
    const { send } = renderCard({ state: locoState({ speed: 40, direction: 'fwd' }) });

    const reverse = screen.getByRole('button', { name: '▼ Rev' });
    expect((reverse as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(reverse);
    expect(send).not.toHaveBeenCalled();
  });

  it('commands the new direction at rest', () => {
    const { send } = renderCard({ state: locoState({ speed: 0, direction: 'stop' }) });

    fireEvent.click(screen.getByRole('button', { name: '▼ Rev' }));

    expect(send).toHaveBeenCalledWith({
      type: 'THROTTLE_COMMAND',
      payload: { locoAddress: 3, speed: 0, direction: 'rev' },
    });
  });

  it('adopts the direction the layout reports rather than defaulting to forward', () => {
    renderCard({ state: locoState({ speed: 0, direction: 'rev' }) });

    expect(screen.getByRole('button', { name: '▼ Rev' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('ThrottleCard — what it shows', () => {
  it('reads out the layout state, not the last slider position', () => {
    // The two differ whenever something else moved the train — a braking
    // ramp, an automation run, an Emergency Stop — and the card must show the
    // train rather than its own last input.
    renderCard({ state: locoState({ speed: 88, direction: 'rev' }) });

    expect(screen.queryByText('88 rev')).not.toBeNull();
  });

  it('closes on request', () => {
    const { onClose } = renderCard();

    fireEvent.click(screen.getByRole('button', { name: /Close the throttle for Jinty/ }));

    expect(onClose).toHaveBeenCalled();
  });
});
