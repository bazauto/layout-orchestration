/**
 * GridEditor
 *
 * SVG tile-based track layout editor.
 *
 * Controls:
 *   Left-click / drag  — paint selected tile type
 *   Right-click        — erase tile
 *   Middle-drag        — pan
 *   Scroll wheel       — zoom
 */

import { useCallback, useRef, useState } from 'react';
import { useGridEditor } from '../hooks/useGridEditor';
import { TileType } from '../types';
import { BlockRecord, PointRecord } from '../types';

interface Props {
  layoutId: string | null;
  blocks: BlockRecord[];
  points: PointRecord[];
}

const TILE_SIZE = 40;
const GRID_COLS = 30;
const GRID_ROWS = 20;

// ─── Tile palette ─────────────────────────────────────────────────────────────

const PALETTE: { type: TileType; label: string; icon: string }[] = [
  { type: 'straight-h',  label: 'Straight H',  icon: '─' },
  { type: 'straight-v',  label: 'Straight V',  icon: '│' },
  { type: 'curve-ne',    label: 'Curve NE',    icon: '╭' },
  { type: 'curve-nw',    label: 'Curve NW',    icon: '╮' },
  { type: 'curve-se',    label: 'Curve SE',    icon: '╰' },
  { type: 'curve-sw',    label: 'Curve SW',    icon: '╯' },
  { type: 'point-left',  label: 'Point L',     icon: '⊣' },
  { type: 'point-right', label: 'Point R',     icon: '⊢' },
  { type: 'crossing',    label: 'Crossing',    icon: '╋' },
  { type: 'buffer',      label: 'Buffer',      icon: '■' },
  { type: 'platform',    label: 'Platform',    icon: '▬' },
];

const TRACK_COLOUR = '#89b4fa';
const SLEEPER_COLOUR = '#585b70';
const T = TILE_SIZE;
const H = T / 2; // half tile

// ─── SVG paths per tile type ─────────────────────────────────────────────────

