/**
 * A throttle for one locomotive, floating over the control plane's canvas (#165).
 *
 * The Operate screen's `ThrottlePanel` is a form: pick a loco, set a speed,
 * press **Set**. That shape is right for a screen whose job is issuing a
 * command, and wrong for driving a train you are watching — by the time the
 * form has been filled in the train is somewhere else, and it can only hold one
 * loco at a time. This is the other shape: one card per loco, several open at
 * once, placed by the operator over the parts of the drawing they do not need.
 *
 * ## The slider commands; nothing is staged
 *
 * There is no **Set** button. Moving the slider sends, throttled to
 * `SEND_INTERVAL_MS` while dragging with the final value always sent on
 * release — a run of intermediate `<t>` commands is what a physical throttle
 * produces too, and swallowing the last one is the failure that matters.
 *
 * ## Three interlocks, and why each is here
 *
 * **A card for a loco under an auto-authority route opens armed, not live.**
 * `LayoutService.handleThrottleCommand` cancels that route and abandons the
 * automation run (`docs/route-locking.md` D6, `docs/automation.md` A12) — which
 * is correct, two authorities on one train being worse than a lost route, but
 * it turns a brushed slider on a wall display into a cancelled run. So the
 * controls are inert behind a **Take control** button that names the route it
 * will cancel. The operator still gets there in one press; what they no longer
 * get is there by accident.
 *
 * **Direction cannot change while the loco is commanded to move.** Stop first.
 * This is a mechanical-sympathy rule rather than a system-safety one — the
 * backend accepts a reversal at speed and a DCC decoder will perform it — but a
 * throttle whose two direction buttons are one mis-tap apart at speed 60 is a
 * bad throttle. `ThrottlePanel`'s form is deliberately left unchanged: it makes
 * you press **Set**, which is the same protection arrived at differently.
 *
 * **No function buttons.** The Operate panel has an F0 light toggle; this does
 * not. `SerialDccAdapter.setFunction` throws rather than writing against
 * PicoDCC (#150, `docs/dcc-link.md` D8), so on the live layout that control is
 * one that always fails. It comes back when the firmware does.
 *
 * ## What it shows versus what it sends
 *
 * The readout is the layout's commanded state from the snapshot, not the
 * slider's position — those differ whenever something else has moved the train
 * (a braking ramp, an automation run, an Emergency Stop), and the card must
 * show the train rather than its own last input. The slider follows the live
 * value except while it is being dragged, which is the one moment the operator
 * outranks it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ClientMessage, Direction, LocoState } from '../types';
import { useFloatingPlacement } from '../hooks/useFloatingPlacement';
import { throttleCardKey } from '../controlThrottles';
import { FAULT, INK } from '../diagram/encoding';

/**
 * The floor on how often a drag sends. Fast enough that the train answers the
 * slider, slow enough that a sweep from 0 to 126 is a handful of commands
 * rather than 126 of them on a serial link that also carries every point.
 */
const SEND_INTERVAL_MS = 120;

export interface ThrottleCardProps {
  layoutId: string | null;
  address: number;
  /** The operator-facing name, or a fallback built from the address (`docs/naming.md` D8). */
  name: string;
  maxSpeed: number;
  /** Live commanded state, or `undefined` for a loco the layout has not spoken to yet. */
  state: LocoState | undefined;
  /** The auto-authority route holding this loco, if any — the armed/live interlock. */
  autoRouteId: string | null;
  /** Connection or system status makes every command pointless — the same rule as Operate. */
  disabled: boolean;
  /** Position in the stack, only used to cascade the default corner. */
  index: number;
  send: (msg: ClientMessage) => void;
  onBrake: (address: number) => Promise<{ ok: boolean; message?: string }>;
  onClose: () => void;
}

