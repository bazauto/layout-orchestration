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
 * A route lock, carried as an outline so it composes with the occupancy fill.
 * Not a `StateEncoding`: a lock is a boolean, and its absence needs no mark.
 */
export const LOCK = {
  colour: '#f9e2af',
  strokeDasharray: '4 2',
  strokeWidth: 2,
  glyph: '\u{1F512}', // 🔒
  label: 'locked',
} as const;

/**
 * Point position.
 *
 * A set road drawn solid and an unset road dimmed is already a non-colour
 * encoding, which is why it is the right presentation — keep it that way.
 * `unknown` gets the cross-hatch treatment for the same reason as occupancy.
 *
 * Commanded-versus-confirmed (#25, #63) will need a *third* non-colour
 * treatment when a feedback channel exists. It is deliberately not invented
 * here: until #25 lands every position on a diagram is commanded, and a
 * distinction drawn before there is anything to distinguish would be a lie.
 */
export const POINT_POSITION: Record<'normal' | 'reverse' | 'unknown', StateEncoding> = {
  normal: { colour: '#89b4fa', pattern: null, glyph: '─', label: 'normal' },
  reverse: { colour: '#cba6f7', pattern: 'diag-reverse', glyph: '╱', label: 'reverse' },
  unknown: { colour: '#f9e2af', pattern: 'cross-unknown', glyph: '?', label: 'unknown' },
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
