/**
 * MonitorView (#63, #75, #82)
 *
 * A read-only live mimic: the same railway the Track Editor draws, with what
 * the layout is doing now laid over it. No palette, no paint handlers, no
 * write path — it renders `TrackDiagram` with a `live` prop and a set of
 * no-op handlers, which is the whole reason #75 extracted that component
 * rather than letting a second renderer of the same railway grow here.
 *
 * ## What this view refuses to imply
 *
 * **Loco position is block-granular and always will be.** `BlockState`
 * carries the block a loco is in, and `docs/braking.md` B7 records that the
 * model is open-loop dead reckoning with no loco feedback channel. So a block
 * is highlighted; a train is never placed at a spot along it, and nothing is
 * animated between blocks. An interpolating animation would assert a
 * precision the system does not have — the same failure as drawing a
 * commanded point position as though it were confirmed.
 *
 * **Every point position here is commanded.** Until #25 there is no feedback
 * channel, so the caveat is stated once, persistently, in the status strip
 * rather than repeated on each point where it would become noise. When #25
 * lands the distinction becomes real and moves onto the points themselves.
 *
 * **A stale diagram must not look like a quiet layout.** That is the whole of
 * #82: a frozen socket leaves every block showing its last known occupancy
 * and nothing on screen saying so. When `freshness` is anything but `live`
 * the canvas is covered, not badged — see `docs/liveness.md` M5.
 */

import { useMemo, useRef } from 'react';
import { TrackDiagram, RULER_SIZE } from './TrackDiagram';
import { useGridEditor } from '../hooks/useGridEditor';
import { useOpenings } from '../hooks/useOpenings';
import { useDiagramModel } from '../diagram/diagramModel';
import { useDiagramViewport } from '../hooks/useDiagramViewport';
import { buildLiveDiagramState, Freshness } from '../diagram/liveState';
import { TILE_SIZE } from '../diagram/tilePaths';
import { FAULT, INK, LOCK, OCCUPANCY, SURFACE } from '../diagram/encoding';
import { BlockRecord, LocoRecord, PointRecord, SensorRecord, StateSnapshot } from '../types';

interface Props {
  layoutId: string | null;
  blocks: BlockRecord[];
  points: PointRecord[];
  sensors: SensorRecord[];
  locos: LocoRecord[];
  snapshot: StateSnapshot;
  freshness: Freshness;
}

/** A no-op mouse/keyboard handler set. The monitor has no authoring gestures at all. */
const noop = () => {};

