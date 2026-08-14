/**
 * Tile paths — the SVG geometry for each `TileType`.
 *
 * Pure per-tile drawing: no state, no viewport, no knowledge of the grid it
 * sits in. Extracted from `GridEditor.tsx` by #75 so the editor and a future
 * monitor view (#63/#82) draw exactly the same track — a second, subtly
 * different renderer of the same railway is the whole risk that issue names.
 */

import { TileType } from '../types';

export const TILE_SIZE = 40;

const TRACK_COLOUR = '#89b4fa';
const SLEEPER_COLOUR = '#585b70';
const T = TILE_SIZE;
const H = T / 2; // half tile

// ─── SVG paths per tile type ─────────────────────────────────────────────────

export function TilePath({ type }: { type: TileType }) {
  const stroke = { stroke: TRACK_COLOUR, strokeWidth: 4, fill: 'none', strokeLinecap: 'round' as const };
  const sleeper = { stroke: SLEEPER_COLOUR, strokeWidth: 2, fill: 'none' };

  // Sleeper marks across the track
  const sleeperMarks = (positions: number[], vertical = false) =>
    positions.map((p, i) =>
      vertical
        ? <line key={i} x1={H - 7} y1={p} x2={H + 7} y2={p} {...sleeper} />
        : <line key={i} x1={p} y1={H - 7} x2={p} y2={H + 7} {...sleeper} />,
    );

  switch (type) {
    case 'straight-h':
      return <>
        {sleeperMarks([8, 16, 24, 32])}
        <line x1={0} y1={H} x2={T} y2={H} {...stroke} />
      </>;
    case 'straight-v':
      return <>
        {sleeperMarks([8, 16, 24, 32], true)}
        <line x1={H} y1={0} x2={H} y2={T} {...stroke} />
      </>;
    case 'straight-45':
      return (
        // Midpoint-to-midpoint diagonal so adjacent tiles connect cleanly
        <line x1={0} y1={H} x2={H} y2={0} {...stroke} />
      );
    case 'curve':
      // Quarter-circle connecting left-centre → bottom-centre.
      // Rotate 90° → bottom→right, 180° → right→top, 270° → top→left.
      return <path d={`M 0 ${H} A ${H} ${H} 0 0 0 ${H} ${T}`} {...stroke} />;
    case 'curve-ne':
      return <path d={`M ${H} ${T} A ${H} ${H} 0 0 1 ${T} ${H}`} {...stroke} />;
    case 'curve-nw':
      return <path d={`M ${H} ${T} A ${H} ${H} 0 0 0 ${0} ${H}`} {...stroke} />;
    case 'curve-se':
      return <path d={`M ${H} ${0} A ${H} ${H} 0 0 0 ${T} ${H}`} {...stroke} />;
    case 'curve-sw':
      return <path d={`M ${H} ${0} A ${H} ${H} 0 0 1 ${0} ${H}`} {...stroke} />;
    case 'point-left':
      // Through line left→right. Divergent forks at left-center up to top-center.
      // Place a Corner@180° directly above to redirect to a parallel track.
      return <>
        <line x1={0} y1={H} x2={T} y2={H} {...stroke} />
        <line x1={0} y1={H} x2={H} y2={0} {...{ ...stroke, strokeWidth: 3, stroke: '#cba6f7' }} />
      </>;
    case 'point-right':
      // Divergent forks at left-center down to bottom-center.
      return <>
        <line x1={0} y1={H} x2={T} y2={H} {...stroke} />
        <line x1={0} y1={H} x2={H} y2={T} {...{ ...stroke, strokeWidth: 3, stroke: '#cba6f7' }} />
      </>;
    case 'crossing':
      return <>
        <line x1={0} y1={H} x2={T} y2={H} {...stroke} />
        <line x1={H} y1={0} x2={H} y2={T} {...stroke} />
      </>;
    case 'buffer':
      return <>
        <line x1={0} y1={H} x2={H} y2={H} {...stroke} />
        <rect x={H - 2} y={H - 8} width={10} height={16} fill={TRACK_COLOUR} rx={2} />
      </>;
    case 'platform':
      return <>
        <line x1={0} y1={H} x2={T} y2={H} {...stroke} />
        <rect x={4} y={H - 12} width={T - 8} height={8} fill="#a6e3a1" rx={2} opacity={0.7} />
      </>;
    default:
      return null;
  }
}
