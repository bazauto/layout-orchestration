/**
 * Diagram encoding — the one place track-diagram colour and its non-colour
 * counterparts are defined (#81).
 *
 * ## The rule
 *
 * **Colour is never the sole carrier of meaning.** Every state distinction
 * that matters must survive colour being removed. Each encoding below
 * therefore ships a `pattern`, `glyph`, or `label` alongside its `colour`, and
 * consumers are expected to render at least one of them. Colour reinforces a
 * distinction that is already there.
 *
 * Red/green deuteranopia and protanopia together affect roughly 8% of men, and
 * red-green is exactly the pairing a railway mimic reaches for first. A
 * diagram whose whole purpose is being read at a glance, encoding its two most
 * important states in the one pairing a common condition cannot distinguish,
 * is a bad outcome — and invisible to an author who does not have it.
 *
 * ## Two colour systems, deliberately kept apart
 *
 * - **Identity** (which block is this) — `BLOCK_TINTS` below. Used by the
 *   Track Editor, which shows no live state at all.
 * - **State** (occupied, locked, faulted) — `OCCUPANCY`, `POINT_POSITION`,
 *   `FAULT`. Reserved, and never reused for identity.
 *
 * They do not currently share a surface. When the monitor view lands (#63,
 * #75) they will, and the standing rule is that **state wins the colour
 * channel** — block identity falls back to its label. That is a large part of
 * why one-label-per-run (#68) matters beyond tidiness.
 */

import { SensorObservationView } from '../types';

/** The editor/monitor canvas colours the palette below was validated against. */
export const SURFACE = {
  canvas: '#11111b',
  tile: '#1e1e2e',
  gridLine: '#313244',
} as const;

/**
 * Block identity tints, assigned by graph colouring over spatial adjacency
 * (`assignRunTints`), not by a hash of the block id.
 *
 * **Four colours, and that is not an oversight.** A tint palette large enough
 * to give every block its own colour cannot be colour-blind-safe: checked
 * across *all* pairs rather than adjacent ones — which is the honest test,
 * since any two blocks can end up side by side on a drawing — six hues already
 * fail, and eight fail badly (blue↔magenta ΔE 1.7 under deuteranopia). Nor
 * would it help anyone: no one memorises twelve tint→name mappings.
 *
 * So tint does not identify a block. It marks **where one block ends and the
 * next begins**, which needs only enough colours that no two adjacent blocks
 * share one — a graph-colouring problem, where four is famously plenty for a
 * near-planar layout. The block's *name* identifies it, which is what #68's
 * one-label-per-run draws.
 *
 * Validated with the dataviz skill's `validate_palette.js` against the
 * `#1e1e2e` tile surface, all pairs, dark mode:
 *
 * ```
 *   [PASS] Lightness band         all 4 inside L 0.48-0.67
 *   [PASS] Chroma floor           all 4 >= 0.1
 *   [WARN] CVD separation         worst all-pairs #c770c1<->#00959c dE 6.8 (deutan) - tritan 8.7
 *   [PASS] Normal-vision floor    worst all-pairs #00959c<->#3868c6 dE 15.9 (normal)
 *   [PASS] Contrast vs surface    all 4 >= 3:1
 *   -> ALL CHECKS PASS
 * ```
 *
 * The one WARN is a CVD pair in the 6–8 band, which is legal **only** with
 * secondary encoding — direct labels, gaps, or texture. All three are present:
 * every run is labelled, runs are spatially separated, and the tint is drawn
 * as a low-opacity wash under a track drawing that is itself unaffected. Do
 * not add a fifth tint without re-running the validator; it will not pass.
 */
export const BLOCK_TINTS = ['#3868c6', '#a06e00', '#00959c', '#c770c1'] as const;

export type BlockTint = (typeof BLOCK_TINTS)[number];

/** Opacity the tint is washed over a tile at. Low enough to leave the track legible. */
export const BLOCK_TINT_OPACITY = 0.26;

