/**
 * `diagram/diagnostics#diagnosticCoordinate` — the structural coordinate
 * behind a diagnostic's "jump to this cell" button (#94).
 *
 * `describeDiagnostic` itself is exercised end-to-end through the Track
 * Editor's e2e specs (`tests/e2e/track-editor-wave2.spec.ts` and others),
 * which is where its prose actually matters; these tests are narrowly about
 * whether a finding has a coordinate to jump to at all, since getting that
 * wrong makes the panel offer a button that goes nowhere.
 */

import { describe, expect, it } from 'vitest';
import { diagnosticCoordinate } from './diagnostics';
import { GridDiagnostic } from '../types';

describe('diagnosticCoordinate', () => {
  it('reads a single-coordinate finding directly', () => {
    const d: GridDiagnostic = { kind: 'unclassified-tile', severity: 'info', at: { x: 9, y: 3 } };
    expect(diagnosticCoordinate(d)).toEqual({ x: 9, y: 3 });
  });

  it('takes the first entry of a list-coordinate finding', () => {
    // Every entry in the list names the same duplicated physical placement
    // (#74) — the first is as good a place to jump to as any of the others.
    const d: GridDiagnostic = {
      kind: 'duplicate-annotation',
      severity: 'warning',
      entityType: 'sensor',
      entityId: 's1',
      at: [
        { x: 4, y: 4 },
        { x: 8, y: 4 },
      ],
    };
    expect(diagnosticCoordinate(d)).toEqual({ x: 4, y: 4 });
  });

  it('returns null for a finding that names a block end, not a cell', () => {
    // `buffer-contradicted-by-edge` has no `at` at all — it points at a
    // block end, and a block end is not guaranteed to be on the drawing.
    // Inventing a coordinate here is exactly what this function exists to
    // avoid: it is what stops the panel from rendering a button that goes
    // nowhere.
    const d: GridDiagnostic = {
      kind: 'buffer-contradicted-by-edge',
      severity: 'warning',
      blockId: 'b1',
      label: 'yard-3',
      edgeIds: ['edge-1'],
    };
    expect(diagnosticCoordinate(d)).toBeNull();
  });

  it('returns null for end-not-on-diagram and block-without-detection, the other two coordinate-less kinds', () => {
    const endNotOnDiagram: GridDiagnostic = {
      kind: 'end-not-on-diagram',
      severity: 'warning',
      blockId: 'b1',
      label: 'east',
    };
    const blockWithoutDetection: GridDiagnostic = {
      kind: 'block-without-detection',
      severity: 'info',
      blockId: 'b1',
    };
    expect(diagnosticCoordinate(endNotOnDiagram)).toBeNull();
    expect(diagnosticCoordinate(blockWithoutDetection)).toBeNull();
  });

  // Both kinds below were added to the `GridDiagnostic` union without a case
  // here, so the function fell off its own end and returned `undefined` —
  // which reads as falsy at the call site and renders the line as plain text.
  // `track-not-joined` is the worst one to lose: it is a warning whose entire
  // content is "go and look at this cell".
  it('jumps to the drawn tile of track-not-joined, not the tile it butts against', () => {
    const d: GridDiagnostic = {
      kind: 'track-not-joined',
      severity: 'warning',
      at: { x: 12, y: 5 },
      edge: 'e',
      against: { x: 13, y: 5 },
    };
    expect(diagnosticCoordinate(d)).toEqual({ x: 12, y: 5 });
  });

  it('returns null for pinned-end-not-on-diagram, which names an end with no opening by definition', () => {
    const d: GridDiagnostic = {
      kind: 'pinned-end-not-on-diagram',
      severity: 'info',
      blockId: 'b1',
      label: 'yard-3',
    };
    expect(diagnosticCoordinate(d)).toBeNull();
  });
});
