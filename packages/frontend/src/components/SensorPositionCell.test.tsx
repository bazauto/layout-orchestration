/**
 * #77's authoring cell (`docs/sensor-position.md` D1/D3/D4).
 *
 * What is worth asserting here is not the markup but the *rules*: the
 * measurement saves as one atomic pair, "unmeasured" is reachable and is a
 * word rather than a blank, and anything that cannot carry a position says so
 * instead of offering controls the backend would refuse.
 *
 * `fireEvent`, not `@testing-library/user-event` — the latter is not a
 * dependency of this workspace and every interaction here is a single change
 * or blur, so there is no typing cadence worth simulating.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SensorPositionCell } from './SensorPositionCell';
import { BlockEdgeRecord, BlockRecord, SensorRecord } from '../types';

const LAYOUT = 'layout-1';

const BLOCKS: BlockRecord[] = [
  { id: 'b1', layoutId: LAYOUT, name: 'Platform 1', lengthMm: 1200 },
  { id: 'b2', layoutId: LAYOUT, name: 'Goods Shed', lengthMm: 900 },
];

/** b1 <-> b2, one row per direction as the compiler emits them. */
const EDGES: BlockEdgeRecord[] = [
  { id: 'e1', layoutId: LAYOUT, fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west', pointConditions: [] },
  { id: 'e1r', layoutId: LAYOUT, fromBlockId: 'b2', fromEnd: 'west', toBlockId: 'b1', toEnd: 'east', pointConditions: [] },
];

function sensor(overrides: Partial<SensorRecord> = {}): SensorRecord {
  return {
    id: 'beam-1',
    layoutId: LAYOUT,
    name: 'Platform 1 beam',
    type: 'ir_position',
    blockId: 'b1',
    mqttTopic: `layout/${LAYOUT}/sensor/beam-1/reading`,
    inService: true,
    positionTowardBlockId: null,
    positionOffsetMm: null,
    ...overrides,
  };
}

function renderCell(overrides: Partial<SensorRecord> = {}, edges = EDGES) {
  const onSave = vi.fn();
  const { unmount } = render(
    <SensorPositionCell sensor={sensor(overrides)} blocks={BLOCKS} edges={edges} onSave={onSave} />,
  );
  return { onSave, unmount };
}

const anchor = () => screen.getByLabelText('measured toward');
const offset = () => screen.getByLabelText('offset in mm');

describe('SensorPositionCell', () => {
  it('offers only the neighbours the drawing joins this block to', () => {
    renderCell();
    expect([...(anchor() as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      '— unmeasured —',
      'toward Goods Shed',
    ]);
  });

  it('saves both halves in ONE call once the offset is committed', () => {
    const { onSave } = renderCell({ positionTowardBlockId: 'b2' });

    fireEvent.change(offset(), { target: { value: '400' } });
    // Typing alone saves nothing — three digits would otherwise be three
    // writes, two of them describing a beam nobody meant.
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.blur(offset());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ towardBlockId: 'b2', offsetMm: 400 });
  });

  it('clearing the anchor clears the whole measurement, rather than stranding the offset', () => {
    const { onSave } = renderCell({ positionTowardBlockId: 'b2', positionOffsetMm: 400 });

    fireEvent.change(anchor(), { target: { value: '' } });
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('clearing the offset clears the whole measurement too — unmeasured is a real, safe state (D3)', () => {
    const { onSave } = renderCell({ positionTowardBlockId: 'b2', positionOffsetMm: 400 });

    fireEvent.change(offset(), { target: { value: '' } });
    fireEvent.blur(offset());
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('refuses to save a zero or fractional offset, clearing instead — a beam ON the joint is not a measurement', () => {
    for (const value of ['0', '-5', '12.5']) {
      const { onSave, unmount } = renderCell({ positionTowardBlockId: 'b2', positionOffsetMm: 400 });
      fireEvent.change(offset(), { target: { value } });
      fireEvent.blur(offset());
      expect(onSave, value).toHaveBeenCalledWith(null);
      unmount();
    }
  });

  it('saves nothing at all when neither half changed', () => {
    const { onSave } = renderCell({ positionTowardBlockId: 'b2', positionOffsetMm: 400 });

    fireEvent.blur(offset());
    expect(onSave).not.toHaveBeenCalled();
  });

  it('says "n/a" for a block_detection sensor rather than offering controls the backend would refuse (D4)', () => {
    renderCell({ type: 'block_detection' });
    expect(screen.getByText('n/a')).toBeTruthy();
    expect(screen.queryByLabelText('measured toward')).toBeNull();
  });

  it('says "no block" for a sensor with nothing to be positioned within', () => {
    renderCell({ blockId: null });
    expect(screen.getByText('no block')).toBeTruthy();
    expect(screen.queryByLabelText('measured toward')).toBeNull();
  });

  it('disables the offset when the drawing joins this block to nobody — an offset with no anchor means nothing', () => {
    renderCell({}, []);
    expect((offset() as HTMLInputElement).disabled).toBe(true);
  });
});
