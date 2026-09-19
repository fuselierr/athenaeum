import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { box, slab } from './woodwork.js';

/**
 * The mezzanine: a balcony that wraps two walls of the room, and the curved
 * stair up to it.
 *
 * THE WAY UP. The bookshelf stands against -X and the door is in the +Z wall,
 * and the climb goes round the room the long way:
 *
 *   the flight   starts against the back wall (-Z), travelling -X toward the
 *                shelves, and CURVES LEFT a quarter turn as it climbs, so it
 *                arrives facing +Z.
 *   the long arm carries straight on the way the flight was heading: +Z along
 *                the shelf wall, as far as the wall the door is in.
 *   the door arm turns left again there and runs back along the door wall,
 *                OVER THE DOOR, to the window wall.
 *
 * WHAT SETS THE SIZES, measured off the room rather than written down (main.js
 * arranges the furniture the same way):
 *
 *   The flight arrives at the FAR end of the balcony, against the shelf wall,
 *   and the turn is measured back from there: the radius is whatever leaves a
 *   comfortable tread at the walk line, which stands the foot out in the room
 *   with floor all round it to step onto. The turn hugs the back wall. The
 *   balcony is then its own depth, wide enough to walk along past the head of
 *   the stair, and deep enough to clear both the bookshelf beneath it and the
 *   head of the door it passes over.
 *
 * WALKING ON IT. The camera walks on uneven ground by asking how high it is
 * underfoot (input/cameraModes.js's setGround, which the terrain outside uses)
 * -- one height per spot on the floor. A room with a balcony has TWO: the floor
 * and the deck above it. So what is reported is the highest surface still below
 * your head: under the deck that is the floor, on top of it the deck, and the
 * flight between them is a smooth ramp rather than a dozen separate lips to
 * trip on. The treads are drawn as steps regardless.
 *
 * THE UPPER STOREY IS WIDER. The room above the deck stands further out on
 * its +X and +Z sides than the room below (scene/inside/room.js's upper), so
 * the deck goes with it: both arms run on out to the upper +Z wall, and a
 * strip of floor runs along the +X side over the top of the lower wall, with
 * a rail along its open edge. It needs no posts: it stands on that wall.
 * Where you may walk follows which storey you are on -- the lower room's
 * footprint down there, the wider upper one up here.
 *
 * WHAT IT COSTS TO DRAW: four things -- the boards you stand on, one merged
 * piece of woodwork (slabs, posts, handrails), the treads as one instanced
 * step, and every spindle as one instanced baluster.
 */

// Heights and sizes in metres (scene/worldScale.js: the world is metric).
const DECK_THICKNESS = 0.16;
const DECK_HEAD_ROOM = 2.3; // kept clear between the deck and the ceiling
const OVER_SHELF = 0.6; // the deck this far above the top of the bookshelf
const OVER_DOOR = 0.1; // and this far above the head of the door it crosses
const MIN_DECK_RISE = 2.3; // and never closer than this to the floor
const DECK_DEPTH = [1.8, 3.4]; // how far the long arm may reach out from its wall
const LONG_ARM_DEPTH = 2.6; // what it reaches out by, room allowing
const WALL_GAP = 0.06; // the flight's outer edge, off the wall it lands against
const DOOR_ARM_DEPTH = 1.6; // how deep the arm over the door is
const STAIR_RADIUS = [1.9, 3.0]; // of the centre line of the flight
const TREAD_RUN = 0.3; // how deep one tread is along that centre line
const FOOT_CLEARANCE = 1.2; // clear floor between the bottom step and the window wall
const BACK_GAP = 0.15; // the turn's outer edge, off the back wall it hugs
const STEP_RISE = 0.19; // aimed for; the climb is then divided evenly
const STAIR_WIDTH = 1.05;
const TREAD_THICKNESS = 0.08;
const RAIL_HEIGHT = 0.95;
const RAIL_RADIUS = 0.032;
const RAIL_INSET = 0.06; // the rail, in from the edge it guards
const BALUSTER = 0.04;
const BALUSTER_GAP = 0.15;
const POST_SPACING = 1.8; // posts under an open edge, about this far apart
const POST_SIZE = 0.14;
// How far below your head a surface has to be to be the one you are standing
// on. This is what lets you walk UNDER the deck instead of being lifted onto
// it, and it is generous enough that jumping does not snatch you up there.
const UNDERFOOT_CLEARANCE = 0.6;

