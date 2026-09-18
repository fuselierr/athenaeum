import * as THREE from 'three';

/**
 * Directions across the ground, and the camera's way of saying which way one
 * faces.
 *
 * Everything that is placed facing somewhere -- the bench, the tree, the egg
 * chair, the sofa's seats -- works in the same two terms: a direction flat on
 * the ground, and the camera's yaw for looking along it (cameraModes.sitOn
 * takes one). Here once, so they all mean the same thing by them.
 */

// Straight ahead for the camera at yaw 0.
const AHEAD = new THREE.Vector3(0, 0, -1);

/**
 * Which way a direction faces, as a camera yaw: 0 looking along -Z.
 *
 * @param {{ x: number, z: number }} direction
 * @returns {number} radians
 */
export const heading = (direction) => Math.atan2(-direction.x, -direction.z);

/**
 * A direction laid flat on the ground and made unit length -- its height
 * dropped. One that was straight up or down, or nothing at all, has no way
 * across the ground to keep, and becomes `fallback`.
 *
 * @param {{ x: number, z: number }} direction
 * @param {THREE.Vector3} [out]
 * @param {THREE.Vector3} [fallback]  straight ahead for the camera, by default
 * @returns {THREE.Vector3} `out`
 */
export function flatDirection(direction, out = new THREE.Vector3(), fallback = AHEAD) {
  out.set(direction.x, 0, direction.z);
  if (out.lengthSq() < 1e-8) out.copy(fallback);
  return out.normalize();
}

/**
 * The direction a quarter turn to the right of a flat one, across the ground.
 *
 * @param {{ x: number, z: number }} direction  flat
 * @param {THREE.Vector3} [out]
 * @returns {THREE.Vector3} `out`
 */
export function sideways(direction, out = new THREE.Vector3()) {
  return out.set(-direction.z, 0, direction.x);
}
