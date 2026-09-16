import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { box } from './woodwork.js';

/**
 * A run of shelves built into a wall. Carpentry rather than a model: the whole
 * thing is boxes, merged into one mesh wearing one material, so a wall of
 * shelving costs a single draw call.
 *
 * HOW IT IS PUT TOGETHER. The run is divided into equal LAYERS. The bottom one
 * and the top one are solid wood -- a plinth to stand it on, a head to finish
 * it -- and the layers between them are open shelves, boarded at each division.
 * PILLARS stand at intervals across the front, the full height of the run and
 * proud of the shelf fronts, which is what breaks a long wall of books into
 * bays rather than one uninterrupted ladder.
 *
 * IT IS BUILT AGAINST THE +Z WALL, facing back into the room (-Z). That is the
 * only wall in this room with the length for it, and hard-coding the one case
 * is honest: a general one would be four times the arithmetic for a case
 * nothing asks for.
 */

const DEPTH = 0.32; // how far the shelves come out from the wall
const BACK_THICKNESS = 0.02;
const BOARD = 0.025; // a shelf board
const END_THICKNESS = 0.05;
const PILLAR_WIDTH = 0.07;
const PILLAR_PROUD = 0.07; // how far a pillar stands out past the shelf fronts
const PILLAR_SPACING = 1.5; // about this far apart across the run
const LAYERS = 8; // counting the solid one at the bottom and the solid one on top
const WOOD_COLOR = 0x4a3222; // walnut, as the rest of the room's woodwork

/**
 * @param {THREE.Scene} scene
 * @param {object} opts
 * @param {number} opts.minX  the run, in world x
 * @param {number} opts.maxX
 * @param {number} opts.wallZ  the wall it is built against
 * @param {number} opts.floorY  the floor it stands on
 * @param {number} opts.height  floor to the top of the head
 * @param {number} [opts.depth]  how far it comes out from the wall
 * @param {number} [opts.layers]  including the solid bottom and top
 * @param {THREE.Material|null} [opts.material]
 * @returns {{ object: THREE.Mesh, collision: Array<{ center: object, halfExtents: object }>,
 *   dispose(): void }}
 */
export function addWallShelf(scene, {
  minX, maxX, wallZ, floorY, height,
  depth = DEPTH, layers = LAYERS, material = null,
}) {
  const width = maxX - minX;
  const middleX = (minX + maxX) / 2;
  const layer = height / layers;
  // Into the room is -Z from this wall, so everything sits in front of it.
  const middleZ = wallZ - depth / 2;

  const pieces = [];

  // The back, and an end board at either end of the run.
  pieces.push(box(width, height, BACK_THICKNESS, middleX, floorY + height / 2, wallZ - BACK_THICKNESS / 2));
  for (const x of [minX + END_THICKNESS / 2, maxX - END_THICKNESS / 2]) {
    pieces.push(box(END_THICKNESS, height, depth, x, floorY + height / 2, middleZ));
  }

  // Solid wood at the bottom and at the top -- no opening in either.
  pieces.push(box(width, layer, depth, middleX, floorY + layer / 2, middleZ));
  pieces.push(box(width, layer, depth, middleX, floorY + height - layer / 2, middleZ));

  // A board at each division between the open layers. The divisions against
  // the solid bottom and top are already wood, so they are skipped.
  for (let k = 2; k <= layers - 2; k++) {
    pieces.push(box(width, BOARD, depth, middleX, floorY + k * layer, middleZ));
  }

  // Pillars across the front, ends included, standing proud of the shelves.
  const bays = Math.max(1, Math.round(width / PILLAR_SPACING));
  for (let i = 0; i <= bays; i++) {
    const x = THREE.MathUtils.clamp(
      minX + (width * i) / bays, minX + PILLAR_WIDTH / 2, maxX - PILLAR_WIDTH / 2,
    );
    pieces.push(box(
      PILLAR_WIDTH, height, depth + PILLAR_PROUD,
      x, floorY + height / 2, wallZ - (depth + PILLAR_PROUD) / 2,
    ));
  }

  const ownsMaterial = !material;
  const wood = material
    ?? new THREE.MeshStandardMaterial({ color: WOOD_COLOR, roughness: 0.62, metalness: 0 });
  const object = new THREE.Mesh(mergeGeometries(pieces, false), wood);
  object.name = 'wallShelf';
  object.castShadow = true;
  object.receiveShadow = true;
  scene.add(object);
  for (const piece of pieces) piece.dispose();

  return {
    object,

    /**
     * The run as one box for the book's placement physics
     * (book/placement/bookPlacement.js): a book set down against it stops at
     * the shelf fronts rather than sinking into the joinery.
     */
    collision: [{
      center: { x: middleX, y: floorY + height / 2, z: wallZ - (depth + PILLAR_PROUD) / 2 },
      halfExtents: { x: width / 2, y: height / 2, z: (depth + PILLAR_PROUD) / 2 },
    }],

    dispose() {
      scene.remove(object);
      object.geometry.dispose();
      if (ownsMaterial) wood.dispose();
    },
  };
}
