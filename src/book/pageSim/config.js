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

// Anchor spacing, both within a spread and between the two spreads --
// effectively HALF the book's thickness, since cover A sits at +SPINE_GAP
// and cover D at -SPINE_GAP. Half of the original study value (0.7).
//
// `let`, for the same reason HINGE_LEN/PANEL_REACH are: a loaded book
// resizes it (setSpineGap below, driven by spineGapForPageCount) so a
// short PDF renders as a thin book and a long one as a fat one. Same
// caveat as above -- the anchors are baked into physics bodies at
// construction, so a change only takes effect on the next
// PageSimulation.create(). PageSimulation.BC_RANGE reads it live, so the
// inner leaf's travel range rescales with the book automatically.
export let SPINE_GAP = 0.3;

// The value SPINE_GAP starts at, and the thickness a book of
// SPINE_GAP_REFERENCE_PAGES pages gets. Kept separate from the mutable
// SPINE_GAP above ON PURPOSE: spineGapForPageCount() must scale from a
// FIXED base, or loading a second book would scale from the first book's
// already-scaled thickness and compound every time.
const SPINE_GAP_DEFAULT = 0.3;

// Page count that maps to exactly SPINE_GAP_DEFAULT, and the range the
// result is held inside -- a leaflet still needs enough thickness for the
// curl/wedge geometry to read as a book at all, and a 900-page doorstop
// shouldn't grow until it dwarfs the desk.
const SPINE_GAP_REFERENCE_PAGES = 650;
const SPINE_GAP_MIN = 0.06;
const SPINE_GAP_MAX = 0.55;

/**
 * How thick a book of `pageCount` pages should be. Square root rather
 * than linear: thickness IS linear in sheet count for real paper, but
 * across the range books actually span (a 10-page pamphlet to a
 * 1000-page reference) a linear map spends almost its whole output range
 * on the extremes and leaves everything in between pinned to a clamp.
 * Square root keeps the mid-range -- where most books land -- visibly
 * distinct, and still orders every book correctly by length.
 */
export function spineGapForPageCount(pageCount) {
  if (!Number.isFinite(pageCount) || pageCount < 1) return SPINE_GAP_DEFAULT;
  const scaled = SPINE_GAP_DEFAULT * Math.sqrt(pageCount / SPINE_GAP_REFERENCE_PAGES);
  return Math.max(SPINE_GAP_MIN, Math.min(SPINE_GAP_MAX, scaled));
}

/** See spineGapForPageCount -- callers pass its result here. */
export function setSpineGap(gap) {
  SPINE_GAP = gap;
}

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

/**
 * Tilt of the whole spine, as a signed fraction: -1 .. 0 .. +1.
 *
 * Think of the spine as a segment between two hinge endpoints, s1 at the
 * -X end and s2 at the +X end, HINGE_LEN apart:
 *
 *   t = -1   s2 stays on the ground, s1 swings up directly ABOVE it
 *   t =  0   both endpoints on the ground, HINGE_LEN apart -- flat, the
 *            book's default pose
 *   t = +1   s1 stays on the ground, s2 swings up directly ABOVE it
 *
 * Whichever endpoint is lower is the pivot and stays pinned; the other
 * swings around it, so the segment never stretches. Converted to an angle
 * by spineBeta() below.
 *
 * This moves hinge POSITIONS only. It is a deformation of the book, not a
 * rotation of it: page angles, the revolute joints' axis and gravity are
 * all left completely alone, because the tilt turns about X and that is
 * already the axis every one of them is defined around. See math.js's
 * spineHinge(), which is the single place it is applied.
 *
 * `let`, like the other layout values here: it is meant to be driven at
 * runtime, and unlike HINGE_LEN/PANEL_REACH/SPINE_GAP it needs NO rebuild
 * to take effect -- the next step() picks it up. Nothing is baked in.
 */
export let SPINE_ROTATION = 0;

/** See SPINE_ROTATION. Clamped to the -1..1 the geometry is defined over. */
export function setSpineRotation(t) {
  SPINE_ROTATION = Math.max(-1, Math.min(1, t));
}

/** SPINE_ROTATION as radians: -90deg at -1, 0 at 0, +90deg at +1. */
export function spineBeta() {
  return SPINE_ROTATION * (Math.PI / 2);
}

// How fast SPINE_ROTATION chases the tilt the page block is asking for
// (PageSimulation.spineRotationTarget). A rate, not a step, so the spine
// leans into a new reading position over a few frames the way a real book
// settles rather than snapping the instant a leaf lands. Same exponential
// form as bookContent's BC_EASE_RATE, and deliberately slower than it: the
// hinge slides first, the spine follows.
export const SPINE_ROTATION_EASE_RATE = 4.5; // 1/s

// --- the weight of the page block on its own spine -------------------------
// A thick book holds its spine flat. The block is heavy, it sits square on
// the joint, and a leaf that would lever the spine over has to lift every
// leaf under it first. A pamphlet has none of that and follows its pages
// freely. So thickness does two things: it pulls the spine back to flat
// harder, and it makes flat somewhere the book STAYS rather than a value it
// passes through.
//
// The measure is the book's own thickness -- SPINE_GAP, already derived
// from the page count by spineGapForPageCount -- normalised over the range
// that function spans, so 0 is the thinnest book the reader will ever build
// and 1 the fattest.
export function spineWeight() {
  const t = (SPINE_GAP - SPINE_GAP_MIN) / (SPINE_GAP_MAX - SPINE_GAP_MIN);
  return Math.max(0, Math.min(1, t));
}

