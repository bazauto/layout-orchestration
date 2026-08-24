/**
 * The point key's controls (#165).
 *
 * The key itself is covered by `diagram/pointKey.test.ts` — what is asserted
 * here is who may press what: a `monitor` gets no Set column at all, a point
 * held by a route offers no buttons rather than disabled ones, and the two
 * buttons are explicit positions rather than a toggle off a position that may
 * read `unknown`.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PointKeyPanel } from './PointKeyPanel';
import { PointKeyRow } from '../diagram/pointKey';

function row(overrides: Partial<PointKeyRow> = {}): PointKeyRow {
  return {
    pointId: 'p1',
    short: 'P1',
    name: 'P1 - Fiddle Yard',
    position: 'normal',
    confirmation: 'unreported',
    positionFeedback: 'none',
    lockedByRoute: null,
    ...overrides,
  };
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof PointKeyPanel>> = {}) {
  const onSetPoint = vi.fn();
  render(
    <PointKeyPanel
      layoutId="layout-1"
      rows={[row()]}
      canControl
      disabled={false}
      onSetPoint={onSetPoint}
      {...overrides}
    />,
  );
  return { onSetPoint };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('PointKeyPanel — setting a point', () => {
  it('commands the position named by the button, not "the other one"', () => {
    const { onSetPoint } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Set P1 - Fiddle Yard to reverse' }));

    expect(onSetPoint).toHaveBeenCalledWith('p1', 'reverse');
  });

  it('allows re-commanding the position the point already reports', () => {
    // How an operator re-asserts a point whose confirmation came back
    // `mismatch` or `timed-out` (docs/point-feedback.md).
    const { onSetPoint } = renderPanel({
      rows: [row({ position: 'normal', confirmation: 'mismatch' })],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Set P1 - Fiddle Yard to normal' }));

    expect(onSetPoint).toHaveBeenCalledWith('p1', 'normal');
  });

  it('marks the current position, so an unknown one marks neither', () => {
    renderPanel({ rows: [row({ position: 'unknown' })] });

    const normal = screen.getByRole('button', { name: 'Set P1 - Fiddle Yard to normal' });
    const reverse = screen.getByRole('button', { name: 'Set P1 - Fiddle Yard to reverse' });
    expect(normal.getAttribute('aria-pressed')).toBe('false');
    expect(reverse.getAttribute('aria-pressed')).toBe('false');
  });

  it('offers no buttons for a point a route holds, and says why', () => {
    // Not two disabled buttons: a greyed control still poses a question whose
    // honest answer is "not from here". Forcing it cancels the route (D6) and
    // that belongs on the Routes panel.
    renderPanel({ rows: [row({ lockedByRoute: 'r-4' })] });

    expect(screen.queryByRole('button', { name: /Set P1/ })).toBeNull();
    expect(screen.queryByTitle(/Route r-4 holds this point/)).not.toBeNull();
  });

  it('disables the buttons while the connection or system is down', () => {
    const { onSetPoint } = renderPanel({ disabled: true });

    const reverse = screen.getByRole('button', { name: 'Set P1 - Fiddle Yard to reverse' });
    expect((reverse as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(reverse);
    expect(onSetPoint).not.toHaveBeenCalled();
  });
});

describe('PointKeyPanel — the monitor role', () => {
  it('gets the key with no Set column at all', () => {
    renderPanel({ canControl: false });

    // The row is still there, in full — a monitor reads everything.
    expect(screen.queryByText('P1 - Fiddle Yard')).not.toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Set' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Set P1/ })).toBeNull();
  });
});

describe('PointKeyPanel — the panel itself', () => {
  it('collapses and expands, keeping the count visible', () => {
    renderPanel();

    const header = screen.getByRole('button', { name: /Points/ });
    expect(within(screen.getByLabelText('Point key')).queryByRole('table')).not.toBeNull();

    fireEvent.click(header);

    expect(within(screen.getByLabelText('Point key')).queryByRole('table')).toBeNull();
  });
});