function TilePath({ type }: { type: TileType }) {
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
    case 'curve-ne':
      return <path d={`M ${H} ${T} A ${H} ${H} 0 0 1 ${T} ${H}`} {...stroke} />;
    case 'curve-nw':
      return <path d={`M ${H} ${T} A ${H} ${H} 0 0 0 ${0} ${H}`} {...stroke} />;
    case 'curve-se':
      return <path d={`M ${H} ${0} A ${H} ${H} 0 0 0 ${T} ${H}`} {...stroke} />;
    case 'curve-sw':
      return <path d={`M ${H} ${0} A ${H} ${H} 0 0 1 ${0} ${H}`} {...stroke} />;
    case 'point-left':
      return <>
        <line x1={0} y1={H} x2={T} y2={H} {...stroke} />
        <line x1={H} y1={H} x2={T} y2={0} {...{ ...stroke, strokeWidth: 3, stroke: '#cba6f7' }} />
      </>;
    case 'point-right':
      return <>
        <line x1={0} y1={H} x2={T} y2={H} {...stroke} />
        <line x1={H} y1={H} x2={T} y2={T} {...{ ...stroke, strokeWidth: 3, stroke: '#cba6f7' }} />
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

// ─── Main component ───────────────────────────────────────────────────────────

export function GridEditor({ layoutId, blocks, points }: Props) {
  const { grid, loading, error, placeTile, eraseTile, clearAll } = useGridEditor(layoutId);

  const [selectedType, setSelectedType] = useState<TileType>('straight-h');
  const [selectedBlockId, setSelectedBlockId] = useState<string>('');
  const [selectedPointId, setSelectedPointId] = useState<string>('');

  // Viewport pan/zoom
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isPainting, setIsPainting] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const panStart = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null);

  const svgToGrid = useCallback(
    (clientX: number, clientY: number) => {
      const rect = svgRef.current!.getBoundingClientRect();
      const sx = (clientX - rect.left - offset.x) / zoom;
      const sy = (clientY - rect.top - offset.y) / zoom;
      return { x: Math.floor(sx / TILE_SIZE), y: Math.floor(sy / TILE_SIZE) };
    },
    [offset, zoom],
  );

  const handleTileAction = useCallback(
    (clientX: number, clientY: number, erase: boolean) => {
      const { x, y } = svgToGrid(clientX, clientY);
      if (x < 0 || y < 0 || x >= GRID_COLS || y >= GRID_ROWS) return;
      if (erase) {
        void eraseTile(x, y);
      } else {
        const meta: Record<string, unknown> = {};
        if (selectedBlockId) meta.blockId = selectedBlockId;
        if (selectedPointId) meta.pointId = selectedPointId;
        void placeTile(x, y, selectedType, meta);
      }
    },
    [svgToGrid, eraseTile, placeTile, selectedType, selectedBlockId, selectedPointId],
  );

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      // middle — pan
      panStart.current = { mx: e.clientX, my: e.clientY, ox: offset.x, oy: offset.y };
      e.preventDefault();
      return;
    }
    setIsPainting(true);
    handleTileAction(e.clientX, e.clientY, e.button === 2);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (panStart.current) {
      setOffset({
        x: panStart.current.ox + (e.clientX - panStart.current.mx),
        y: panStart.current.oy + (e.clientY - panStart.current.my),
      });
      return;
    }
    if (!isPainting) return;
    handleTileAction(e.clientX, e.clientY, e.buttons === 2);
  };

  const onMouseUp = () => {
    setIsPainting(false);
    panStart.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.max(0.3, Math.min(3, z - e.deltaY * 0.001)));
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  const gridW = GRID_COLS * TILE_SIZE;
  const gridH = GRID_ROWS * TILE_SIZE;

  if (!layoutId) return <p style={st.empty}>No layout selected.</p>;

  return (
    <div style={st.wrapper}>
      {/* ── Toolbar ── */}
      <div style={st.toolbar}>
        <div style={st.paletteGroup}>
          {PALETTE.map((p) => (
            <button
              key={p.type}
              title={p.label}
              onClick={() => setSelectedType(p.type)}
              style={{
                ...st.paletteBtn,
                ...(selectedType === p.type ? st.paletteBtnActive : {}),
              }}
            >
              <span style={st.paletteIcon}>{p.icon}</span>
              <span style={st.paletteLabel}>{p.label}</span>
            </button>
          ))}
        </div>

        <div style={st.toolSep} />

        <label style={st.toolLabel}>
          Block
          <select
            value={selectedBlockId}
            onChange={(e) => setSelectedBlockId(e.target.value)}
            style={st.toolSelect}
          >
            <option value="">— none —</option>
            {blocks.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </label>

        <label style={st.toolLabel}>
          Point
          <select
            value={selectedPointId}
            onChange={(e) => setSelectedPointId(e.target.value)}
            style={st.toolSelect}
          >
            <option value="">— none —</option>
            {points.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>

        <div style={st.toolSep} />

        <button
          onClick={() => setZoom((z) => Math.min(z + 0.2, 3))}
          style={st.iconBtn}
          title="Zoom in"
        >＋</button>
        <button
          onClick={() => setZoom((z) => Math.max(z - 0.2, 0.3))}
          style={st.iconBtn}
          title="Zoom out"
        >－</button>
        <button
          onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}
          style={st.iconBtn}
          title="Reset view"
        >⌂</button>

        <div style={st.toolSep} />

        <button
          onClick={() => { if (confirm('Clear entire grid?')) void clearAll(); }}
          style={st.dangerBtn}
          title="Clear grid"
        >Clear</button>

        {loading && <span style={st.status}>Saving…</span>}
        {error && <span style={st.statusErr}>{error}</span>}
      </div>

      {/* ── Canvas ── */}
      <div style={st.canvasWrap}>
        <svg
          ref={svgRef}
          style={{ cursor: 'crosshair', display: 'block', width: '100%', height: '100%' }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onWheel={onWheel}
          onContextMenu={onContextMenu}
        >
          <g transform={`translate(${offset.x},${offset.y}) scale(${zoom})`}>
            {/* Grid lines */}
            <rect width={gridW} height={gridH} fill="#11111b" rx={2} />
            {Array.from({ length: GRID_COLS + 1 }, (_, i) => (
              <line
                key={`v${i}`}
                x1={i * TILE_SIZE} y1={0}
                x2={i * TILE_SIZE} y2={gridH}
                stroke="#313244" strokeWidth={0.5}
              />
            ))}
            {Array.from({ length: GRID_ROWS + 1 }, (_, i) => (
              <line
                key={`h${i}`}
                x1={0} y1={i * TILE_SIZE}
                x2={gridW} y2={i * TILE_SIZE}
                stroke="#313244" strokeWidth={0.5}
              />
            ))}

            {/* Placed tiles */}
            {Array.from(grid.values()).map((tile) => {
              const meta = (() => { try { return JSON.parse(tile.metadata); } catch { return {}; } })();
              const bName = meta.blockId ? blocks.find((b) => b.id === meta.blockId)?.name : null;
              return (
                <g key={tile.id || `${tile.x},${tile.y}`}
                  transform={`translate(${tile.x * TILE_SIZE},${tile.y * TILE_SIZE})`}>
                  <rect width={T} height={T} fill="#1e1e2e" />
                  <TilePath type={tile.tileType as TileType} />
                  {bName && (
                    <text x={T / 2} y={T - 4} textAnchor="middle"
                      fontSize={6} fill="#a6e3a1" fontFamily="monospace">
                      {bName}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Ghost tile under cursor (painted via CSS hover — handled below) */}
          </g>
        </svg>
      </div>

      {/* ── Legend ── */}
      <div style={st.legend}>
        <span style={{ color: '#6c7086', fontSize: 11 }}>
          Left-drag: paint · Right-click: erase · Middle-drag: pan · Scroll: zoom
          · Grid: {GRID_COLS}×{GRID_ROWS} · {grid.size} tile{grid.size !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const st = {
  wrapper:         { display: 'flex', flexDirection: 'column' as const, height: '100%', background: '#181825', border: '1px solid #313244', borderRadius: 6, overflow: 'hidden' },
  toolbar:         { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: '#1e1e2e', borderBottom: '1px solid #313244', flexWrap: 'wrap' as const },
  paletteGroup:    { display: 'flex', gap: 4, flexWrap: 'wrap' as const },
  paletteBtn:      { background: '#313244', border: '1px solid #45475a', borderRadius: 4, padding: '3px 7px', cursor: 'pointer', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 1, minWidth: 44 },
  paletteBtnActive:{ background: '#45475a', borderColor: '#89b4fa', boxShadow: '0 0 0 1px #89b4fa' },
  paletteIcon:     { fontSize: 16, color: '#89b4fa', lineHeight: 1 },
  paletteLabel:    { fontSize: 9, color: '#6c7086', textTransform: 'uppercase' as const, letterSpacing: '0.3px' },
  toolSep:         { width: 1, height: 28, background: '#313244', margin: '0 4px', flexShrink: 0 },
  toolLabel:       { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6c7086' },
  toolSelect:      { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '3px 6px', fontSize: 12 },
  iconBtn:         { background: '#313244', border: '1px solid #45475a', borderRadius: 4, color: '#cdd6f4', cursor: 'pointer', padding: '3px 9px', fontSize: 14 },
  dangerBtn:       { background: 'none', border: '1px solid #f38ba8', borderRadius: 4, color: '#f38ba8', cursor: 'pointer', padding: '3px 10px', fontSize: 12 },
  status:          { fontSize: 12, color: '#f9e2af', marginLeft: 8 },
  statusErr:       { fontSize: 12, color: '#f38ba8', marginLeft: 8 },
  canvasWrap:      { flex: 1, overflow: 'hidden', minHeight: 0, position: 'relative' as const },
  legend:          { padding: '4px 10px', background: '#11111b', borderTop: '1px solid #313244' },
  empty:           { color: '#6c7086', fontSize: 13, padding: 16 },
} as const;
