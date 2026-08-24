/**
 * A panel the operator places over the canvas, and that stays where it was put
 * (#165, extracted from `PointKeyPanel` — `docs/liveness.md` M6).
 *
 * The point key established the posture: a layout always has empty canvas
 * somewhere, which corner is empty is a property of the drawing, and the person
 * looking at it is the one who knows. #165 puts throttle cards on the same
 * canvas under the same rule, and one panel's worth of drag/clamp/persist logic
 * copied per card is how the two would drift apart.
 *
 * What this owns:
 *
 * - **Position and open state, persisted per key.** Both, together, in one
 *   entry — a panel that remembered where it was but not whether it was open is
 *   half a preference.
 * - **The clamp.** A panel dragged off the edge of an unattended display cannot
 *   be dragged back, because there is nothing left to grab. Applied on every
 *   move rather than on release, so it stops at the edge instead of appearing
 *   to leave and then jumping back.
 * - **Arrow-key nudging.** Dragging is the gesture, but a panel that can *only*
 *   be dragged is one a keyboard user cannot move at all — and the position is
 *   the whole feature.
 *
 * Storage is tolerant of anything it finds and silent on failure, the same
 * posture `useDiagramViewport` takes: a corrupt entry or a disabled
 * localStorage must never stop the control plane rendering, which is the one
 * view that has to come up unattended.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Where a panel sits, in pixels from the canvas's top-left, and whether it is open. */
export interface Placement {
  open: boolean;
  /** `null` until it has been placed: the default corner is left to CSS. */
  at: { x: number; y: number } | null;
}

export const DEFAULT_PLACEMENT: Placement = { open: true, at: null };

/** How far one arrow-key press moves a panel. */
export const NUDGE = 12;

/**
 * Parses whatever is under the key into a `Placement`, or returns the default.
 *
 * Exported for the tests, which are the only place the shapes this has to
 * survive — a truncated write, a hand-edited entry, the bare `'open'` string an
 * earlier version of the point key wrote — can be asserted directly.
 */
export function parsePlacement(raw: string | null): Placement {
  if (raw === null) return DEFAULT_PLACEMENT;
  // The bare 'open'/'closed' the point key stored before it could be placed.
  // Not compatibility for its own sake: the alternative is an operator whose
  // panel silently re-opens once, which is a small thing to pay a branch for.
  if (raw === 'open' || raw === 'closed') return { open: raw === 'open', at: null };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PLACEMENT;
    const { open, at } = parsed as { open?: unknown; at?: unknown };
    const point =
      typeof at === 'object' &&
      at !== null &&
      Number.isFinite((at as { x?: unknown }).x) &&
      Number.isFinite((at as { y?: unknown }).y)
        ? { x: (at as { x: number }).x, y: (at as { y: number }).y }
        : null;
    return { open: open !== false, at: point };
  } catch {
    return DEFAULT_PLACEMENT;
  }
}

function load(storageKey: string | null): Placement {
  if (!storageKey) return DEFAULT_PLACEMENT;
  try {
    return parsePlacement(window.localStorage.getItem(storageKey));
  } catch {
    return DEFAULT_PLACEMENT;
  }
}

function save(storageKey: string | null, placement: Placement): void {
  if (!storageKey) return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(placement));
  } catch {
    /* a convenience, not worth surfacing */
  }
}

export interface FloatingPlacement {
  placement: Placement;
  /** Attach to the panel's outermost element — the clamp measures it. */
  panelRef: React.RefObject<HTMLDivElement>;
  /** `left`/`top` once placed; otherwise the caller's default corner. */
  position: React.CSSProperties;
  toggle: () => void;
  /**
   * Spread onto the grip control. A separate grip rather than a draggable
   * header: the header is a button, and a drag that also toggles — or a toggle
   * suppressed by a movement threshold — is the kind of gesture that works for
   * whoever tuned the threshold and for nobody else.
   */
  gripHandlers: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  };
}

export function useFloatingPlacement(
  storageKey: string | null,
  /**
   * Where the panel sits before it has ever been placed, as CSS. A corner
   * inset rather than an (x, y), so a caller can default one panel to the top
   * right and cascade a stack of others from the left without this hook
   * needing to know the canvas size.
   */
  defaultPosition: React.CSSProperties,
): FloatingPlacement {
  const [placement, setPlacement] = useState<Placement>(() => load(storageKey));
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  // Re-read when the key changes rather than carrying one panel's state across
  // layouts — the preference is per layout, so switching must adopt the new one
  // instead of writing the old one over it.
  useEffect(() => {
    setPlacement(load(storageKey));
  }, [storageKey]);

  const update = useCallback(
    (next: Placement) => {
      setPlacement(next);
      save(storageKey, next);
    },
    [storageKey],
  );

  const toggle = useCallback(() => {
    setPlacement((was) => {
      const next = { ...was, open: !was.open };
      save(storageKey, next);
      return next;
    });
  }, [storageKey]);

  const clamp = useCallback((x: number, y: number) => {
    const panel = panelRef.current;
    const parent = panel?.offsetParent as HTMLElement | null;
    if (!panel || !parent) return { x, y };
    const maxX = Math.max(0, parent.clientWidth - panel.offsetWidth);
    const maxY = Math.max(0, parent.clientHeight - panel.offsetHeight);
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    const panel = panelRef.current;
    const parent = panel?.offsetParent as HTMLElement | null;
    if (!panel || !parent) return;
    const box = panel.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const parent = panelRef.current?.offsetParent as HTMLElement | null;
    if (!drag || !parent) return;
    const box = parent.getBoundingClientRect();
    setPlacement((was) => ({
      ...was,
      at: clamp(e.clientX - box.left - drag.dx, e.clientY - box.top - drag.dy),
    }));
  };

  const onPointerUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    save(storageKey, placement);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-NUDGE, 0],
      ArrowRight: [NUDGE, 0],
      ArrowUp: [0, -NUDGE],
      ArrowDown: [0, NUDGE],
    };
    const delta = deltas[e.key];
    if (!delta) return;
    e.preventDefault();

    const panel = panelRef.current;
    const parent = panel?.offsetParent as HTMLElement | null;
    // Before the first drag there is no stored position, so the nudge starts
    // from where the panel is actually drawn rather than from (0, 0).
    const from =
      placement.at ??
      (panel && parent ? { x: panel.offsetLeft, y: panel.offsetTop } : { x: 0, y: 0 });
    update({ ...placement, at: clamp(from.x + delta[0], from.y + delta[1]) });
  };

  return {
    placement,
    panelRef,
    position: placement.at ? { left: placement.at.x, top: placement.at.y } : defaultPosition,
    toggle,
    gripHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onKeyDown,
    },
  };
}