const WOOD_COLOR = 0x4a3222; // walnut, as the instruction card's frame
const UP = new THREE.Vector3(0, 1, 0);
const QUARTER = Math.PI / 2;

/**
 * How high the deck stands above the floor: clear of the shelf it covers and
 * the door it crosses, and still leaving head room under the ceiling.
 * Exported because the room needs it before the deck exists -- it is where
 * the room's upper storey begins (scene/inside/room.js's upper) -- and both
 * have to agree on it to the millimetre.
 *
 * @param {{ floorY: number, ceilingY: number, shelfTop: number, doorTop: number }} at
 *   world heights: the floor, the ceiling, the top of the bookshelf and of the
 *   door's casing
 * @returns {number} metres above the floor
 */
export function deckRise({ floorY, ceilingY, shelfTop, doorTop }) {
  return THREE.MathUtils.clamp(
    Math.max(
      (shelfTop - floorY) + OVER_SHELF,
      (doorTop - floorY) + DECK_THICKNESS + OVER_DOOR,
    ),
    MIN_DECK_RISE,
    (ceilingY - floorY) - DECK_HEAD_ROOM,
  );
}

/**
 * One step of a curving stair: the piece of a ring between two radii, spanning
 * `sweep` radians about the middle of +X, with its top face at y = 0 -- so an
 * instance of it is simply turned to its angle and lifted to its height.
 */
function treadGeometry(inner, outer, sweep, thickness) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, -sweep / 2, sweep / 2, false);
  shape.absarc(0, 0, inner, sweep / 2, -sweep / 2, true);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  // Drawn flat in XY and extruded along Z; this lays it down, then drops it so
  // the tread's top face is at the origin's height.
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -thickness, 0);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * @param {THREE.Scene} scene
 * @param {object} opts
 * @param {THREE.PerspectiveCamera} opts.camera  whose head decides which level
 *   you are on -- see WALKING ON IT above
 * @param {THREE.Box3} opts.floorBox  the walkable floor: its min.y is the floor
 *   and its footprint is the room
 * @param {number} opts.ceilingY  world height of the ceiling
 * @param {THREE.Box3} opts.shelfBox  the bookshelf where it stands, which the
 *   deck has to clear
 * @param {THREE.Box3} opts.doorBox  the doorway in the +Z wall, which the deck
 *   passes over: its head is what the deck has to clear
 * @param {number} [opts.rise]  the deck's height above the floor, if already
 *   worked out (deckRise) -- otherwise worked out here, the same way
 * @param {{ x?: number, z?: number }} [opts.grow]  how much further out the
 *   upper storey's +X and +Z walls stand than the lower storey's
 * @param {THREE.Material|null} [opts.woodMaterial]  what its joinery is made of
 *   -- the pine (scene/inside/surfaces.js)
 * @param {THREE.Material|null} [opts.deckMaterial]  the floorboards
 *   (scene/inside/surfaces.js), whose textures tile by the metre
 * @returns {{ group: THREE.Group, deckY: number, edgeX: number,
 *   ground: { bounds: THREE.Box3, heightAt(x: number, z: number): number },
 *   collision: Array<{ center: object, halfExtents: object }>, dispose(): void }}
 */
