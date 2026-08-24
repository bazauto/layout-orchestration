/**
 * ControlView (#63, #75, #82, #165) — the live mimic, and the screen the
 * layout is driven from.
 *
 * The same railway the Track Editor draws, with what the layout is doing now
 * laid over it. It still has no palette and no paint handlers: it renders
 * `TrackDiagram` with a `live` prop and a set of no-op *drawing* handlers,
 * which is the whole reason #75 extracted that component rather than letting a
 * second renderer of the same railway grow here.
 *
 * ## Why this stopped being read-only (#165)
 *
 * Through #129 this was `MonitorView`, and "no write path" was stated here as
 * a virtue. What that cost, once the layout was actually being operated, was
 * that every act — a speed change, a point — meant leaving the picture of the
 * railway to go and find a form on another tab, and coming back to a train
 * that had moved. A mimic you cannot act on makes the operator the transport
 * between two screens.
 *
 * So the controls came to the mimic, and they came as **overlays the operator
 * places**, not as chrome: throttle cards (`ThrottleCard`) and the point key's
 * per-row `Normal`/`Reverse` buttons. The canvas keeps its whole width for
 * anyone who wants the display and nothing else.
 *
 * Three things did *not* change, and are the reason this is still one view
 * rather than two:
 *
 * - **The drawing is still authored in the Track Editor.** Nothing here writes
 *   a tile, an edge or a name. `grid_tiles` remains the editor's, and the
 *   compiler remains the only writer of `block_edges`.
 * - **Every control is an overlay.** Track is never a button — see the
 *   rejected alternative in `docs/liveness.md` M10.
 * - **The `monitor` role sees none of them.** `canControl` gates the
 *   affordance; `DRIVING_MESSAGE_TYPES` in the WebSocket transport is what
 *   actually refuses the command (#63 D2/D3).
 *
 * The *role* is still called `monitor` — a person who may only watch — while
 * the *view* is the control plane. Those are different things and both names
 * are right.
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
 * **A point position here is `effectivePosition` (#25, D7), not the raw
 * commanded field.** A `'required'` point draws only a confirmed reading; a
 * `'none'` point falls back to what was commanded, same as before #25. The
 * caveat that this is not the same as a verified physical position is stated
 * once, persistently, in the status strip rather than repeated on each point
 * where it would become noise — the per-point confirmation detail
 * (pending/mismatch/timed-out) lives in the point key instead, which has room
 * to say it in words.
 *
 * **A stale diagram must not look like a quiet layout.** That is the whole of
 * #82: a frozen socket leaves every block showing its last known occupancy
 * and nothing on screen saying so. When `freshness` is anything but `live`
 * the canvas is covered, not badged — see `docs/liveness.md` M5.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  FAULT,
  INK,
  LOCK,
  OCCUPANCY,
  ROUTE_LINE,
  SENSOR_OBSERVATION,
  SURFACE,
  routeStyle,
} from '../diagram/encoding';
import { ThrottleCard } from './ThrottleCard';
import {
  addThrottle,
  autoRouteHoldingLoco,
  loadOpenThrottles,
  MAX_THROTTLE_CARDS,
  removeThrottle,
  saveOpenThrottles,
} from '../controlThrottles';
import { CommandRefusal } from '../hooks/useLayoutSocket';
import {
  BlockEdgeRecord,
  BlockRecord,
  ClientMessage,
  LocoRecord,
  PointRecord,
  Role,
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
  /** #165: `monitor` gets the mimic and none of the controls. */
  role: Role;
  /** The same rule Operate uses: not connected, or the system is offline. */
  disabled: boolean;
  send: (msg: ClientMessage) => void;
  onBrake: (locoAddress: number) => Promise<{ ok: boolean; message?: string }>;
  /** The last command the backend refused, and the way to clear it (#165). */
  lastError: CommandRefusal | null;
  dismissError: () => void;
}

/**
 * A no-op mouse/keyboard handler set for the *drawing* gestures. #165 added
 * controls to this view but none of them are on the canvas: track is never a
 * button here (`docs/liveness.md` M10).
 */
const noop = () => {};