/**
 * A state encoding: a colour plus at least one thing that is not a colour.
 *
 * `pattern` names an SVG `<pattern>` id defined by `DiagramPatternDefs`;
 * `null` means a plain fill, which is itself a distinction as long as
 * something else in the set is patterned.
 */
export interface StateEncoding {
  colour: string;
  /** SVG pattern id, or null for a flat fill. */
  pattern: string | null;
  /** A short symbol usable where there is no room for text. */
  glyph: string;
  /** The word. Always available; used wherever space allows. */
  label: string;
}

/**
 * Block occupancy.
 *
 * `unknown` is a fail-safe state that refuses routes, so it is the **most**
 * visually distinct of the three rather than a neutral middle ground: a
 * cross-hatch, which reads as obviously different from both a flat fill and a
 * single-direction hatch even in greyscale.
 *
 * Occupancy is carried as a **fill**; a lock is carried as an **outline**
 * (`LOCK` below). They are independent — a block can be locked and clear, or
 * occupied and unlocked — so they must compose rather than compete for the
 * same channel.
 */
export const OCCUPANCY: Record<'occupied' | 'clear' | 'unknown', StateEncoding> = {
  occupied: {
    colour: '#f38ba8',
    pattern: 'diag-occupied',
    glyph: '■', // ■
    label: 'occupied',
  },
  clear: {
    colour: '#a6e3a1',
    pattern: null,
    glyph: '□', // □
    label: 'clear',
  },
  unknown: {
    colour: '#f9e2af',
    pattern: 'cross-unknown',
    glyph: '?',
    label: 'unknown',
  },
};

/**
 * A route lock.
 *
 * `glyph`/`label` are the whole of it on a block now. The dashed **outline
 * around the run** this used to carry is gone: a route is drawn as a coloured
 * line along the track it holds (`ROUTE_TINTS` below, #129), which is the same
 * one-mark-per-fact posture from the opposite direction — the outline said
 * "held" and could not say "held by which", and two concurrent routes were two
 * identical yellow outlines.
 *
 * `strokeDasharray`/`strokeWidth` remain because the glyph is not the only
 * consumer: a lock on a *point* is a glyph at its label tile, and anything
 * later wanting to outline a held thing should use these rather than invent
 * its own.
 */
export const LOCK = {
  colour: '#f9e2af',
  strokeDasharray: '4 2',
  strokeWidth: 2,
  glyph: '\u{1F512}', // 🔒
  label: 'locked',
} as const;

/**
 * Route identity (#129) — which route holds this road.
 *
 * **These are `BLOCK_TINTS`, reused deliberately.** Where live state is drawn
 * the identity wash is not (D1), so on the monitor those four validated hues
 * are free. They are already checked for CVD separation against the tile
 * surface across all pairs, which is the expensive part of picking a
 * categorical palette, and a second set would have to be validated against
 * both this one and the state colours.
 *
 * They cannot be confused with block identity in practice, because the two
 * never appear on the same surface: the editor draws tints and no routes, the
 * monitor draws routes and no tints.
 *
 * **Colour is not the carrier.** Route identity in hue alone is exactly what
 * #81 forbids, so a route also gets a dash pattern, and the two cycle on
 * different periods — four hues by four dashes is sixteen distinguishable
 * combinations. Past that the key in the status strip is the answer, which it
 * is anyway: nobody identifies a route by colour alone, they use the colour to
 * find the row.
 */
export const ROUTE_TINTS = BLOCK_TINTS;

/** Dash patterns, cycling on a different period from the hues. `null` is solid. */
export const ROUTE_DASHES: readonly (string | null)[] = [null, '10 5', '2 4', '12 4 2 4'];

/** How wide the halo runs, and how far under the track it sits. */
export const ROUTE_LINE = {
  strokeWidth: 9,
  opacity: 0.75,
  /** A suspended route still holds its locks, but is not the road being run. */
  suspendedOpacity: 0.32,
} as const;