export function addMezzanine(scene, {
  camera, floorBox, ceilingY, shelfBox, doorBox, rise: givenRise = null, grow = null,
  deckMaterial = null, woodMaterial = null,
}) {
  const floorY = floorBox.min.y;
  const wallX = floorBox.min.x; // the wall the bookshelf stands against
  const maxX = floorBox.max.x; // the window wall
  const minZ = floorBox.min.z; // the back wall, which the flight hugs
  const maxZ = floorBox.max.z; // the wall the door is in

  // How far the upper storey reaches past the lower one, and so the deck with it.
  const growX = Math.max(0, grow?.x ?? 0);
  const growZ = Math.max(0, grow?.z ?? 0);
  const upperMaxX = maxX + growX;
  const upperMaxZ = maxZ + growZ;

  // High enough to clear the shelf it covers AND the door it crosses, and still
  // leaving head room under the ceiling.
  const rise = givenRise ?? deckRise({
    floorY, ceilingY, shelfTop: shelfBox.max.y, doorTop: doorBox.max.y,
  });
  const deckY = floorY + rise;
  const steps = Math.max(8, Math.round(rise / STEP_RISE));
  const stepRise = rise / steps;

  // --- the flight -------------------------------------------------------------------
  // It lands against the shelf wall, at the far end of the balcony: the head of
  // the flight is half a stair's width off that wall, and the rest is measured
  // back from there.
  const headX = wallX + STAIR_WIDTH / 2 + WALL_GAP;
  // A comfortable tread at the walk line asks for this much turn -- less, in a
  // room too narrow to leave floor in front of the bottom step to get on from.
  const radius = THREE.MathUtils.clamp(
    Math.min((steps * TREAD_RUN) / QUARTER, (maxX - FOOT_CLEARANCE) - headX),
    STAIR_RADIUS[0], STAIR_RADIUS[1],
  );
  const inner = radius - STAIR_WIDTH / 2;
  const outer = radius + STAIR_WIDTH / 2;
  // The turn's centre is where the foot stands: a radius out from the head, and
  // far enough off the back wall for the turn to hug it without going through.
  const centreX = headX + radius;
  const centreZ = minZ + BACK_GAP + outer;
  const headZ = centreZ; // where it arrives on the deck, facing +Z
  // The balcony's depth is its own now, not wherever the flight happens to
  // arrive: enough to walk along past the head of the stair.
  const edgeX = wallX + THREE.MathUtils.clamp(LONG_ARM_DEPTH, DECK_DEPTH[0], DECK_DEPTH[1]);

  /**
   * A point on the flight. The angle is 0 at the foot, where the walk heads -X,
   * and a quarter turn at the head, where it heads +Z -- so the turn is to the
   * left all the way up.
   */
  const alongArc = (theta, r) => new THREE.Vector2(
    centreX - r * Math.sin(theta),
    centreZ - r * Math.cos(theta),
  );
  /** How far the walk has climbed at an angle through the turn. */
  const climbAt = (theta) => floorY + THREE.MathUtils.clamp(theta / QUARTER, 0, 1) * rise;

  // --- the deck, an L round two walls -------------------------------------------------
  // The long arm carries on the way the flight was heading, to the door wall;
  // the door arm turns left along that wall and crosses over the door. Both run
  // out to the upper storey's walls, past the lower room's -- and along the
  // window wall, where the upper storey stands further out, a strip of floor
  // runs over the top of the lower wall to meet it.
  const longArm = { minX: wallX, maxX: edgeX, minZ: headZ, maxZ: upperMaxZ };
  const doorArm = { minX: edgeX, maxX: upperMaxX, minZ: maxZ - DOOR_ARM_DEPTH, maxZ: upperMaxZ };
  // Set back a hair from the lower wall's plane: flush, the strip's edge and
  // the top of the wall would be the same surface twice, and flicker.
  const windowArm = growX > 0 ? { minX: maxX + 0.005, maxX: upperMaxX, minZ, maxZ: doorArm.minZ } : null;
  const arms = [longArm, doorArm, windowArm].filter(Boolean);

  const group = new THREE.Group();
  group.name = 'mezzanine';

  const ownsWood = !woodMaterial;
  const wood = woodMaterial
    ?? new THREE.MeshStandardMaterial({ color: WOOD_COLOR, roughness: 0.6, metalness: 0 });
  const ownsBoards = !deckMaterial;
  const boards = deckMaterial
    ?? new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9, metalness: 0 });

  const deck = new THREE.Mesh(
    mergeGeometries(arms.map(
      (arm) => slab(arm.minX, arm.maxX, arm.minZ, arm.maxZ, deckY),
    ), false),
    boards,
  );
  deck.name = 'mezzanineDeck';
  deck.receiveShadow = true;
  group.add(deck);

  // --- the woodwork, all one piece -------------------------------------------------
  const pieces = [];
  const spindles = [];

  for (const arm of arms) {
    pieces.push(box(
      arm.maxX - arm.minX, DECK_THICKNESS, arm.maxZ - arm.minZ,
      (arm.minX + arm.maxX) / 2, deckY - DECK_THICKNESS / 2, (arm.minZ + arm.maxZ) / 2,
    ));
  }

  // Every edge you could walk off, inset by the rail, as runs to guard. The
  // long arm's back end is the one the flight comes up through, so it is split
  // either side of that opening.
  const openEdges = [
    // The long arm's open edge, down to where the door arm takes over.
    [edgeX - RAIL_INSET, headZ, edgeX - RAIL_INSET, doorArm.minZ],
    // The door arm's open edge, out to the window wall -- or to the corner of
    // the strip along it, where its own rail takes over.
    [edgeX - RAIL_INSET, doorArm.minZ + RAIL_INSET, maxX + (windowArm ? RAIL_INSET : 0), doorArm.minZ + RAIL_INSET],
  ];
  // The strip along the window wall: its open edge, from that corner back to
  // the back wall. Railed like the rest, but not posted -- it stands on the
  // lower wall.
  if (windowArm) openEdges.push([maxX + RAIL_INSET, doorArm.minZ + RAIL_INSET, maxX + RAIL_INSET, minZ]);
  const postedEdges = openEdges.slice(0, 2);
  const backEnd = [
    [wallX, headZ + RAIL_INSET, headX - STAIR_WIDTH / 2, headZ + RAIL_INSET],
    [headX + STAIR_WIDTH / 2, headZ + RAIL_INSET, edgeX, headZ + RAIL_INSET],
  ];

  for (const [ax, az, bx, bz] of [...openEdges, ...backEnd]) {
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 0.2) continue;
    const alongX = Math.abs(bx - ax) > Math.abs(bz - az);
    pieces.push(box(
      alongX ? length : 0.09, 0.07, alongX ? 0.09 : length,
      (ax + bx) / 2, deckY + RAIL_HEIGHT, (az + bz) / 2,
    ));
    const count = Math.max(1, Math.round(length / BALUSTER_GAP));
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      spindles.push({ x: ax + (bx - ax) * t, y: deckY, z: az + (bz - az) * t });
    }
  }

  // Posts holding up the open edges.
  const postHeight = (deckY - DECK_THICKNESS) - floorY;
  const postSpots = [];
  for (const [ax, az, bx, bz] of postedEdges) {
    const length = Math.hypot(bx - ax, bz - az);
    const count = Math.max(1, Math.round(length / POST_SPACING));
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const at = { x: ax + (bx - ax) * t, z: az + (bz - az) * t };
      // Where two runs meet there is one post, not two in the same place.
      if (postSpots.some((p) => Math.hypot(p.x - at.x, p.z - at.z) < POST_SIZE)) continue;
      postSpots.push(at);
      pieces.push(box(POST_SIZE, postHeight, POST_SIZE, at.x, floorY + postHeight / 2, at.z));
    }
  }

  // The flight's two handrails, curving up with it -- kept, with which way is
  // out over each (off the inside of the turn, or toward the wall it hugs),
  // for anything that grows along them.
  const stairRails = [];
  for (const r of [inner + RAIL_INSET, outer - RAIL_INSET]) {
    const points = [];
    const outward = [];
    const away = r < radius ? -1 : 1; // the inner rail's outside is toward the turn's centre
    for (let i = 0; i <= 24; i++) {
      const theta = (i / 24) * QUARTER;
      const at = alongArc(theta, r);
      points.push(new THREE.Vector3(at.x, climbAt(theta) + RAIL_HEIGHT, at.y));
      outward.push(new THREE.Vector3(at.x - centreX, 0, at.y - centreZ).normalize().multiplyScalar(away));
    }
    pieces.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 48, RAIL_RADIUS, 6, false));
    stairRails.push({ points, outward, inner: r < radius });
  }

  const structure = new THREE.Mesh(mergeGeometries(pieces, false), wood);
  structure.name = 'mezzanineStructure';
  structure.castShadow = true;
  structure.receiveShadow = true;
  group.add(structure);
  for (const piece of pieces) piece.dispose();

  // --- the steps, as one instanced tread ------------------------------------------
  const perStep = QUARTER / steps;
  const treads = new THREE.InstancedMesh(
    treadGeometry(inner, outer, perStep * 0.97, TREAD_THICKNESS), wood, steps,
  );
  treads.name = 'mezzanineTreads';
  treads.castShadow = true;
  treads.receiveShadow = true;
  const _matrix = new THREE.Matrix4();
  const _position = new THREE.Vector3();
  const _quaternion = new THREE.Quaternion();
  const _scale = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < steps; i++) {
    // The tread is drawn about +X; a quarter turn puts it at the foot, and the
    // climb carries it round from there.
    _quaternion.setFromAxisAngle(UP, QUARTER + (i + 0.5) * perStep);
    _position.set(0, floorY + (i + 1) * stepRise, 0);
    treads.setMatrixAt(i, _matrix.compose(_position, _quaternion, _scale));
  }
  treads.position.set(centreX, 0, centreZ);
  group.add(treads);

  // --- every spindle, as one instanced baluster -------------------------------------
  for (const r of [inner + RAIL_INSET, outer - RAIL_INSET]) {
    const count = Math.max(2, Math.round((r * QUARTER) / BALUSTER_GAP));
    for (let i = 0; i <= count; i++) {
      const theta = (i / count) * QUARTER;
      const at = alongArc(theta, r);
      spindles.push({ x: at.x, y: climbAt(theta), z: at.y });
    }
  }
  const spindleGeometry = new THREE.BoxGeometry(BALUSTER, 1, BALUSTER);
  spindleGeometry.translate(0, 0.5, 0); // stood on its foot, a metre tall
  const balusters = new THREE.InstancedMesh(spindleGeometry, wood, spindles.length);
  balusters.name = 'mezzanineBalusters';
  balusters.castShadow = true;
  _scale.set(1, RAIL_HEIGHT, 1);
  _quaternion.identity();
  spindles.forEach((spindle, i) => {
    _position.set(spindle.x, spindle.y, spindle.z);
    balusters.setMatrixAt(i, _matrix.compose(_position, _quaternion, _scale));
  });
  group.add(balusters);

  scene.add(group);

  // --- walking on it --------------------------------------------------------------
  const _head = new THREE.Vector3();

  /** How high the flight is at a spot on the floor, or null where it is not. */
  function stairAt(x, z) {
    const dx = x - centreX;
    const dz = z - centreZ;
    const r = Math.hypot(dx, dz);
    if (r < inner - 0.1 || r > outer + 0.1) return null;
    const theta = Math.atan2(-dx, -dz);
    if (theta < -0.03 || theta > QUARTER + 0.03) return null;
    return climbAt(theta);
  }

  const within = (arm, x, z) => x >= arm.minX - 0.05 && x <= arm.maxX + 0.05
    && z >= arm.minZ - 0.05 && z <= arm.maxZ + 0.05;
  const onDeck = (x, z) => arms.some((arm) => within(arm, x, z));

  // Where you may walk: the lower room's footprint, or -- head above the deck
  // -- the upper storey's, which stands further out.
  const upperBounds = new THREE.Box3(
    floorBox.min.clone(),
    new THREE.Vector3(upperMaxX, floorBox.max.y, upperMaxZ),
  );
  const upstairs = () => camera.getWorldPosition(_head).y - UNDERFOOT_CLEARANCE >= deckY - 0.05;

  return {
    group,
    deckY,
    /** The underside of the deck: the head room anything beneath it has. */
    underY: deckY - DECK_THICKNESS,
    edgeX,

    // --- its shape, for anything dressing it (scene/inside/foliage.js) --------------
    /**
     * The arms of the deck, as { minX, maxX, minZ, maxZ } in world space --
     * and the strip along the window wall, if the upper storey is wider.
     */
    arms: { long: longArm, door: doorArm, window: windowArm },
    /**
     * The edges you could walk off, along the line of the rail, each with the
     * way out over it: { ax, az, bx, bz, outward: [x, z], overWall } --
     * `overWall` for the strip's edge, which stands over the lower wall's
     * windows rather than over open floor.
     */
    edges: openEdges.map(([ax, az, bx, bz], i) => ({
      ax, az, bx, bz, outward: [[1, 0], [0, -1], [-1, 0]][i], overWall: i === 2,
    })),
    /** How far out past the rail line the deck's own edge is. */
    railInset: RAIL_INSET,
    railHeight: RAIL_HEIGHT,
    /** Where the posts under those edges stand, and how thick they are. */
    posts: postSpots,
    postSize: POST_SIZE,
    /**
     * The stair's two handrails, foot to head: the rail's top at each point,
     * the way out over it there, and whether it is the rail on the inside of
     * the turn -- the one open to the room.
     */
    stairRails,
    floorY,

    /**
     * The ground to walk on indoors, for input/cameraModes.js's setGround: the
     * floor, the flight or the deck -- whichever is the highest one under your
     * head. As far as you may walk is the storey you are on: the lower room's
     * footprint, or the wider upper one's.
     */
    ground: {
      get bounds() { return upstairs() ? upperBounds : floorBox; },
      heightAt(x, z) {
        const reach = camera.getWorldPosition(_head).y - UNDERFOOT_CLEARANCE;
        let under = floorY;
        const stair = stairAt(x, z);
        if (stair !== null && stair <= reach && stair > under) under = stair;
        if (onDeck(x, z) && deckY <= reach && deckY > under) under = deckY;
        return under;
      },
    },

    /**
     * The deck for the book's placement physics (book/placement/bookPlacement.js),
     * so a book let go of up here lands on the balcony instead of falling through
     * it. The flight is left out on purpose: a wedge is not a box, and a box drawn
     * round one would catch a book in mid-air beside the steps.
     */
    collision: arms.map((arm) => ({
      center: {
        x: (arm.minX + arm.maxX) / 2,
        y: deckY - DECK_THICKNESS / 2,
        z: (arm.minZ + arm.maxZ) / 2,
      },
      halfExtents: {
        x: (arm.maxX - arm.minX) / 2,
        y: DECK_THICKNESS / 2,
        z: (arm.maxZ - arm.minZ) / 2,
      },
    })),

    dispose() {
      scene.remove(group);
      deck.geometry.dispose();
      structure.geometry.dispose();
      treads.geometry.dispose();
      balusters.geometry.dispose();
      treads.dispose();
      balusters.dispose();
      if (ownsWood) wood.dispose();
      if (ownsBoards) boards.dispose();
    },
  };
}
