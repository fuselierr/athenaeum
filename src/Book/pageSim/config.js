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

// As a spread's real reference/cover body (A or D) approaches its own
// invisible pseudo double (see spread.js's drop()), the thin cushion of
// trapped air has to squeeze out through a shrinking gap — the closer they
// get, the harder it pushes back. Modeled as a cap on the closing component
// of their relative angular velocity, shrinking in proportion to the
// remaining gap, so the closing rate can never outrun the gap itself: a
// clean exponential ease-out instead of a constant-speed slap shut. Two
// separate cushions, one per spread (A vs its pseudo, D vs its pseudo),
// each applied only within that pair — never between the two inner pages
// (which get a hard stop with no easing — see
// PageSimulation._enforceNoCrossingBC) and never between the two pseudo
// bodies themselves (also a hard stop, no easing — see
// PageSimulation._enforceNoCrossingPseudo).
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

// A tiny constant angular push applied to the two pseudo bodies EVERY
// frame, P1 toward a smaller angle and P2 toward a larger one -- i.e.
// always apart from each other, on top of (and independent of) whatever
// gravity itself is doing to them. Under ordinary gravity this is small
// enough to be invisible, lost in everything else already moving them.
// It matters for one specific case: flip the book over (setFlipped) and
// gravity alone would pull P1 and P2 toward the exact same resting
// angle -- both hinges feel an identical torque with no reason to settle
// on either side of the other, a real (if unstable) tie. That tie is
// exactly BC_FIXED_ANGLE, i.e. the book reading as fully collapsed shut
// rather than splayed open around wherever it was last reading -- this
// nudge is what breaks the tie so it settles open instead. See
// PageSimulation._applyPseudoRepulsion.
export const PSEUDO_REPEL_RATE = 0.12; // rad/s^2

// Restitution for the P1/P2 hard-stop collision (PageSimulation.
// _enforceNoCrossingPseudo) -- 0 = perfectly inelastic (they end up moving
// together, at their shared momentum-conserving velocity, NOT zero -- see
// that method's comment for why zeroing outright was wrong), 1 = perfectly
// elastic (for the equal masses/inertia every page body shares here, that
// means a full velocity swap). This sits between the two: momentum is
// always conserved either way, this only tunes how much of the closing
// energy comes back out as separating velocity afterward versus being
// absorbed, like real paper/card would.
export const PSEUDO_COLLISION_RESTITUTION = 0.4;