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

import { useEffect, useMemo, useRef } from 'react';
import { TrackDiagram, RULER_SIZE } from './TrackDiagram';
import { PointKeyPanel } from './PointKeyPanel';
import { buildPointKey } from '../diagram/pointKey';
import { buildRouteLines, routeSegmentsAtCell } from '../diagram/routePaths';
import { useGridEditor } from '../hooks/useGridEditor';
import { useOpenings } from '../hooks/useOpenings';
import { useCompile } from '../hooks/useCompile';
import { useDiagramModel } from '../diagram/diagramModel';
import { useDiagramViewport } from '../hooks/useDiagramViewport';
import { buildLiveDiagramState, Freshness } from '../diagram/liveState';
import { TILE_SIZE } from '../diagram/tilePaths';
import { FAULT, INK, LOCK, OCCUPANCY, ROUTE_LINE, SURFACE, routeStyle } from '../diagram/encoding';
import {
  BlockEdgeRecord,
  BlockRecord,
  LocoRecord,
  PointRecord,
  SensorRecord,
  StateSnapshot,
} from '../types';

interface Props {
  layoutId: string | null;
  blocks: BlockRecord[];
  points: PointRecord[];
  sensors: SensorRecord[];
  locos: LocoRecord[];
  /** The applied graph — what a route's `RoutePathStep.edgeId` refers to (#129). */
  edges: BlockEdgeRecord[];
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
  edges,
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

  /**
   * Built from the roster and the snapshot rather than from the drawing: a
   * point the layout reports on but nobody has drawn yet still belongs in the
   * key, and the diagram is not the authority on which points exist.
   */
  const pointKey = useMemo(() => buildPointKey(points, live.points), [points, live.points]);

  /**
   * The compiled graph, read **once** (#129).
   *
   * `CompiledEdge.via` is the only thing that carries the cells an edge crosses
   * between two blocks — the decorative track a route runs over, which belongs
   * to no block and would otherwise leave the route line broken at every join.
   * `block_edges` does not store them; they are compile output.
   *
   * Once, on the same argument `useOpenings` above takes: the drawing is a
   * config artefact that changes when somebody edits it in the Track Editor,
   * and a monitor is not that somebody. This is the expensive read of the two
   * (a branch search from every opening), so re-running it on a timer would be
   * polling a config surface from a display.
   *
   * If the drawing has moved since, the join simply misses for the changed
   * edges and those routes draw with a gap — never a guessed path. A dedicated
   * backend read cached by fingerprint is the better long-term shape and is
   * deferred; worth doing if this becomes several always-on displays.
   */
  const compile = useCompile(layoutId);
  const compileRefresh = compile.refresh;
  useEffect(() => {
    if (layoutId) void compileRefresh();
  }, [layoutId, compileRefresh]);

  const routeLines = useMemo(
    () =>
      buildRouteLines({
        routes: snapshot.routes,
        blocks: live.blocks,
        grid,
        parsedMeta: model.parsedMeta,
        edges,
        compiledEdges: compile.view.report.edges,
        locos,
        size: TILE_SIZE,
      }),
    [snapshot.routes, live.blocks, grid, model.parsedMeta, edges, compile.view.report.edges, locos],
  );

  const routeSegments = useMemo(() => routeSegmentsAtCell(routeLines), [routeLines]);

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

        {loading && <span style={st.status}>Loading…</span>}
        {loadError && <span style={st.statusErr}>Could not load the drawing: {loadError}</span>}

        <div style={st.legend}>
          <LegendItem glyph={OCCUPANCY.occupied.glyph} label="occupied" />
          <LegendItem glyph={OCCUPANCY.clear.glyph} label="clear" />
          <LegendItem glyph={OCCUPANCY.unknown.glyph} label="unknown" />
          <LegendItem glyph={LOCK.glyph} label="locked by a route" />
        </div>
      </div>

      {/*
        The route key (#129). Only mounted when something is set: an empty
        legend on a quiet layout is a permanent row of chrome saying nothing,
        and the strip above it is already at its width.

        A swatch drawn as the same line the diagram draws — same colour, same
        dash — rather than a coloured square. The dash is the half that
        survives colour being removed (#81), so a swatch that dropped it would
        make the key the one place the encoding is incomplete.
      */}
      {routeLines.length > 0 && (
        <div style={st.strip} role="list" aria-label="Routes">
          <span style={st.caveat}>Routes</span>
          {routeLines.map((line) => {
            const style = routeStyle(line.styleIndex);
            return (
              <span key={line.routeId} style={st.legendItem} role="listitem">
                <svg width={26} height={10} aria-hidden="true">
                  <line
                    x1={0}
                    y1={5}
                    x2={26}
                    y2={5}
                    stroke={style.colour}
                    strokeWidth={5}
                    strokeDasharray={style.dash ?? undefined}
                    opacity={
                      line.status === 'suspended' ? ROUTE_LINE.suspendedOpacity : ROUTE_LINE.opacity
                    }
                  />
                </svg>
                <span>{line.locoName ?? `#${line.locoAddress}`}</span>
                {line.status === 'suspended' && <span style={st.suspended}>suspended</span>}
                {/*
                  A join whose cells could not be resolved — the compiled graph
                  read at mount no longer matches the applied one. Said, not
                  guessed at: the line is drawn with a break, and a break the
                  operator cannot account for is worse than one that explains
                  itself.
                */}
                {line.hasGaps && (
                  <span
                    style={st.gapWarning}
                    title="Part of this route runs over track the compiled graph no longer describes. The line is drawn with a gap rather than guessing the path — re-compile in Configure → Edges."
                  >
                    {FAULT.glyph} incomplete
                  </span>
                )}
              </span>
            );
          })}
        </div>
      )}

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
        /*
          The point key floats **over** the canvas, and the operator drags it
          where the drawing leaves room (`docs/liveness.md` M6, inverted).

          It was a column beside the canvas, on the argument that an overlay
          covers track on the one view whose job is showing all of it. True,
          and a fixed column covers it too — permanently, everywhere, whether
          or not anything is under it. Which corner of a given layout is empty
          is a property of that drawing, so the person looking at it places it.
        */
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
            points={points}
            blocks={blocks}
            sensorNames={sensorNames}
            // Always on. Label density is an authoring trade-off — the editor
            // hides labels to see the track it is painting. A mimic exists to
            // be read, and on it the label is the only thing naming a block,
            // since state has taken the colour channel.
            labelsVisible={() => true}
            live={live}
            routeSegments={routeSegments}
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

          {/*
              Last, so it sits above the degradation wash. That wash is
              `pointerEvents: none` and deliberately covers everything — but a
              panel it covered would be a panel that cannot be dragged out from
              under it, and a stale display is exactly when someone starts
              moving things around to work out what is going on.
            */}
          <PointKeyPanel layoutId={layoutId} rows={pointKey} />
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
  suspended: {
    color: INK.muted,
    fontStyle: 'italic',
  } as React.CSSProperties,
  gapWarning: {
    color: FAULT.colour,
    cursor: 'help',
  } as React.CSSProperties,
  legendGlyph: {
    fontFamily: 'monospace',
    color: INK.primary,
  } as React.CSSProperties,
  /** The canvas takes all the room there is; the point key floats over it. */
  canvasWrap: {
    position: 'relative',
    flex: 1,
    minWidth: 0,
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
