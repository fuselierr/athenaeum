import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
 * The desk model's authored scale (metres, going by its ~0.83-unit
 * height) has no relationship to the book's own unitless scale (a
 * HINGE_LEN of 2.0 by default) -- placed as-authored it would be a tenth
 * the book's size. DESK_TARGET_WIDTH picks a world-space width for the
 * desk relative to that default book scale instead, and the model's own
 * bounding box (measured after load, not hardcoded, so a different
 * desk.glb dropped in later still scales sensibly) determines the
 * uniform scale factor and the top-surface offset from that.
 *
 * Measured (via Box3) at the book's default reset() pose: X spans
 * [-1, 1] (HINGE_LEN), Z spans roughly [-1.75, 1.75] -- wider than it
 * looks, because reset()'s starting angles are deliberately asymmetric
 * (config.js's COVER_START_NEAR/FAR splay one cover to ~9° and the other
 * to ~168°), so one cover ends up lying almost flat open. 4.8 covers the
 * X span with plenty of margin and the Z span closely but not
 * completely -- a uniform scale wide enough to swallow that full 3.5-unit
 * Z reach as well would need to be ~40% bigger, and at this model's own
 * proportions that reads as an oversized table rather than a desk with a
 * book sitting on it. Verified by rendering the scene and checking the
 * two bounding boxes rather than by eyeballing the constant.
 */
const DESK_TARGET_WIDTH = 6.5;
const DESK_TOP_Y = 0; // matches the book's spine/hinge line -- see comment above
const DEFAULT_DESK_SCALE = 1.2;
const DEFAULT_DESK_Y_ROTATION = Math.PI / 2;

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
  const rawSize = rawBox.getSize(new THREE.Vector3());
  const rawCenter = rawBox.getCenter(new THREE.Vector3());

  const baseScale = DESK_TARGET_WIDTH / rawSize.x;
  desk.scale.setScalar(baseScale * scale);

  // Centre the desk's footprint under the book (X/Z), and drop it so its
  // top face (rawBox.max.y, the model's tallest point pre-scale) lands
  // exactly on DESK_TOP_Y once scaled.
  desk.position.set(
    -rawCenter.x * baseScale * scale,
    DESK_TOP_Y - rawBox.max.y * baseScale * scale,
    -rawCenter.z * baseScale * scale,
  );

  desk.rotation.y = yRotation;

  scene.add(desk);
  return desk;
}