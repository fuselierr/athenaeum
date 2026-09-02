/**
 * Shared layout / physics constants for the page simulation.
 *
 * The whole mechanism is two independent "spreads" (a spread = two
 * independently-hinged pages + a curved wedge filling the gap between them)
 * chained along the spine. Hinge axis is world X for every page on every
 * spread; every anchor sits at y = 0 so the book is level. Pages are chained
 * along Z.
 */

// `let`, not `const` -- setPageDimensions() below can resize the book to
// match a loaded PDF's actual page aspect ratio (see bookLoader.js's
// onDimensions and main.js's applyPdfDimensions). Every other module
// imports these as live ES module bindings and either reads them fresh
// inside a function body each time (spread.js) or holds a stable object
// whose contents setPageDimensions/updateLocalCorners (math.js) mutate in
// place -- so nothing here needs to change for that to work, EXCEPT that
// anything which bakes these into physics bodies or BufferGeometry sizes
// at construction time (panelGeo, colliders) only picks up a change on the
// NEXT PageSimulation.create(), not live -- main.js handles that by
// disposing and recreating the whole simulation when dimensions change.
export let HINGE_LEN = 2.0;
export let PANEL_REACH = 1.4;

// Anchor spacing, both within a spread and between the two spreads. Half of
// the original study value (0.7).
export const SPINE_GAP = 0.35;

// Physics-only half-thickness, just for a sane inertia tensor.
export const COLLIDER_THICK = 0.02;

export let PIVOT_TO_NEAR_EDGE = PANEL_REACH / 2;

/**
 * Resize the book to a new HINGE_LEN (spine length, i.e. a page's height)
 * / PANEL_REACH (spine-to-edge reach, i.e. a page's width). Only updates
 * these plain values (and the PIVOT_TO_NEAR_EDGE derived from them) --
 * callers also need math.js's updateLocalCorners() (for the wedge-loft
 * corner vectors, which are precomputed objects, not read fresh each
 * frame) and to recreate PageSimulation (for panelGeo/collider sizes,
 * which are baked in at construction time).
 */
export function setPageDimensions(hingeLen, panelReach) {
  HINGE_LEN = hingeLen;
  PANEL_REACH = panelReach;
  PIVOT_TO_NEAR_EDGE = PANEL_REACH / 2;
}

export const GRAVITY_MAG = 9.81;

// Both spreads open the same amount — no built-in asymmetry between front
// and back.
export const OPEN_LIMIT = Math.PI * 0.98;

// All page colliders share one collision group that excludes itself, so no
// two pages ever generate contacts with each other — collisions aren't what
// keeps pages apart; the exact no-crossing corrections do, and they can't
// tunnel the way thin-collider contact can.
// Membership group 1, filter excludes group 1.
export const NO_SELF_COLLIDE = (1 << 16) | 0xfffe;

// As two pages of the same spread approach each other, the thin cushion of
// trapped air has to squeeze out through a shrinking gap — the closer they
// get, the harder it pushes back. Modeled as a cap on the closing component
// of their relative angular velocity, shrinking in proportion to the
// remaining gap, so the closing rate can never outrun the gap itself: a
// clean exponential ease-out instead of a constant-speed slap shut. Applied
// only within a spread's own pair, never between the two inner pages (which
// get a hard stop with no easing — see PageSimulation._enforceNoCrossingBC).
export const AIR_CUSHION_RANGE = 0.9; // radians of gap where squeezed air starts pushing back
export const AIR_CUSHION_MAX_RATE = 2.2; // closing rate (rad/s) allowed at the edge of that range

// The two inner pages start near "hanging straight down" (pi/2, where a
// page's own Z reach is zero), a few degrees apart — close together but not
// touching. Splaying them toward their spread's open extreme the way the
// covers start would send them deep into each other's territory at t = 0,
// since each page is much longer than the gap between anchors.
export const BC_MEET_ANGLE = Math.PI / 2;
export const BC_START_GAP = 0.15; // radians between the two inner pages at t = 0

// B's and C's own hinge-tangent angle, held fixed for the entire lifetime
// of the book -- see PageSimulation._enforceNoCrossingBC. Only their curl
// SHAPE (driven by each spread's invisible pseudo body -- see spread.js's
// drop() -- via straightAngle()) ever changes; the tangent right at the
// shared hinge never does.
export const BC_FIXED_ANGLE = BC_MEET_ANGLE;

// Fractions of OPEN_LIMIT the outer cover pages splay to at t = 0.
export const COVER_START_NEAR = OPEN_LIMIT * 0.05;
export const COVER_START_FAR = OPEN_LIMIT * 0.95;