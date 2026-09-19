import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * A round coffee table, in front of the sofa: a walnut top with a moulded
 * edge, an apron under it, four turned legs and a shelf low down between them.
 *
 * TURNED, LIKE THE REAL THING. Every round part is a profile spun on a lathe
 * (THREE.LatheGeometry) -- the top's edge, the apron, each leg's bulbs and
 * necks -- which is how such a table is made, and why a handful of numbers
 * is enough to describe one. All of it is one merged mesh: one draw.
 *
 * Something to put a book down on, too: `collision` is its top as a box, for
 * the book's placement physics (book/placement/bookPlacement.js).
 */

// Metres.
const RADIUS = 0.5;
const HEIGHT = 0.46;
const TOP_THICKNESS = 0.045;
const APRON_DEPTH = 0.07;
const LEG_REACH = 0.66; // the legs stand at this share of the radius from the middle
const SHELF_HEIGHT = 0.11;
const SHELF_THICKNESS = 0.025;

const WALNUT = 0x5b3a26;

/**
 * The turned part of a leg, bottom up, as [radius, height] in metres for a
 * 0.415 m leg: foot, bulb, neck, collar -- ending where the plain block that
 * meets the top begins.
 */
const LEG_TURNING = [
  [0.028, 0], [0.032, 0.03], [0.024, 0.06], [0.04, 0.13], [0.044, 0.17],
  [0.036, 0.22], [0.02, 0.28], [0.024, 0.32], [0.034, 0.36], [0.03, 0.39],
  [0.032, 0.4],
];

/** A turned leg, floor to the underside of the top: foot, bulb, neck, vase, block. */
function legGeometry(tall) {
  // Heights as a share of a 0.415 m leg, stretched to this one; the block at
  // the top is the rest of it.
  const scale = tall / 0.415;
  const [blockRadius] = LEG_TURNING[LEG_TURNING.length - 1];
  return new THREE.LatheGeometry([
    new THREE.Vector2(0, 0),
    ...LEG_TURNING.map(([r, y]) => new THREE.Vector2(r, y * scale)),
    new THREE.Vector2(blockRadius, tall),
    new THREE.Vector2(0, tall),
  ], 20);
}

/**
 * @param {THREE.Scene} scene
 * @returns {{ object: THREE.Mesh, radius: number,
 *   collision: Array<{ center: object, halfExtents: object }>,
 *   place(opts: { x: number, y: number, z: number }): void, dispose(): void }}
 */
export function addCoffeeTable(scene) {
  const underTop = HEIGHT - TOP_THICKNESS;
  const parts = [];

  // The top, with a rounded, slightly undercut edge.
  parts.push(new THREE.LatheGeometry([
    new THREE.Vector2(0, underTop),
    new THREE.Vector2(RADIUS - 0.03, underTop),
    new THREE.Vector2(RADIUS - 0.005, underTop + 0.01),
    new THREE.Vector2(RADIUS, underTop + TOP_THICKNESS * 0.5),
    new THREE.Vector2(RADIUS - 0.005, HEIGHT - 0.008),
    new THREE.Vector2(RADIUS - 0.018, HEIGHT),
    new THREE.Vector2(0, HEIGHT),
  ], 64));

  // The apron: a band round under the top, joining the legs.
  const apron = RADIUS * LEG_REACH + 0.04;
  parts.push(new THREE.LatheGeometry([
    new THREE.Vector2(apron - 0.02, underTop - APRON_DEPTH),
    new THREE.Vector2(apron, underTop - APRON_DEPTH),
    new THREE.Vector2(apron, underTop),
    new THREE.Vector2(apron - 0.02, underTop),
    new THREE.Vector2(apron - 0.02, underTop - APRON_DEPTH),
  ], 48));

  // Four legs, on the diagonals.
  const legReach = RADIUS * LEG_REACH;
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI / 4 + (i * Math.PI) / 2;
    const leg = legGeometry(underTop);
    leg.translate(Math.cos(angle) * legReach, 0, Math.sin(angle) * legReach);
    parts.push(leg);
  }

  // The shelf low down between them.
  const shelf = new THREE.CylinderGeometry(legReach + 0.05, legReach + 0.05, SHELF_THICKNESS, 48);
  shelf.translate(0, SHELF_HEIGHT, 0);
  parts.push(shelf);

  const geometry = mergeGeometries(parts.map((part) => (part.index ? part.toNonIndexed() : part)), false);
  // Each part keeps the normals it was turned with -- smooth round every
  // curve. Recomputed on the merged, unindexed whole they would come out flat.
  for (const part of parts) part.dispose();

  const object = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color: WALNUT, roughness: 0.5, metalness: 0 }),
  );
  object.name = 'coffeeTable';
  object.castShadow = true;
  object.receiveShadow = true;
  scene.add(object);

  const table = {
    object,
    radius: RADIUS,

    /** The top, as a box a book can land on. Empty until place(). */
    collision: [],

    /** Stand it with its middle at (x, z) on a floor at `y`. */
    place({ x, y, z }) {
      object.position.set(x, y, z);
      object.updateMatrixWorld(true);
      // A square inside the round top: a book lands on the table, not on air
      // past its edge.
      const half = RADIUS * 0.72;
      table.collision = [{
        center: { x, y: y + HEIGHT - TOP_THICKNESS / 2, z },
        halfExtents: { x: half, y: TOP_THICKNESS / 2, z: half },
      }];
    },

    dispose() {
      scene.remove(object);
      geometry.dispose();
      object.material.dispose();
    },
  };
  return table;
}