/** The colour and dash for a route's ordinal among those currently drawn. */
export function routeStyle(styleIndex: number): { colour: string; dash: string | null } {
  return {
    colour: ROUTE_TINTS[styleIndex % ROUTE_TINTS.length],
    dash: ROUTE_DASHES[Math.floor(styleIndex / ROUTE_TINTS.length) % ROUTE_DASHES.length],
  };
}

/**
 * Point position.
 *
 * A set road drawn solid and an unset road dimmed is already a non-colour
 * encoding, which is why it is the right presentation — keep it that way.
 * `unknown` gets the cross-hatch treatment for the same reason as occupancy.
 *
 * Commanded-versus-confirmed was deliberately not invented here before #25:
 * until then every position on a diagram was commanded, and a distinction
 * drawn before there was anything to distinguish would have been a lie.
 * `POINT_CONFIRMATION` below is that third treatment, now that #25 gives it
 * something real to distinguish.
 */
export const POINT_POSITION: Record<'normal' | 'reverse' | 'unknown', StateEncoding> = {
  normal: { colour: '#89b4fa', pattern: null, glyph: '─', label: 'normal' },
  reverse: { colour: '#cba6f7', pattern: 'diag-reverse', glyph: '╱', label: 'reverse' },
  unknown: { colour: '#f9e2af', pattern: 'cross-unknown', glyph: '?', label: 'unknown' },
};

/**
 * Point position **confirmation** (#25, docs/point-feedback.md D3/D4/D7) — a
 * distinct state from `POINT_POSITION` above and never a substitute for it.
 * `POINT_POSITION` says what a road is; this says how much the position it
 * is drawn from can be trusted, and is what a point badge's colour/glyph are
 * keyed on rather than on the raw position (`LayoutPanel`, `PointKeyPanel`).
 *
 * Six members, six glyphs — `mismatch`, `indeterminate` and `timed-out` all
 * sit in "known bad" territory and must stay visibly distinct from one
 * another without relying on their (deliberately similar) fault colour, per
 * #81's rule that colour is never the sole carrier. `unreported` and
 * `pending` are both "no verdict yet" but for different reasons (never
 * commanded this session, vs. a deadline actively running) and get their own
 * glyphs for the same reason.
 */
export const POINT_CONFIRMATION: Record<
  'unreported' | 'pending' | 'confirmed' | 'mismatch' | 'indeterminate' | 'timed-out',
  StateEncoding
> = {
  unreported: { colour: '#6c7086', pattern: null, glyph: '–', label: 'unreported' },
  pending: { colour: '#89b4fa', pattern: null, glyph: '…', label: 'pending' },
  confirmed: { colour: '#a6e3a1', pattern: null, glyph: '✓', label: 'confirmed' },
  mismatch: { colour: '#f38ba8', pattern: 'diag-occupied', glyph: '✗', label: 'mismatch' },
  indeterminate: { colour: '#f9e2af', pattern: 'cross-unknown', glyph: '?', label: 'indeterminate' },
  'timed-out': { colour: '#f38ba8', pattern: 'cross-unknown', glyph: '⏱', label: 'timed-out' },
};

/**
 * Faults (`sensorFaults`, `routeFaults`, `brakingFaults`). Never red alone —
 * always accompanied by the glyph, and by text wherever there is room.
 */
export const FAULT = {
  colour: '#f38ba8',
  glyph: '⚠', // ⚠
  label: 'fault',
} as const;

/*
 * `OPENING` used to live here — the boundary tick, the `⊣` stop glyph and the
 * label that #103 step 6.1 drew for a compiled opening. All three are gone
 * (`docs/track-editor.md` D15, `docs/diagram-encoding.md` D7, withdrawn), and
 * so is the encoding: an unused entry in this module is an invitation to draw
 * something the diagram deliberately does not draw.
 *
 * Openings are still named in the keyboard readout, the Edges tab and the
 * compile diff. None of those is a track diagram, and none needs an encoding.
 */

