import * as THREE from 'three';
import { HINGE_LEN, PIVOT_TO_NEAR_EDGE, SPINE_GAP, spineBeta } from './config.js';

/**
 * Distance between the spine's two long edges -- i.e. the book's actual
 * thickness, since cover A's hinge sits at +SPINE_GAP and cover D's at
 * -SPINE_GAP. This is what spineTilt() rocks the book about, so the pivot
 * lands ON a spine edge and the book rolls onto its own side rather than
 * swinging about some line out under a page. Read live, so a re-sized book
 * (setSpineGap) keeps pivoting on its own edge.
 */
function spineTiltSpan() {
  return 2 * SPINE_GAP;
}

/**
 * Small shared math helpers for the page simulation. Every page rotates
 * purely about world X, so a lot of this collapses to sin/atan2 of a single
 * angle.
 *
 * That "purely about world X" holds even with SPINE_ROTATION engaged,
 * because tilting the spine is a RIGID rotation of the entire book rather
 * than a per-hinge deformation -- see spineTilt() below. The simulation
 * therefore runs, in full, in the flat frame these helpers assume.
 */

// Read-only shared hinge axis. `applyAxisAngle` / `addScaledVector` never
// mutate their axis argument, so sharing one instance is safe.
export const AXIS_X = new THREE.Vector3(1, 0, 0);

export function clampNum(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** Quaternion for a rotation of `angle` about world X. */
export function xRotation(angle) {
  return { x: Math.sin(angle / 2), y: 0, z: 0, w: Math.cos(angle / 2) };
}

/** Current swing angle of a rigid body that only ever rotates about X. */
export function pageAngle(body) {
  const r = body.rotation();
  return 2 * Math.atan2(r.x, r.w);
}

/**
 * World transform of a page hinged at `anchor` and swung to `angle`.
 *
 * Rotation is pure X, so the page's own x stays 0; only its offset from the
 * hinge rotates. Shared by spawn logic and every no-crossing correction so
 * they all agree on where a page sits at a given angle.
 *
 * The hinge itself is wherever SPINE_ROTATION has put it (spineHinge), NOT
 * the flat (0, anchor.y, anchor.z) -- that is the whole of what tilting the
 * spine does to a page. Note what it does NOT do: `angle`, and therefore
 * `rot`, is untouched. A page's swing is measured about X, the tilt rotates
 * about X, and a rotation cannot move its own axis -- so hinge angles stay
 * completely independent of spine rotation, and pageAngle() keeps reading
 * them correctly with no adjustment at all.
 *
 * `anchor.y` is layered on top of the hinge's own y rather than replacing
 * it, so an anchor deliberately offset off the spine keeps that offset.
 */
const _dir = new THREE.Vector3();
export function pageTransform(anchor, angle) {
  const dir = _dir.set(0, 0, PIVOT_TO_NEAR_EDGE).applyAxisAngle(AXIS_X, angle);
  const mid = spineHinge(anchor.z).mid;
  return {
    pos: { x: 0, y: mid.y + anchor.y + dir.y, z: mid.z + dir.z },
    rot: xRotation(angle),
  };
}

/**
 * Where the hinge at stack position `z` sits once SPINE_ROTATION has
 * tilted the spine. THE one place the tilt is defined; everything that
 * places anything -- anchor bodies, page bodies, the pseudo bodies, the
 * hardcover boards -- goes through here (mostly via pageTransform) so
 * there is no second opinion about where the spine is.
 *
 * The spine has two long edges, s1 at the -Z end of the stack and s2 at
 * the +Z end, spineTiltSpan() apart. Tilting lifts one straight up over
 * the other, in the Z/Y plane:
 *
 *   t = -1   s2 stays down, s1 lifts directly above it
 *   t =  0   both edges level, spineTiltSpan() apart -- the flat default
 *   t = +1   s1 stays down, s2 lifts directly above it
 *
 * Whichever edge is lower is the pivot and stays pinned, so the spine
 * never stretches. Every hinge in the book -- both covers' and both inner
 * leaves' -- rides that same line at its own z, so they all move together
 * and stay correctly spaced.
 *
 * WHAT THIS DOES NOT TOUCH, by construction: the rotation is about X, and
 * every hinge line in the book already runs along X. A rotation cannot
 * move its own axis, so `axis` stays (1, 0, 0) forever. That is what keeps
 * page angles independent of spine rotation -- pageAngle() still reads a
 * pure-X swing, the revolute joints never need their axis rebuilt, and
 * gravity never needs recomputing, because none of them can tell the
 * difference. Only POSITIONS move.
 *
 * At beta = 0 mid lands on (0, 0, z), so leaving SPINE_ROTATION at 0 is
 * bit-for-bit the untilted book.
 *
 * @param {number} z  the hinge's position along the spine stack
 */
export function spineHinge(z) {
  const beta = spineBeta();
  const cos = Math.cos(beta);
  const sin = Math.sin(beta);
  const half = HINGE_LEN / 2;

  // The spine edge that stays down; the other one swings up around it.
  // Rotating about a line off the origin is a rotation about X followed by
  // `pivot - R*pivot`, which is what the pivotZ terms below are.
  //
  // NOTE THE SIGN ON y. This is physics space, where DOWN IS +Y -- the
  // book's render root carries a permanent rotation.x = PI (see
  // PageSimulation), which is also why gravity here reads (0, +9.81, 0).
  // So lifting an edge means driving its y NEGATIVE; using +y would tilt
  // the spine correctly and render it sinking into the desk.
  const pivotZ = beta > 0 ? -spineTiltSpan() / 2 : spineTiltSpan() / 2;
  const reach = z - pivotZ; // distance from the pinned edge, along the flat spine
  const mid = {
    x: 0,
    y: -reach * sin,
    z: reach * cos + pivotZ,
  };

  return {
    beta,
    mid,
    // The hinge line's two ends, along X. Unrotated: see above.
    s1: { x: -half, y: mid.y, z: mid.z },
    s2: { x: half, y: mid.y, z: mid.z },
    axis: { x: 1, y: 0, z: 0 },
  };
}

// Local-space corners of a flat page relative to its own mesh origin —
// used to loft the wedge onto the flat reference page's straight edge.
//
// Pre-allocated, mutable, shared instances (not recreated) -- spread.js
// holds onto these same objects and reads their CURRENT contents each
// frame via .copy(), so updateLocalCorners() below can resize the book
// (see config.js's setPageDimensions) just by mutating them in place;
// nothing needs to re-import or reassign anything.
export const LOCAL_PIVOT_L = new THREE.Vector3();
export const LOCAL_PIVOT_R = new THREE.Vector3();
export const LOCAL_TIP_L = new THREE.Vector3();
export const LOCAL_TIP_R = new THREE.Vector3();

export function updateLocalCorners() {
  LOCAL_PIVOT_L.set(-HINGE_LEN / 2, 0, -PIVOT_TO_NEAR_EDGE);
  LOCAL_PIVOT_R.set(HINGE_LEN / 2, 0, -PIVOT_TO_NEAR_EDGE);
  LOCAL_TIP_L.set(-HINGE_LEN / 2, 0, PIVOT_TO_NEAR_EDGE);
  LOCAL_TIP_R.set(HINGE_LEN / 2, 0, PIVOT_TO_NEAR_EDGE);
}
updateLocalCorners(); // initialize with config.js's starting HINGE_LEN/PIVOT_TO_NEAR_EDGE