// How much of the pages' demand a full-weight book simply absorbs. Under
// this much, the spine does not move at all; over it, only the surplus gets
// through -- rescaled, so a book asking for everything still reaches full
// tilt however heavy it is. This is the term that makes a thick book SIT at
// flat instead of drifting off it every time a leaf lands.
const SPINE_WEIGHT_DEADZONE = 0.45; // at weight 1

// Ease-rate multipliers at full weight. Falling back toward flat is the
// block's own weight doing the work, so it happens faster; being levered
// away from flat is work against that weight, so it happens slower.
const SPINE_WEIGHT_FLATTEN_GAIN = 1.6;
const SPINE_WEIGHT_RESIST = 1.2;

/**
 * The tilt a book of this thickness will actually chase, given the raw
 * demand from the page block. See SPINE_WEIGHT_DEADZONE.
 *
 * Continuous and monotonic in `target`: the spine does not jump when the
 * demand crosses the deadzone, it just starts moving.
 */
export function weighSpineTarget(target) {
  const dead = SPINE_WEIGHT_DEADZONE * spineWeight();
  const surplus = Math.abs(target) - dead;
  if (surplus <= 0) return 0;
  return Math.sign(target) * Math.min(1, surplus / (1 - dead));
}

/**
 * The rate the spine chases `target` at, from where it currently is.
 * Scales SPINE_ROTATION_EASE_RATE by the block's weight, asymmetrically --
 * which is the whole point: a heavy book returns to flat quickly and leaves
 * it reluctantly, and a thin one behaves as it always did.
 */
export function spineEaseRate(target, current) {
  const weight = spineWeight();
  const towardFlat = Math.abs(target) <= Math.abs(current);
  return SPINE_ROTATION_EASE_RATE * (towardFlat
    ? 1 + weight * SPINE_WEIGHT_FLATTEN_GAIN
    : 1 / (1 + weight * SPINE_WEIGHT_RESIST));
}


export const GRAVITY_MAG = 9.81;

// How far a cover may swing from closed. Both spreads open the same
// amount — no built-in asymmetry between front and back.
//
// PAST FLAT ON PURPOSE. Math.PI is the cover lying flat in line with the
// spine; beyond that the binding hyper-extends, the way a paperback folded
// back on itself or a hardback pressed open past its hinge does. Anything
// reading this as "the fully open pose" wants Math.PI, not this -- see
// COVER_START_NEAR/FAR below, which deliberately do not follow it.
export const OPEN_LIMIT = Math.PI * 1;

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
export const HARDCOVER_AIR_CUSHION_RANGE = 0.1; // hardcover gap where cushioning starts

// The two inner pages start near "hanging straight down" (pi/2, where a
// page's own Z reach is zero), a few degrees apart — close together but not
// touching. Splaying them toward their spread's open extreme the way the
// covers start would send them deep into each other's territory at t = 0,
// since each page is much longer than the gap between anchors.
export const BC_MEET_ANGLE = Math.PI / 2;
export const BC_START_GAP = 0.15; // radians between the two inner pages at t = 0

/**
 * B's and C's own hinge-tangent angle, held fixed for the entire lifetime
 * of the book -- see PageSimulation._enforceNoCrossingBC. Only their curl
 * SHAPE (driven by each spread's invisible pseudo body -- see spread.js's
 * drop() -- via straightAngle()) ever changes; the tangent right at the
 * shared hinge never does.
 *
 * "Fixed" means fixed RELATIVE TO THE SPINE, which is why this tracks
 * spineBeta() rather than being a bare constant. The tangent is meant to
 * leave the hinge square to the spine, and the reason is geometric, not
 * cosmetic: the curl arc's centre sits perpendicular to this tangent, one
 * hinge-separation away (curlGeometry.js's buildCurlStrip), so square-to-
 * the-spine is exactly the condition that puts that centre ON the
 * reference page's hinge -- A's for the front spread, D's for the back.
 * Leave it at a flat pi/2 while the spine tilts and the centre keeps the
 * old y while A and D move, so the curl detaches from the cover it is
 * supposed to be wrapping toward.
 *
 * Derivation, for anyone checking: the spine runs along
 * (0, -sin(beta), cos(beta)), a page at angle `a` reaches along
 * (0, -sin(a), cos(a)), and their dot product is cos(a - beta) -- zero
 * exactly when a = beta +- pi/2. Hence BC_MEET_ANGLE + beta.
 *
 * A function, not a `let`: there is no state to keep in sync, and every
 * caller reads it fresh, so a live SPINE_ROTATION needs no rebuild.
 */
export function bcFixedAngle() {
  return BC_MEET_ANGLE + spineBeta();
}

// Where the outer cover pages splay to at t = 0, as fractions of FLAT
// (Math.PI) -- NOT of OPEN_LIMIT, which now runs past flat. The reset pose
// is "lying open on the desk", which is pi; anchoring these to OPEN_LIMIT
// would have the book reset already hyper-extended every time that limit
// was raised. Anchored here they stay put, and the values are within a
// couple of degrees of what they have always been.
export const COVER_START_NEAR = Math.PI * 0.05;
export const COVER_START_FAR = Math.PI * 0.95;

// A tiny constant angular push applied to the two pseudo bodies EVERY
// frame, P1 toward a smaller angle and P2 toward a larger one -- i.e.
// always apart from each other, on top of (and independent of) whatever
// gravity itself is doing to them. Under ordinary gravity this is small
// enough to be invisible, lost in everything else already moving them.
// It matters for one specific case: flip the book over (setFlipped) and
// gravity alone would pull P1 and P2 toward the exact same resting
// angle -- both hinges feel an identical torque with no reason to settle
// on either side of the other, a real (if unstable) tie. That tie is
// exactly bcFixedAngle(), i.e. the book reading as fully collapsed shut
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
export const PSEUDO_COLLISION_RESTITUTION = 0.7;