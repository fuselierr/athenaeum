import * as THREE from 'three';
import { HINGE_LEN, PIVOT_TO_NEAR_EDGE } from './config.js';

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