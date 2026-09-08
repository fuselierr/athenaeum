import * as THREE from 'three';
import { HINGE_LEN, PIVOT_TO_NEAR_EDGE, spineBeta } from './config.js';

/**
 * Small shared math helpers for the page simulation. Every page rotates
 * purely about world X, so a lot of this collapses to sin/atan2 of a single
 * angle.
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
 * Rotation is pure X, so the page's own x stays 0; only its offset from the
 * anchor's (y, z) rotates. Shared by spawn logic and every no-crossing
 * correction so they all agree on where a page sits at a given angle.
 */
const _dir = new THREE.Vector3();
export function pageTransform(anchor, angle) {
  const dir = _dir.set(0, 0, PIVOT_TO_NEAR_EDGE).applyAxisAngle(AXIS_X, angle);
  return {
    pos: { x: 0, y: anchor.y + dir.y, z: anchor.z + dir.z },
    rot: xRotation(angle),
  };
}

/**
 * Where a single hinge line sits once the spine is tilted by
 * SPINE_ROTATION. Every hinge in the book -- both covers' and both inner
 * leaves' -- is the same segment at a different z, so they all go through
 * here and all tilt together.
 *
 * At rest the segment runs along X from (-HINGE_LEN/2, 0, z) to
 * (+HINGE_LEN/2, 0, z). Tilting pins whichever endpoint is LOWER and
 * swings the other up around it, so the segment stays exactly HINGE_LEN
 * long at every angle rather than stretching:
 *
 *   beta <= 0   s2 (+X end) is the pivot, s1 rises to -HINGE_LEN*sin(beta)
 *   beta >  0   s1 (-X end) is the pivot, s2 rises to  HINGE_LEN*sin(beta)
 *
 * At beta = 0 this collapses to exactly the untilted layout -- mid lands
 * on (0, 0, z) and axis on (1, 0, 0) -- which is why leaving
 * SPINE_ROTATION at 0 changes nothing.
 *
 * `mid` is the point to hang a revolute joint's anchor body on (the page's
 * own hinge-edge midpoint maps there), and `axis` is that joint's rotation
 * axis. HINGE_LEN is read live, so a resized book re-tilts correctly.
 *
 * @param {number} z  the hinge's position along the spine stack
 */
export function spineHinge(z) {
  const beta = spineBeta();
  const len = HINGE_LEN;
  const cos = Math.cos(beta);
  const sin = Math.sin(beta);

  let s1;
  let s2;
  if (beta <= 0) {
    // s2 pinned at its flat home; s1 swings up around it.
    s2 = { x: len / 2, y: 0, z };
    s1 = { x: s2.x - len * cos, y: len * -sin, z };
  } else {
    // s1 pinned at its flat home; s2 swings up around it.
    s1 = { x: -len / 2, y: 0, z };
    s2 = { x: s1.x + len * cos, y: len * sin, z };
  }

  return {
    beta,
    s1,
    s2,
    mid: { x: (s1.x + s2.x) / 2, y: (s1.y + s2.y) / 2, z },
    // s2 - s1 normalised. Works out to (cos, sin, 0) on either branch.
    axis: { x: cos, y: sin, z: 0 },
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