export function ThrottleCard({
  layoutId,
  address,
  name,
  maxSpeed,
  state,
  autoRouteId,
  disabled,
  index,
  send,
  onBrake,
  onClose,
}: ThrottleCardProps) {
  const panel = useFloatingPlacement(
    layoutId ? throttleCardKey(layoutId, address) : null,
    // Cascaded down the left edge, clear of the Safe-Stop banner. The point key
    // defaults to the top right, so the two do not open on top of each other.
    { left: 12, top: 40 + index * 26 },
  );

  const [dragging, setDragging] = useState(false);
  const [draggedSpeed, setDraggedSpeed] = useState(0);
  const [brakeError, setBrakeError] = useState('');
  /** Cleared whenever the route goes away, so control is re-armed per run. */
  const [tookControl, setTookControl] = useState(false);

  const lastSentAt = useRef(0);
  const pendingSend = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!autoRouteId) setTookControl(false);
  }, [autoRouteId]);

  useEffect(
    () => () => {
      if (pendingSend.current) clearTimeout(pendingSend.current);
    },
    [],
  );

  const liveSpeed = Math.min(state?.speed ?? 0, maxSpeed);
  const liveDirection: Direction = state?.direction ?? 'stop';
  const sliderSpeed = dragging ? draggedSpeed : liveSpeed;

  /**
   * The direction a new command carries. `'stop'` is a direction on the wire
   * but not a heading, so a stopped loco keeps offering the way it last went
   * — otherwise every stop would silently re-arm the card as forward.
   */
  const [heading, setHeading] = useState<'fwd' | 'rev'>('fwd');
  useEffect(() => {
    if (liveDirection === 'fwd' || liveDirection === 'rev') setHeading(liveDirection);
  }, [liveDirection]);

  const armed = autoRouteId !== null && !tookControl;
  const inert = disabled || armed;

  const dispatch = useCallback(
    (speed: number, direction: Direction) => {
      lastSentAt.current = Date.now();
      send({ type: 'THROTTLE_COMMAND', payload: { locoAddress: address, speed, direction } });
    },
    [address, send],
  );

  /**
   * Trailing throttle. An immediate send when the interval has elapsed, and
   * otherwise a timer holding the *latest* value — never a dropped last frame,
   * which is the one that decides what speed the train ends up at.
   */
  const dispatchThrottled = useCallback(
    (speed: number, direction: Direction) => {
      if (pendingSend.current) clearTimeout(pendingSend.current);
      const since = Date.now() - lastSentAt.current;
      if (since >= SEND_INTERVAL_MS) {
        dispatch(speed, direction);
        return;
      }
      pendingSend.current = setTimeout(() => {
        pendingSend.current = null;
        dispatch(speed, direction);
      }, SEND_INTERVAL_MS - since);
    },
    [dispatch],
  );

  /**
   * Every handler below re-checks `inert` rather than trusting the `disabled`
   * attribute on the control it is wired to.
   *
   * A disabled `<input>` cannot be moved in a browser, so this is belt and
   * braces — but the thing being braced is a command that cancels an
   * automated run, and "the attribute was set" is a presentational guarantee
   * standing in for a behavioural one. Anything that can dispatch an event to
   * a disabled node (a test, a script, an assistive tool with its own idea of
   * the tree) would otherwise drive the train.
   */
  const onSliderChange = (value: number) => {
    if (inert) return;
    setDragging(true);
    setDraggedSpeed(value);
    dispatchThrottled(value, value === 0 ? 'stop' : heading);
  };

  /** Release: the final value goes immediately, ahead of any timer holding an older one. */
  const onSliderRelease = () => {
    if (!dragging) return;
    if (pendingSend.current) {
      clearTimeout(pendingSend.current);
      pendingSend.current = null;
    }
    dispatch(draggedSpeed, draggedSpeed === 0 ? 'stop' : heading);
    setDragging(false);
  };

  const stop = () => {
    if (inert) return;
    if (pendingSend.current) {
      clearTimeout(pendingSend.current);
      pendingSend.current = null;
    }
    setDragging(false);
    setDraggedSpeed(0);
    dispatch(0, 'stop');
  };

  const brake = async () => {
    if (inert) return;
    const result = await onBrake(address);
    setBrakeError(result.ok ? '' : (result.message ?? 'Brake refused'));
  };

  const setDirection = (next: 'fwd' | 'rev') => {
    if (inert || directionLocked) return;
    setHeading(next);
    // At rest by the interlock below, so this re-commands a stationary loco
    // rather than reversing a moving one: it is what tells the decoder (and
    // the readout) which way the next movement goes.
    dispatch(0, next);
  };

  /** The mechanical-sympathy interlock: stop before changing direction. */
  const directionLocked = liveSpeed > 0 || sliderSpeed > 0;

  return (
    <div
      ref={panel.panelRef}
      style={{ ...(panel.placement.open ? st.card : st.cardCollapsed), ...panel.position }}
      aria-label={`Throttle for ${name}`}
    >
      <div style={st.header}>
        <button
          type="button"
          style={st.grip}
          {...panel.gripHandlers}
          title="Drag to move this throttle, or use the arrow keys"
          aria-label={`Move the throttle for ${name}. Use the arrow keys to move it with the keyboard.`}
        >
          ⠿
        </button>
        <button
          type="button"
          onClick={panel.toggle}
          style={st.headerButton}
          aria-expanded={panel.placement.open}
          title={panel.placement.open ? 'Collapse this throttle' : 'Expand this throttle'}
        >
          <span>{panel.placement.open ? '▾' : '▸'}</span>
          <span style={st.name}>{name}</span>
        </button>
        {/*
          Always legible, open or collapsed. A collapsed card that hid the
          speed would be a throttle you cannot read at a glance, which is the
          only reason to collapse one rather than close it.
        */}
        <span style={st.readout} aria-live="off">
          {liveSpeed} {DIRECTION_LABEL[liveDirection]}
        </span>
        <button
          type="button"
          onClick={onClose}
          style={st.close}
          title={`Close the throttle for ${name}`}
          aria-label={`Close the throttle for ${name}`}
        >
          ✕
        </button>
      </div>

      {panel.placement.open && (
        <div style={st.body}>
          {/*
            The armed state (#165). Named, not generic: "cancels route r-7" is
            the fact the operator needs, and a confirm dialog that said
            "are you sure?" would say less while costing the same press.
          */}
          {armed && (
            <div style={st.armed} role="status">
              <div>
                Under automation — <strong>{autoRouteId}</strong>.
              </div>
              <button type="button" onClick={() => setTookControl(true)} style={st.takeControl}>
                Take control (cancels the route)
              </button>
            </div>
          )}

          <label style={st.sliderRow}>
            <span style={st.srOnly}>Speed for {name}</span>
            <input
              type="range"
              min={0}
              max={maxSpeed}
              value={sliderSpeed}
              disabled={inert}
              onChange={(e) => onSliderChange(Number(e.target.value))}
              onPointerUp={onSliderRelease}
              onPointerCancel={onSliderRelease}
              onBlur={onSliderRelease}
              onKeyUp={onSliderRelease}
              style={st.slider}
              aria-label={`Speed for ${name}, 0 to ${maxSpeed}`}
            />
            <span style={st.speedValue}>{sliderSpeed}</span>
          </label>

          <div style={st.row}>
            <div style={st.directions} role="group" aria-label={`Direction for ${name}`}>
              {(['fwd', 'rev'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDirection(d)}
                  disabled={inert || directionLocked}
                  aria-pressed={heading === d}
                  style={{ ...st.dirBtn, ...(heading === d ? st.dirBtnActive : {}) }}
                  title={
                    directionLocked
                      ? 'Stop this loco before changing direction'
                      : d === 'fwd'
                        ? 'Forward'
                        : 'Reverse'
                  }
                >
                  {d === 'fwd' ? '▲ Fwd' : '▼ Rev'}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={stop}
              disabled={inert}
              style={st.stopBtn}
              title="Stop in one step"
            >
              Stop
            </button>
            <button
              type="button"
              onClick={brake}
              disabled={inert}
              style={st.brakeBtn}
              title="Run the standard braking ramp (docs/braking.md B3) rather than stopping in one step"
            >
              Brake
            </button>
          </div>

          {directionLocked && !inert && <p style={st.hint}>Stop before changing direction.</p>}
          {brakeError && <p style={st.error}>{brakeError}</p>}
        </div>
      )}
    </div>
  );
}

const DIRECTION_LABEL: Record<Direction, string> = { fwd: 'fwd', rev: 'rev', stop: 'stopped' };

const st = {
  card: {
    position: 'absolute',
    zIndex: 6,
    width: 232,
    background: '#181825',
    border: '1px solid #45475a',
    borderRadius: 6,
    boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)',
    fontSize: 12,
  } as React.CSSProperties,
  cardCollapsed: {
    position: 'absolute',
    zIndex: 6,
    background: '#181825',
    border: '1px solid #45475a',
    borderRadius: 6,
    boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)',
    fontSize: 12,
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 6px',
  } as React.CSSProperties,
  grip: {
    background: 'none',
    border: 'none',
    color: INK.muted,
    cursor: 'grab',
    fontSize: 13,
    padding: '0 2px',
    touchAction: 'none',
  } as React.CSSProperties,
  headerButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    background: 'none',
    border: 'none',
    color: INK.primary,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    padding: 0,
  } as React.CSSProperties,
  name: {
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  readout: {
    marginLeft: 'auto',
    color: INK.secondary,
    fontFamily: 'monospace',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  close: {
    background: 'none',
    border: 'none',
    color: INK.muted,
    cursor: 'pointer',
    fontSize: 12,
    padding: '0 2px',
  } as React.CSSProperties,
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: '2px 8px 8px',
  } as React.CSSProperties,
  armed: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: 6,
    borderRadius: 4,
    border: `1px solid ${FAULT.colour}`,
    color: INK.primary,
    lineHeight: 1.4,
  } as React.CSSProperties,
  takeControl: {
    background: FAULT.colour,
    color: '#11111b',
    border: 'none',
    borderRadius: 3,
    padding: '3px 8px',
    fontWeight: 700,
    cursor: 'pointer',
    fontSize: 11,
  } as React.CSSProperties,
  sliderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  } as React.CSSProperties,
  slider: {
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  speedValue: {
    width: 26,
    textAlign: 'right',
    fontFamily: 'monospace',
    color: INK.primary,
  } as React.CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  } as React.CSSProperties,
  directions: {
    display: 'flex',
    gap: 2,
  } as React.CSSProperties,
  dirBtn: {
    background: '#313244',
    color: INK.primary,
    border: '1px solid #45475a',
    borderRadius: 3,
    padding: '3px 6px',
    cursor: 'pointer',
    fontSize: 11,
  } as React.CSSProperties,
  dirBtnActive: {
    background: '#89b4fa',
    color: '#1e1e2e',
    fontWeight: 700,
  } as React.CSSProperties,
  stopBtn: {
    marginLeft: 'auto',
    background: '#f38ba8',
    color: '#1e1e2e',
    border: 'none',
    borderRadius: 3,
    padding: '3px 8px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
  } as React.CSSProperties,
  brakeBtn: {
    background: '#fab387',
    color: '#1e1e2e',
    border: 'none',
    borderRadius: 3,
    padding: '3px 8px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
  } as React.CSSProperties,
  hint: {
    margin: 0,
    color: INK.muted,
    fontSize: 11,
  } as React.CSSProperties,
  error: {
    margin: 0,
    color: FAULT.colour,
    fontSize: 11,
  } as React.CSSProperties,
  srOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
} as const;
