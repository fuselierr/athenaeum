import * as THREE from 'three';
import { loadGLTF } from '../models.js';

/**
 * The carpet under the sofa and the coffee table: an Iranian rug, a single
 * textured quad from carpet_iranian.glb.
 *
 * LAID FLAT, AT A REAL SIZE. The model is a picture of a rug standing in its
 * own units -- a hundred of them long, upright in its file. So it is measured
 * rather than trusted: whichever way it is thinnest is turned to face up,
 * its long side is turned to run along the sofa (the room's Z), and it is
 * scaled so that side is RUG_LENGTH. Nothing about the file's own size or
 * orientation survives into the room.
 *
 * It lies a couple of millimetres off the floorboards -- flush, the two
 * surfaces would fight over the same pixels -- and takes shadows without
 * casting any: nothing is under a rug to be shaded by it.
 */

const RUG_URL = '/carpet_iranian.glb';
const RUG_LENGTH = 3.2; // metres, the long side
const LIFT = 0.003; // metres off the floor

/**
 * @param {THREE.Scene} scene
 * @returns {Promise<{ object: THREE.Group, size: THREE.Vector3,
 *   place(opts: { x: number, y: number, z: number }): void, dispose(): void }>}
 */
export async function loadRug(scene) {
  const gltf = await loadGLTF(RUG_URL);

  // Everything into one space, the file's node transforms baked in.
  gltf.scene.updateMatrixWorld(true);
  const meshes = [];
  gltf.scene.traverse((child) => { if (child.isMesh) meshes.push(child); });
  const geometries = meshes.map((mesh) => mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));

  const box = new THREE.Box3();
  for (const geometry of geometries) {
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox);
  }
  const size = box.getSize(new THREE.Vector3());

  // Face up: turn its thinnest direction to Y.
  const turn = new THREE.Matrix4();
  if (size.z <= size.x && size.z <= size.y) turn.makeRotationX(-Math.PI / 2);
  else if (size.x <= size.y && size.x <= size.z) turn.makeRotationZ(Math.PI / 2);
  for (const geometry of geometries) geometry.applyMatrix4(turn);
  // The patterned side up, not the back: if the normals now point down, over.
  const normal = geometries[0].getAttribute('normal');
  if (normal && normal.getY(0) < 0) {
    for (const geometry of geometries) geometry.rotateX(Math.PI);
  }

  // Long side along Z, the sofa's length.
  box.makeEmpty();
  for (const geometry of geometries) {
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox);
  }
  box.getSize(size);
  if (size.x > size.z) {
    for (const geometry of geometries) geometry.rotateY(Math.PI / 2);
  }

  // To length, centred on the origin, lying on it.
  box.makeEmpty();
  for (const geometry of geometries) {
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox);
  }
  box.getSize(size);
  const scale = RUG_LENGTH / Math.max(size.z, 1e-6);
  const middle = box.getCenter(new THREE.Vector3());
  for (const geometry of geometries) {
    geometry.translate(-middle.x, -box.min.y, -middle.z);
    geometry.scale(scale, scale, scale);
  }
  size.multiplyScalar(scale);

  const object = new THREE.Group();
  object.name = 'rug';
  meshes.forEach((mesh, i) => {
    const rug = new THREE.Mesh(geometries[i], mesh.material);
    rug.receiveShadow = true;
    rug.castShadow = false;
    // Seen almost edge-on from anywhere you stand, which is where an unfiltered
    // pattern turns to shimmer.
    for (const map of [rug.material.map, rug.material.normalMap, rug.material.roughnessMap]) {
      if (map) map.anisotropy = 8;
    }
    object.add(rug);
  });
  scene.add(object);

  return {
    object,
    /** Its size on the floor, metres: x across, z along its length. */
    size,

    /** Lay it with its middle at (x, z) on a floor at `y`. */
    place({ x, y, z }) {
      object.position.set(x, y + LIFT, z);
      object.updateMatrixWorld(true);
    },

    dispose() {
      scene.remove(object);
      object.traverse((child) => {
        if (!child.isMesh) return;
        child.geometry.dispose();
        for (const map of [child.material.map, child.material.normalMap, child.material.roughnessMap]) map?.dispose();
        child.material.dispose();
      });
    },
  };
}
