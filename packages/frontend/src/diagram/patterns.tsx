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
 */

import { OCCUPANCY, POINT_POSITION } from './encoding';

/**
 * Pattern tile size in user units. Small enough that a 40px cell shows several
 * repeats — a hatch that reads as one diagonal line per tile reads as a *mark*
 * rather than as a fill.
 */
const P = 8;

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
      {/* Occupied — single-direction hatch. */}
      <pattern
        id={OCCUPANCY.occupied.pattern!}
        patternUnits="userSpaceOnUse"
        width={P}
        height={P}
        patternTransform="rotate(45)"
      >
        <line x1={0} y1={0} x2={0} y2={P} stroke={OCCUPANCY.occupied.colour} strokeWidth={2.5} />
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

      {/* Reverse road — hatched against the plain fill a normal road gets. */}
      <pattern
        id={POINT_POSITION.reverse.pattern!}
        patternUnits="userSpaceOnUse"
        width={P}
        height={P}
        patternTransform="rotate(-45)"
      >
        <line x1={0} y1={0} x2={0} y2={P} stroke={POINT_POSITION.reverse.colour} strokeWidth={2} />
      </pattern>
    </defs>
  );
}
