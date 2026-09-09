import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FURNITURE_SCALE } from './worldScale.js';

/**
 * Loads the desk the book sits on (public/desk.glb) and scales/positions it
 * to match the book's own coordinate system.
 *
 * The book's pages are hinged at y = 0 in PageSimulation's local space (see
 * config.js's anchorNear/anchorFar) and, under gravity, hang DOWN from
 * there in physics space -- but PageSimulation.root carries a permanent
 * render-only rotation.x = PI (see its constructor) that flips everything
 * so it renders fanned UPWARD instead. Net effect: in the scene the book
 * never renders below world y = 0 -- that's the spine/hinge line, the
 * lowest point of the whole assembly. So "the book sits on the desk" just
 * means the desk's own top surface needs to land exactly at world y = 0;
 * nothing about the book itself needs to move.
 *
 * The model is loaded at its AUTHORED size, which is already metric --
 * about 0.83 units tall, i.e. a real desk in metres. It used to be
 * inflated to ~7.8 units wide to meet the book's own working scale; that
 * is backwards, and the book is now scaled down to meet the furniture
 * instead. See scene/worldScale.js.
 *
 * Its bounding box is still measured rather than hardcoded, so a
 * different desk.glb dropped in later still lands its top on DESK_TOP_Y
 * and still reports the right footprint to the book's placement physics.
 */
// No target width any more: the model is authored in metres and is loaded
// at that size. See scene/worldScale.js -- the BOOK is what gets scaled
// now, not the furniture.
const DESK_TOP_Y = 0; // matches the book's spine/hinge line -- see comment above
// The model's authored size, times the scene's shared oversize factor --
// see scene/worldScale.js.
const DEFAULT_DESK_SCALE = FURNITURE_SCALE;
const DEFAULT_DESK_Y_ROTATION = Math.PI / 2;

// Half-thickness of the invisible physics slab standing in for the desk.
// Nothing ever reaches the underside, so this only needs to be deep enough
// that a fast-falling book cannot tunnel through the top face in one step.
const DESK_SLAB_HALF_DEPTH = 2;

export async function loadDesk(scene, options = {}) {
  const {
    yRotation = DEFAULT_DESK_Y_ROTATION,
    scale = DEFAULT_DESK_SCALE,
  } = options;

  const gltf = await new GLTFLoader().loadAsync('/desk.glb');
  const desk = gltf.scene;

  desk.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
    }
  });

  // Measure once at the model's authored scale, before touching its
  // transform -- Box3.setFromObject reads world matrices, so this has to
  // happen before any scale/position changes below feed back into it.
  const rawBox = new THREE.Box3().setFromObject(desk);
  const rawCenter = rawBox.getCenter(new THREE.Vector3());

  desk.scale.setScalar(scale);

  // Centre the desk's footprint under the book (X/Z), and drop it so its
  // top face (rawBox.max.y, the model's tallest point pre-scale) lands
  // exactly on DESK_TOP_Y once scaled.
  desk.position.set(
    -rawCenter.x * scale,
    DESK_TOP_Y - rawBox.max.y * scale,
    -rawCenter.z * scale,
  );

  desk.rotation.y = yRotation;

  scene.add(desk);

  // Measure the FINAL footprint, after scale/rotation/position are set, so
  // the physics slab matches what is actually drawn rather than the
  // authored model. Only the top face matters for collision -- the book
  // never gets under the desk -- so the slab is given an arbitrary depth
  // downward and its top pinned to DESK_TOP_Y.
  const finalBox = new THREE.Box3().setFromObject(desk);
  const finalCenter = finalBox.getCenter(new THREE.Vector3());
  const finalSize = finalBox.getSize(new THREE.Vector3());

  return {
    object: desk,
    /**
     * The desk as a plain box for the book's placement physics
     * (book/placement/bookPlacement.js). Half-extents and centre are in
     * world space; `topY` is the surface the book comes to rest on, which
     * is also the book's own spine/hinge line at y = 0 (see the module
     * comment above).
     */
    collision: {
      topY: DESK_TOP_Y,
      halfExtents: { x: finalSize.x / 2, y: DESK_SLAB_HALF_DEPTH, z: finalSize.z / 2 },
      center: { x: finalCenter.x, y: DESK_TOP_Y - DESK_SLAB_HALF_DEPTH, z: finalCenter.z },
    },
  };
}