/**
 * The SVG `<pattern>` definitions `diagram/encoding.ts` names.
 *
 * `StateEncoding.pattern` carries a pattern **id**, not a fill — the encoding
 * module is deliberately free of JSX so it stays importable from a plain unit
 * test. This is where those ids become real, and it is why they are defined
 * once rather than per consumer: two surfaces drawing `diag-occupied` at
 * different angles would be two encodings wearing one name.
 *
 * ## Why patterns at all
 *
 * #81's rule: colour is never the sole carrier of meaning. Occupancy's three
 * states are a flat fill (`clear`), a single-direction hatch (`occupied`) and
 * a cross-hatch (`unknown`), which stay distinguishable in greyscale, under
 * every common form of colour vision deficiency, and on the washed-out
 * projector a wall display often turns out to be.
 *
 * `unknown` is the cross-hatch on purpose. It is the fail-safe state — no
 * route may be granted over an `unknown` block and none may resume through one
 * — so it is the *most* visually assertive of the three rather than a neutral
 * middle ground between clear and occupied.
 *
 * ## Alignment: why every hatch is drawn corner to corner
 *
 * `patternUnits="userSpaceOnUse"` resolves against the user space of the
 * element **referencing** the pattern, and every wash rect sits inside its own
 * tile's `<g transform="translate(x*40, y*40)">`. Each tile therefore
 * re-anchors the pattern at its own origin. A pattern whose period divides
 * `TILE_SIZE` in both axes survives that unharmed — the phase comes out
 * identical on every tile and the hatch runs unbroken across a whole block.
 *
 * A **rotated** one does not. `diag-occupied` used to be a vertical line under
 * `patternTransform="rotate(45)"`: shifting 40px along a 45° axis is 28.28,
 * and `28.28 mod 8` left every tile offset by a little over half a stripe. On
 * a multi-tile block that read as a ragged seam at every tile boundary — the
 * hatch looked like it had been drawn per cell, because it had been.
 *
 * So no pattern here carries a `patternTransform`. The 45° angle comes from
 * drawing the line corner to corner inside a square cell, which tiles
 * seamlessly under any translation that is a multiple of `PATTERN_SIZE`. The
 * `unknown` cross-hatch never had the bug because it was always drawn this
 * way; the fix is to draw the other two like that one.
 */

import { OCCUPANCY, POINT_POSITION } from './encoding';

/**
 * Pattern cell size in user units. Small enough that a 40px tile shows several
 * repeats — a hatch that reads as one diagonal line per tile reads as a *mark*
 * rather than as a fill.
 *
 * **It must divide `TILE_SIZE`.** That is the whole alignment argument above,
 * and `patterns.test.ts` asserts it rather than trusting a comment.
 */
export const PATTERN_SIZE = 10;

const P = PATTERN_SIZE;

/**
 * Mount once per `<svg>`, before anything that references a pattern id.
 *
 * `patternUnits="userSpaceOnUse"` rather than the default: object bounding-box
 * units would rescale the hatch to each shape it fills, so a one-tile block
 * and a nine-tile block would carry visibly different textures for the same
 * state. The whole point is that the texture means the state, everywhere.
 */
export function DiagramPatternDefs() {
  return (
    <defs>
      {/* Occupied — single-direction hatch, corner to corner (see the header). */}
      <pattern
        id={OCCUPANCY.occupied.pattern!}
        patternUnits="userSpaceOnUse"
        width={P}
        height={P}
      >
        <line x1={0} y1={P} x2={P} y2={0} stroke={OCCUPANCY.occupied.colour} strokeWidth={2.5} />
      </pattern>

      {/* Unknown — cross-hatch, deliberately the busiest of the three. */}
      <pattern
        id={OCCUPANCY.unknown.pattern!}
        patternUnits="userSpaceOnUse"
        width={P}
        height={P}
      >
        <line x1={0} y1={0} x2={P} y2={P} stroke={OCCUPANCY.unknown.colour} strokeWidth={1.6} />
        <line x1={P} y1={0} x2={0} y2={P} stroke={OCCUPANCY.unknown.colour} strokeWidth={1.6} />
      </pattern>

      {/*
        Reverse road — hatched against the plain fill a normal road gets, and
        leaning the other way from `diag-occupied` so the two never read as the
        same texture. Unreferenced today: the live overlay distinguishes a set
        road by stroke weight rather than by fill. Fixed alongside its siblings
        anyway — a latent pattern that would tile wrongly the day something
        used it is worse than one that is merely unused.
      */}
      <pattern
        id={POINT_POSITION.reverse.pattern!}
        patternUnits="userSpaceOnUse"
        width={P}
        height={P}
      >
        <line x1={0} y1={0} x2={P} y2={P} stroke={POINT_POSITION.reverse.colour} strokeWidth={2} />
      </pattern>
    </defs>
  );
}
