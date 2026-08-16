/**
 * #77's sub-block measurement, edited as **one thing**
 * (`docs/sensor-position.md` D1).
 *
 * Its own file rather than a helper inside `ConfigPanel`, for the same reason
 * `EdgesTab` and `UsersTab` are: it carries a rule worth testing without
 * standing up the whole config screen and its four fetches.
 *
 * Both halves move in a single `PUT` carrying a `position` object, so there is
 * never an intermediate state in which the anchor names one boundary and the
 * offset was measured to another. Clearing either control clears the whole
 * measurement: **"unmeasured" is a real, safe state** (D3) that reproduces the
 * pre-#77 behaviour exactly, not an error to be argued out of.
 *
 * Renders as a word, not an empty cell, for anything that cannot carry a
 * position (D4). A `block_detection` sensor is a whole-block detector and is
 * not *at* anywhere; a sensor with no block has nothing to be positioned
 * within. Saying so beats offering controls the backend would 400 — and a
 * blank cell would read as a rendering gap rather than a fact.
 */

import { useState } from 'react';
import { anchorCandidates } from '../sensorPosition';
import { BlockEdgeRecord, BlockRecord, SensorRecord } from '../types';

export interface SensorPositionCellProps {
  sensor: SensorRecord;
  blocks: BlockRecord[];
  edges: BlockEdgeRecord[];
  /** `null` clears the whole measurement. Called only when the value actually changes. */
  onSave: (position: { towardBlockId: string; offsetMm: number } | null) => void;
}

export function SensorPositionCell({ sensor, blocks, edges, onSave }: SensorPositionCellProps) {
  // The offset is drafted locally so an operator can type "4", "40", "400"
  // without three saves — and three 400s on the way, since a lone offset with
  // no anchor is not a measurement. The anchor select saves immediately,
  // because a select has no half-typed state to protect.
  const [offsetDraft, setOffsetDraft] = useState<string | null>(null);

  if (sensor.type !== 'ir_position') {
    return (
      <span style={placeholder} title="A whole-block detector is not at any one spot (#77 D4)">
        n/a
      </span>
    );
  }
  if (!sensor.blockId) {
    return (
      <span style={placeholder} title="A sensor with no block has nothing to be positioned within">
        no block
      </span>
    );
  }

  const candidates = anchorCandidates(sensor.blockId, blocks, edges);
  const offset = offsetDraft ?? (sensor.positionOffsetMm === null ? '' : String(sensor.positionOffsetMm));

  /**
   * Saves only when both halves are present and the offset is a positive
   * integer; anything else clears the measurement, and only if there was one.
   * Mirrors `sensorPositionSchema` — a zero offset would put the beam *on* the
   * joint, which is not a measurement anyone takes.
   */
  const commit = (towardBlockId: string, offsetText: string) => {
    const offsetMm = Number(offsetText);
    if (!towardBlockId || offsetText.trim() === '' || !Number.isInteger(offsetMm) || offsetMm <= 0) {
      if (sensor.positionTowardBlockId !== null || sensor.positionOffsetMm !== null) onSave(null);
      return;
    }
    if (towardBlockId === sensor.positionTowardBlockId && offsetMm === sensor.positionOffsetMm) return;
    onSave({ towardBlockId, offsetMm });
  };

  return (
    <span style={cell}>
      <select
        aria-label="measured toward"
        value={sensor.positionTowardBlockId ?? ''}
        onChange={(e) => commit(e.target.value, offset)}
        style={select}
      >
        <option value="">— unmeasured —</option>
        {candidates.map((b) => (
          <option key={b.id} value={b.id}>toward {b.name}</option>
        ))}
      </select>
      <input
        aria-label="offset in mm"
        type="number"
        min={1}
        step={1}
        value={offset}
        placeholder="mm"
        // Nothing to measure toward: the drawing joins this block to no
        // neighbour exactly once, so an offset could not resolve to anything.
        disabled={candidates.length === 0}
        onChange={(e) => setOffsetDraft(e.target.value)}
        onBlur={() => {
          commit(sensor.positionTowardBlockId ?? '', offset);
          setOffsetDraft(null);
        }}
        style={input}
      />
    </span>
  );
}

// Local to this component — the shapes here are #77's, not the config screen's,
// and copying two rules beats exporting `ConfigPanel`'s whole style object.
const placeholder: React.CSSProperties = { color: '#7f849c', fontStyle: 'italic' };
const cell: React.CSSProperties = { display: 'inline-flex', gap: 4, alignItems: 'center' };
const select: React.CSSProperties = {
  background: '#313244', color: '#cdd6f4', border: '1px solid #45475a',
  borderRadius: 3, padding: '2px 6px', fontSize: 12,
};
const input: React.CSSProperties = { ...select, width: 70 };
