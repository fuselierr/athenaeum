import * as THREE from 'three';

/**
 * The patch of floor the furniture stands on.
 *
 * Deliberately finite rather than an infinite ground plane: the scene is a
 * lit vignette against an environment map, not a room, and a floor running
 * out to the horizon would catch the lamp's falloff and read as a huge dark
 * disc behind the desk. Sized from what actually has to stand on it.
 *
 * Receives shadows but does not cast: nothing is under it.
 */

const FLOOR_COLOR = 0x3a2f28;

/**
 * @param {THREE.Object3D} scene
 * @param {THREE.Box3} contents  world-space bounds of everything that must
 *   stand on the floor. Its min.y sets the floor height, so the furniture's
 *   feet land exactly on it.
 * @param {number} margin  metres of floor visible past `contents`.
 * @param {THREE.Material|null} [material]  what it is made of -- the
 *   floorboards (scene/inside/surfaces.js). Its textures should tile by the
 *   metre: this floor's UVs are laid out in metres. Without one, a plain
 *   `color`.
 */
export function addFloor(scene, contents, { margin = 0.4, color = FLOOR_COLOR, material = null } = {}) {
  const size = contents.getSize(new THREE.Vector3());
  const center = contents.getCenter(new THREE.Vector3());

  const width = size.x + margin * 2;
  const depth = size.z + margin * 2;
  const geometry = new THREE.PlaneGeometry(width, depth);
  // PlaneGeometry is built in XY facing +Z; this lays it flat, facing up.
  geometry.rotateX(-Math.PI / 2);
  // UVs in metres rather than 0..1 across the whole floor, matching the walls
  // (whose ShapeGeometry lays its UVs out in the shape's own units) -- so a
  // texture tiles at the same real size however big the room is.
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * width, uv.getY(i) * depth);

  const floor = new THREE.Mesh(
    geometry,
    material ?? new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 }),
  );
  floor.name = 'floor';
  floor.position.set(center.x, contents.min.y, center.z);
  floor.receiveShadow = true;
  floor.castShadow = false;
  scene.add(floor);

  return floor;
}