export function MonitorView({
  layoutId,
  blocks,
  points,
  sensors,
  locos,
  snapshot,
  freshness,
}: Props) {
  const { grid, loading, loadError } = useGridEditor(layoutId);
  /**
   * Revision `0`, never bumped: the drawing is a config artefact that only
   * changes when someone edits it in the Track Editor, and a monitor is not
   * that someone. Re-reading the openings on a timer would be polling a
   * config surface from a display, which is a different feature (and a
   * different cost) from watching live state over the socket.
   */
  const { openings } = useOpenings(layoutId, 0);

  const model = useDiagramModel(grid, openings);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewport = useDiagramViewport(layoutId, svgRef, TILE_SIZE, RULER_SIZE);

  const sensorNames = useMemo(() => new Map(sensors.map((s) => [s.id, s.name])), [sensors]);

  const live = useMemo(
    () => buildLiveDiagramState(snapshot, locos, freshness),
    [snapshot, locos, freshness],
  );

  const safeStopped = snapshot.systemStatus === 'safe-stop';

  return (
    <div style={st.wrapper}>
      {/*
        The status strip. Deliberately above the canvas and always present:
        connection health that only appears when something is wrong is
        indistinguishable, at a glance, from a health indicator that has
        itself stopped updating.
      */}
      <div style={st.strip}>
        <FreshnessBadge freshness={freshness} />

        <span style={st.caveat} title="There is no point-position feedback channel yet (#25)">
          Point positions are <strong>commanded</strong>, not confirmed
        </span>

        <div style={st.legend}>
          <LegendItem glyph={OCCUPANCY.occupied.glyph} label="occupied" />
          <LegendItem glyph={OCCUPANCY.clear.glyph} label="clear" />
          <LegendItem glyph={OCCUPANCY.unknown.glyph} label="unknown" />
          <LegendItem glyph={LOCK.glyph} label="locked by a route" />
        </div>

        {loading && <span style={st.status}>Loading…</span>}
        {loadError && <span style={st.statusErr}>Could not load the drawing: {loadError}</span>}
      </div>

      {/*
        The strip above stays mounted even with no drawing to show.

        This view's whole job is to be trusted at a glance from across a room,
        and an unattended display that failed to load a layout would otherwise
        show a bare "no layout" message with no indication of whether it is
        even still connected — the same "looks fine, is not" failure as a
        frozen mimic, arrived at from a different direction.
      */}
      {!layoutId ? (
        <div style={st.canvasWrap}>
          <p style={st.empty}>No layout selected.</p>
        </div>
      ) : (
        <div style={st.canvasWrap}>
          <TrackDiagram
            ref={svgRef}
            grid={grid}
            parsedMeta={model.parsedMeta}
            extent={model.extent}
            offset={viewport.offset}
            zoom={viewport.zoom}
            runs={model.runs}
            tintOf={model.tintOf}
            pointLabelAt={model.pointLabelAt}
            portsAtCell={model.portsAtCell}
            openingsAtCell={model.openingsAtCell}
            points={points}
            blocks={blocks}
            sensorNames={sensorNames}
            // Always on. Label density is an authoring trade-off — the editor
            // hides labels to see the track it is painting. A mimic exists to
            // be read, and on it the label is the only thing naming a block,
            // since state has taken the colour channel.
            labelsVisible={() => true}
            live={live}
            accessibleName="Live track diagram. Read-only: this view shows block occupancy, route locks and commanded point positions, and has no controls."
            accessibleTitle="Live track diagram — read-only. Middle-drag to pan, wheel to zoom."
            onKeyDown={noop}
            // Pan and zoom only. A left-drag pans here as well as a middle-drag
            // — there is no paint gesture competing for the left button on a
            // read-only surface, and requiring a middle button on a tablet or a
            // trackpad would make the diagram undraggable on the two devices a
            // wall display is most likely to be.
            onMouseDown={(e) => viewport.beginPan(e.clientX, e.clientY)}
            onMouseMove={(e) => viewport.continuePan(e.clientX, e.clientY)}
            onMouseUp={viewport.endPan}
            onMouseLeave={viewport.endPan}
            onWheel={(e) => viewport.onWheel(e.deltaY)}
            onContextMenu={(e) => e.preventDefault()}
          />

          {/*
          Degradation, over the canvas rather than beside it (#82 item 1).

          A wash plus a word, not a tint: #81 forbids colour as the sole
          carrier, and this is the one state where being missed is the whole
          hazard. `pointerEvents: none` so pan and zoom still work — an
          operator investigating a frozen display should not also find the
          diagram unresponsive.
        */}
          {freshness !== 'live' && (
            <div style={st.degraded} role="status">
              <div style={st.degradedInner}>
                <div style={st.degradedGlyph}>{FAULT.glyph}</div>
                <div style={st.degradedTitle}>
                  {freshness === 'disconnected' ? 'Disconnected' : 'Not receiving updates'}
                </div>
                <div style={st.degradedBody}>
                  This diagram is showing the last state received. It is <strong>not</strong> a
                  picture of the layout now.
                </div>
              </div>
            </div>
          )}

          {/*
          Safe-Stop, unmissable rather than a badge (#82 item 4). It is the
          one state where nothing is allowed to move, and a mimic that
          under-sells it is under-selling the only thing that matters on it.
          Drawn even while stale — a stale Safe-Stop is still a Safe-Stop, and
          the two messages stack rather than competing.
        */}
          {safeStopped && (
            <div style={st.safeStop} role="alert">
              <span style={st.safeStopTitle}>{FAULT.glyph} SAFE-STOP</span>
              {snapshot.safeStopReason && (
                <span style={st.safeStopReason}>{snapshot.safeStopReason}</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FreshnessBadge({ freshness }: { freshness: Freshness }) {
  const text =
    freshness === 'live' ? 'Live' : freshness === 'stale' ? 'No updates' : 'Disconnected';
  return (
    <span
      style={{
        ...st.badge,
        borderColor: freshness === 'live' ? OCCUPANCY.clear.colour : FAULT.colour,
        color: freshness === 'live' ? OCCUPANCY.clear.colour : FAULT.colour,
      }}
      // Read out on change: the one thing an unattended display most needs to
      // announce is that it has stopped being one.
      aria-live="polite"
    >
      {/* A word, never a coloured dot alone (#81). */}
      {freshness === 'live' ? '●' : FAULT.glyph} {text}
    </span>
  );
}

function LegendItem({ glyph, label }: { glyph: string; label: string }) {
  return (
    <span style={st.legendItem}>
      <span style={st.legendGlyph}>{glyph}</span>
      {label}
    </span>
  );
}

const st = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    gap: 8,
  } as React.CSSProperties,
  strip: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    flexWrap: 'wrap',
    padding: '6px 10px',
    background: '#181825',
    border: '1px solid #313244',
    borderRadius: 4,
    fontSize: 12,
  } as React.CSSProperties,
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    border: '1px solid',
    borderRadius: 4,
    padding: '2px 8px',
    fontWeight: 600,
  } as React.CSSProperties,
  caveat: {
    color: INK.secondary,
  } as React.CSSProperties,
  legend: {
    marginLeft: 'auto',
    display: 'flex',
    gap: 12,
    color: INK.secondary,
  } as React.CSSProperties,
  legendItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  } as React.CSSProperties,
  legendGlyph: {
    fontFamily: 'monospace',
    color: INK.primary,
  } as React.CSSProperties,
  canvasWrap: {
    position: 'relative',
    flex: 1,
    minHeight: 0,
    background: SURFACE.canvas,
    border: '1px solid #313244',
    borderRadius: 4,
    overflow: 'hidden',
  } as React.CSSProperties,
  degraded: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(17, 17, 27, 0.72)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    textAlign: 'center',
  } as React.CSSProperties,
  degradedInner: {
    maxWidth: 420,
    padding: 20,
  } as React.CSSProperties,
  degradedGlyph: {
    fontSize: 34,
    color: FAULT.colour,
  } as React.CSSProperties,
  degradedTitle: {
    fontSize: 20,
    fontWeight: 700,
    color: FAULT.colour,
    marginTop: 6,
  } as React.CSSProperties,
  degradedBody: {
    fontSize: 13,
    color: INK.primary,
    marginTop: 8,
    lineHeight: 1.5,
  } as React.CSSProperties,
  safeStop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    background: FAULT.colour,
    color: '#11111b',
    padding: '6px 12px',
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
    fontWeight: 700,
  } as React.CSSProperties,
  safeStopTitle: {
    fontSize: 14,
    letterSpacing: 1,
  } as React.CSSProperties,
  safeStopReason: {
    fontWeight: 400,
    fontSize: 12,
  } as React.CSSProperties,
  status: {
    color: INK.secondary,
  } as React.CSSProperties,
  statusErr: {
    color: FAULT.colour,
  } as React.CSSProperties,
  empty: {
    color: INK.secondary,
    padding: 16,
  } as React.CSSProperties,
} as const;