/** Ink. Text never wears a state or identity colour — a mark beside it carries that. */
export const INK = {
  primary: '#cdd6f4',
  secondary: '#a6adc8',
  muted: '#6c7086',
} as const;

/**
 * Live sensor observation (#76). The annotation glyph #74 already draws a
 * circle-and-line mark for every placed sensor — this is what drives its
 * appearance from what the sensor currently reports, rather than the static
 * ink colour it wore before.
 *
 * **Deliberately its own channel, never the block tint (D-c).**
 * `deriveBlockOccupancy` clause 3 is precisely where a beam and its block
 * legitimately disagree — an IR `clear` is a no-op, so a block can sit at
 * `unknown` while the beam plainly reads `clear`. `docs/diagram-encoding.md`
 * D1–D6 forbids a fifth block tint, so the beam is drawn subordinate to
 * derived occupancy by construction: it gets a small mark of its own, never a
 * share of `OCCUPANCY`'s fill.
 *
 * Four states, the minimum #76 asked for: `occupied` and `clear` are the
 * sensor's own reading; `not-evidence` is untrusted, faulted OR
 * out-of-service COLLAPSED TO ONE TREATMENT (D-d) — a dead sensor and a
 * clear beam must read identically "do not trust this", never as though one
 * were silent and the other spoke; `no-reading` is a registered sensor that
 * has never reported at all. Colour is never the only distinction:
 * `filled`/`dash` on the small circle-and-line mark are the non-colour
 * carrier `TrackDiagram` draws, and `glyph`/`label` serve the legend and the
 * tooltip.
 */
export type SensorGlyphState = 'occupied' | 'clear' | 'not-evidence' | 'no-reading';

/** A tiny mark's own encoding — deliberately not `StateEncoding`: this is drawn as a 7px circle-and-line, not an area fill, so it needs a fill/outline treatment rather than an SVG `<pattern>` id that would not read at that scale. */
export interface SensorObservationEncoding {
  colour: string;
  /** Whether the mark's circle is solid-filled (a positive assertion) or hollow. */
  filled: boolean;
  /** SVG `stroke-dasharray`, or null for a solid outline — the non-colour carrier at this scale. */
  dash: string | null;
  glyph: string;
  label: string;
}

export const SENSOR_OBSERVATION: Record<SensorGlyphState, SensorObservationEncoding> = {
  occupied: { colour: OCCUPANCY.occupied.colour, filled: true, dash: null, glyph: '●', label: 'occupied' },
  clear: { colour: OCCUPANCY.clear.colour, filled: false, dash: null, glyph: '○', label: 'clear' },
  'not-evidence': {
    colour: INK.muted,
    filled: false,
    dash: '1.5 1',
    glyph: '⊘',
    label: 'not evidence',
  },
  'no-reading': { colour: INK.muted, filled: false, dash: '0.5 1.5', glyph: '·', label: 'no reading' },
};

/**
 * Derives which of the four states above a wire observation renders as.
 * Pure, and deliberately does not import from the backend — mirrors
 * `isContributingSensor`'s ordering (`domain/occupancy.ts`) without being
 * that predicate: this asks what the SENSOR itself is showing, not whether
 * it currently contributes to a block's derived occupancy, so `type` never
 * enters it.
 *
 * Order matters: `faulted`/out-of-service is checked before `lastReading`,
 * because both null the reading server-side (DD6) — without this ordering a
 * faulted sensor would read as merely `no-reading` and lose the "not
 * evidence" treatment D-d requires.
 */
export function sensorGlyphStateOf(observation: SensorObservationView): SensorGlyphState {
  if (observation.faulted || !observation.inService) return 'not-evidence';
  if (observation.lastReading === null) return 'no-reading';
  if (!observation.trusted) return 'not-evidence';
  return observation.lastReading === 'occupied' ? 'occupied' : 'clear';
}