export function ControlView({
  layoutId,
  blocks,
  points,
  sensors,
  locos,
  edges,
  snapshot,
  freshness,
  role,
  disabled,
  send,
  onBrake,
  lastError,
  dismissError,
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

  /**
   * #76: off by default. This is a diagnostic layer — the prompting case was
   * diagnosing a flaky beam, not a thing every dispatcher needs staring back
   * at them — and it stays that way for the same reason `docs/diagram-encoding.md`
   * gives the beam its own channel rather than the block tint (D-c): raw
   * sensor evidence and derived block occupancy can legitimately disagree,
   * and defaulting the layer on would make that disagreement the first thing
   * a new operator sees rather than something they reach for on purpose.
   */
  const [showSensors, setShowSensors] = useState(false);

  const live = useMemo(
    () => buildLiveDiagramState(snapshot, locos, freshness, showSensors),
    [snapshot, locos, freshness, showSensors],
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

  /**
   * #165. Affordance only — the WebSocket transport refuses a driving message
   * from a `monitor` connection whatever this says (#63 D2/D3), and a control
   * hidden here is still a control that cannot be reached by a stale tab or a
   * `curl`.
   */
  const canControl = role !== 'monitor';

  /**
   * Which locos have a throttle card open. Per layout, persisted, and re-read
   * when the layout changes — an operator's desk is a preference, not session
   * state, and rebuilding it after every reload is exactly the friction this
   * issue exists to remove.
   */
  const [openThrottles, setOpenThrottles] = useState<number[]>(() => loadOpenThrottles(layoutId));
  useEffect(() => {
    setOpenThrottles(loadOpenThrottles(layoutId));
  }, [layoutId]);

  const updateThrottles = useCallback(
    (next: number[]) => {
      setOpenThrottles(next);
      saveOpenThrottles(layoutId, next);
    },
    [layoutId],
  );

  const locoRecords = useMemo(() => new Map(locos.map((l) => [l.address, l])), [locos]);

  /**
   * Every loco the operator could open a card for: the roster, plus any the
   * layout is reporting on that has no record. `docs/naming.md` D8 again — a
   * train that is moving and cannot be selected is worse than an ugly label.
   */
  const throttleChoices = useMemo(() => {
    const addresses = new Set<number>([
      ...locos.map((l) => l.address),
      ...Object.keys(snapshot.locos).map(Number),
    ]);
    return [...addresses]
      .filter((a) => Number.isFinite(a) && !openThrottles.includes(a))
      .sort((a, b) => a - b);
  }, [locos, snapshot.locos, openThrottles]);

  const setPoint = useCallback(
    (pointId: string, position: 'normal' | 'reverse') => {
      send({ type: 'POINT_COMMAND', payload: { pointId, position } });
    },
    [send],
  );

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

        <span
          style={st.caveat}
          title="A point's trusted position depends on how it is configured — see the point key (#25)"
        >
          Point positions shown are <strong>trusted</strong>, per point — see the key
        </span>

        {/*
          #76: off by default (see the state's own comment) — a diagnostic
          layer an operator reaches for, not one that competes with derived
          occupancy for attention on every load.
        */}
        <label
          style={st.caveat}
          title="Raw sensor readings, subordinate to derived block occupancy above — the two can legitimately disagree (docs/diagram-encoding.md D-c)"
        >
          <input
            type="checkbox"
            checked={showSensors}
            onChange={(e) => setShowSensors(e.target.checked)}
          />{' '}
          Sensors
        </label>

        {/*
          #165: adding a throttle is one interaction, not a picker plus an
          "Add" button — the list only ever offers locos that do not already
          have a card, so choosing one has exactly one meaning. It resets to
          its own label immediately, because it is a command rather than a
          field with a value.
        */}
        {canControl && (
          <label style={st.caveat}>
            <span style={st.srOnly}>Add a throttle</span>
            <select
              value=""
              onChange={(e) => {
                const address = Number(e.target.value);
                if (Number.isFinite(address) && address > 0) {
                  updateThrottles(addThrottle(openThrottles, address));
                }
              }}
              disabled={throttleChoices.length === 0 || openThrottles.length >= MAX_THROTTLE_CARDS}
              style={st.select}
              title={
                openThrottles.length >= MAX_THROTTLE_CARDS
                  ? `At most ${MAX_THROTTLE_CARDS} throttles at once — close one first`
                  : 'Open a throttle for a loco'
              }
            >
              <option value="">+ Throttle</option>
              {throttleChoices.map((address) => (
                <option key={address} value={address}>
                  {locoRecords.get(address)?.name ?? `Loco ${address}`}
                </option>
              ))}
            </select>
          </label>
        )}

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
        A refused command, said out loud (#165).

        The backend answers a rejected `ClientMessage` with an `ERROR` frame,
        and until this existed the reply reached `console.warn` and nobody. On
        a form that is survivable; on a control plane it is the difference
        between "the point is held by route r-7" and a button that appears to
        do nothing. Dismissible and never self-clearing: a refusal that faded
        after three seconds would be missed by exactly the operator who was
        watching the train rather than the screen.

        `role="alert"` rather than `status`: this is the consequence of
        something the operator just did, and it is announced.
      */}
      {lastError && (
        <div style={st.refusal} role="alert">
          <span style={st.glyph}>{FAULT.glyph}</span>
          <span style={st.refusalText}>{lastError.message}</span>
          <button type="button" onClick={dismissError} style={st.dismiss} title="Dismiss">
            ✕
          </button>
        </div>
      )}

      {/*
        The sensor key (#76). Only mounted with the layer, on the same
        "no permanent chrome for an absent feature" argument the route key
        below gives for itself.
      */}
      {showSensors && (
        <div style={st.strip} role="list" aria-label="Sensors">
          <span style={st.caveat}>Sensors — raw readings, not derived occupancy</span>
          <LegendItem
            glyph={SENSOR_OBSERVATION.occupied.glyph}
            label={SENSOR_OBSERVATION.occupied.label}
          />
          <LegendItem
            glyph={SENSOR_OBSERVATION.clear.glyph}
            label={SENSOR_OBSERVATION.clear.label}
          />
          <LegendItem
            glyph={SENSOR_OBSERVATION['not-evidence'].glyph}
            label={SENSOR_OBSERVATION['not-evidence'].label}
          />
          <LegendItem
            glyph={SENSOR_OBSERVATION['no-reading'].glyph}
            label={SENSOR_OBSERVATION['no-reading'].label}
          />
        </div>
      )}

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
            accessibleName="Live track diagram. Read-only: this view shows block occupancy, route locks and point positions (commanded, or confirmed where a point is configured to report), and has no controls."
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
          <PointKeyPanel
            layoutId={layoutId}
            rows={pointKey}
            canControl={canControl}
            disabled={disabled}
            onSetPoint={setPoint}
          />

          {/*
            The throttle cards (#165), last of all and above the point key.

            Above, because a throttle is the control most likely to be reached
            for in a hurry, and a card half-hidden under the key is one the
            operator has to move something to use. Both are placed by hand, so
            an operator who wants the other order can simply put them
            side by side.

            Rendered only for a role that may drive — not disabled, absent. A
            greyed-out throttle poses a question whose honest answer is
            "you may not" (#61's argument, and the same reason a `monitor` has
            no Operate tab rather than an empty one).
          */}
          {canControl &&
            openThrottles.map((address, index) => {
              const record = locoRecords.get(address);
              return (
                <ThrottleCard
                  key={address}
                  layoutId={layoutId}
                  address={address}
                  // `docs/naming.md` D8: a missing record degrades to the
                  // identifier, never to nothing.
                  name={record?.name ?? `Loco ${address}`}
                  maxSpeed={record?.maxSpeed ?? 126}
                  state={snapshot.locos[address]}
                  autoRouteId={autoRouteHoldingLoco(snapshot.routes, address)}
                  disabled={disabled}
                  index={index}
                  send={send}
                  onBrake={onBrake}
                  onClose={() => updateThrottles(removeThrottle(openThrottles, address))}
                />
              );
            })}
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
  glyph: {
    fontFamily: 'monospace',
  } as React.CSSProperties,
  select: {
    background: '#313244',
    color: INK.primary,
    border: '1px solid #45475a',
    borderRadius: 4,
    padding: '2px 6px',
    font: 'inherit',
    fontSize: 12,
  } as React.CSSProperties,
  srOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  refusal: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    background: '#181825',
    border: `1px solid ${FAULT.colour}`,
    borderRadius: 4,
    color: FAULT.colour,
    fontSize: 12,
  } as React.CSSProperties,
  refusalText: {
    flex: 1,
    minWidth: 0,
    color: INK.primary,
  } as React.CSSProperties,
  dismiss: {
    background: 'transparent',
    border: 'none',
    color: INK.muted,
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 12,
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
