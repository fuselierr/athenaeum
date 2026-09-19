import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { seeded } from '../seeded.js';
import { WINDOW_FRAME, WINDOW_SILL_PROJECTION } from './room.js';

/**
 * Green things in the room: ivy over the windows, greenery heaped along the
 * balcony and spilling off it, and a few good-sized potted plants.
 *
 * MASSES, NOT STRANDS. Ivy and trailing plants read as foliage because they
 * come in soft heaps -- a stem with a leaf every few centimetres reads as a
 * line. So the climbing and trailing greenery is built from CLUMPS, the Fluffy
 * Tree's trick (scene/outside/tree.js): each clump is an ellipsoid filled with
 * small cards, each card a cluster of leaves cut out of one texture, and each
 * card is LIT AS IF IT WERE A POINT ON THE ELLIPSOID'S SURFACE -- its normal
 * is the clump's, not the card's own. So a clump shades like one round,
 * soft thing, bright on the side toward the window and dark underneath,
 * while its outline stays ragged with leaves. The cards deeper inside are
 * darker too, for the shade in the heart of a bush.
 *
 * WHERE IT GROWS is worked out from the room's own measurements, so it fits
 * whatever size the room came out:
 *
 *   windows   up the casing of most of the arched windows and some way over
 *             the arch, hugging the wall; heaped on some of the low sills.
 *   balcony   a hedge along the rail, masses tucked under the deck's edge,
 *             and trailing cascades hanging from there into the room --
 *             chains of clumps getting smaller toward their tips.
 *   posts     ivy climbing some of the posts that hold the deck up.
 *   stairs    clumps along both of the stair's curving handrails, and short
 *             trails down their open sides.
 *   bookshelf a pothos on top, mounded in its pot, trailing over the edge.
 *
 * The potted plants keep real leaves, each one bent into shape: a fiddle-leaf
 * fig, palms, and a snake plant, where they stand at the ends of things
 * rather than in anyone's way.
 *
 * THE SAME EVERY VISIT: all of it from one seeded random stream
 * (scene/seeded.js).
 *
 * WHAT IT COSTS TO DRAW: a handful of draws for the lot -- every card one
 * instance of one quad, every leaf of a kind one instance of one bent leaf,
 * every stem one merged mesh and every pot another.
 *
 * DENSITY. Cards and leaves are shuffled before they are laid down, so
 * drawing only the first share of them (setDensity -- the graphics quality's
 * foliageDensity) thins the whole room evenly rather than stripping one
 * corner bare.
 */

const SEED = 5150;

// --- the clumps ------------------------------------------------------------------------
// Cards of leaves per square metre of a clump's surface, and how big a card is.
const CARDS_PER_M2 = 150;
const CARD_SIZE = [0.13, 0.22]; // metres across
const CLUMP_COLOURS = [0x2f5a22, 0x74a544]; // the range a card is tinted from
// How dark the heart of a clump is, against its surface (1 = no darker).
const CLUMP_HEART = 0.45;
// How far a card's face may turn away from the clump's surface, radians --
// enough to break up the outline, not so much that cards show edge-on.
const CARD_TILT = 0.7;

const WINDOW_SHARE = 0.75; // of the arched windows, how many the ivy climbs
const SILL_SHARE = 0.35; // of the low sills, how many have greenery on them
const RAIL_STEP = 0.3; // metres along the rail between clumps of the hedge
const RAIL_SHARE = 0.85; // of those places, how many have one
const SPILL_SHARE = 0.6; // and how many have a mass tucked under the deck's edge
const CASCADE_STEP = 0.35; // metres along the edge between trailing cascades, at most
const CASCADE_SHARE = 0.55;
const CASCADE_LENGTH = [0.35, 1.9];
const POST_SHARE = 0.5; // of the posts, how many the ivy climbs
const STAIR_STEP = 0.28; // metres along a stair handrail between clumps
const STAIR_SHARE = 0.7; // of those places, how many have one
const STAIR_CASCADE_SHARE = 0.35; // and how many trail something down its open side

// --- the potted plants' own leaves -------------------------------------------------------
// Half-width along the length of a leaf (t 0 at the stalk, 1 at the tip), as a
// fraction of its length; how deeply it folds along its midrib, and how far
// its tip curls back. Colours are the range each kind is drawn from.
const LEAF_KINDS = {
  broad: { // fiddle-leaf fig: widest toward the tip, blunt-ended
    width: (t) => 0.34 * Math.sin(Math.PI * Math.min(t * 0.93, 1)) ** 0.55 * (0.55 + 0.6 * t),
    fold: 0.14, curl: 0.2, colours: [0x2c5a22, 0x3f7430],
  },
  leaflet: { // a palm's: long, narrow and drooping
    width: (t) => 0.09 * Math.sin(Math.PI * t) ** 0.9,
    fold: 0.35, curl: 0.3, colours: [0x467d30, 0x6c9c3e],
  },
  blade: { // snake plant: upright, a sword
    width: (t) => 0.075 * Math.min(1, t * 6) * (1 - t ** 4),
    fold: 0.3, curl: -0.04, colours: [0x3e5e32, 0x5f8045],
  },
};
const LEAF_ROWS = 7; // steps along a leaf's length

const STEM_COLOUR = 0x4f5a2f;
const POT_COLOURS = {
  terracotta: 0xb4623a,
  cream: 0xe6ddcc,
  slate: 0x44504b,
};
const SOIL_COLOUR = 0x2e2118;

const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * The texture every card wears: a little spray of leaves round a middle,
 * pale so each card's own tint colours it, cut out by its alpha. Drawn here
 * rather than loaded -- it costs a moment and nothing to ship.
 */
function leafCardTexture(random) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const leaves = 9;
  for (let i = 0; i < leaves; i++) {
    const angle = (i / leaves) * Math.PI * 2 + (random() - 0.5) * 0.6;
    const length = size * (0.26 + random() * 0.16);
    const width = length * (0.42 + random() * 0.14);
    const from = size * 0.06 * random();
    const light = 0.78 + random() * 0.22;
    ctx.save();
    ctx.translate(size / 2 + Math.cos(angle) * from, size / 2 + Math.sin(angle) * from);
    ctx.rotate(angle + Math.PI / 2);
    // A leaf pointing up the canvas from its stalk at the origin.
    const shape = new Path2D();
    shape.moveTo(0, 0);
    shape.bezierCurveTo(width * 0.75, -length * 0.15, width * 0.55, -length * 0.75, 0, -length);
    shape.bezierCurveTo(-width * 0.55, -length * 0.75, -width * 0.75, -length * 0.15, 0, 0);
    const shade = ctx.createLinearGradient(0, 0, 0, -length);
    shade.addColorStop(0, `rgb(${Math.round(185 * light)}, ${Math.round(210 * light)}, ${Math.round(160 * light)})`);
    shade.addColorStop(1, `rgb(${Math.round(232 * light)}, ${Math.round(245 * light)}, ${Math.round(205 * light)})`);
    ctx.fillStyle = shade;
    ctx.fill(shape);
    // The midrib, and the leaf's edge a shade darker.
    ctx.strokeStyle = 'rgba(40, 60, 20, 0.35)';
    ctx.lineWidth = 2;
    ctx.stroke(shape);
    ctx.beginPath();
    ctx.moveTo(0, -2);
    ctx.lineTo(0, -length * 0.85);
    ctx.strokeStyle = 'rgba(60, 80, 30, 0.35)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * The cards' material: alpha-cut leaves, lit by the normal each card was given
 * (its clump's surface) rather than by its own flat face -- and by the same
 * one from behind as from in front, since a card seen from its back is still
 * the outside of the clump.
 */
function clumpMaterial(map) {
  const material = new THREE.MeshStandardMaterial({
    map,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.75,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute vec3 clumpNormal;\n${shader.vertexShader}`
      .replace('#include <defaultnormal_vertex>', 'vec3 transformedNormal = normalize( normalMatrix * clumpNormal );');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize( vNormal );
        nonPerturbedNormal = normal;`);
  };
  material.customProgramCacheKey = () => 'foliageClump';
  return material;
}

/**
 * One kind of potted plant's leaf as geometry: a strip up the midrib, a metre
 * long along +Y from its stalk at the origin, facing +Z, folded along the
 * midrib and its tip curled. Scaled to size per instance.
 */
function leafGeometry({ width, fold, curl }) {
  const positions = [];
  const indices = [];
  for (let row = 0; row <= LEAF_ROWS; row++) {
    const t = row / LEAF_ROWS;
    const half = width(t);
    const lift = curl * t * t;
    // Edge, midrib, edge: the edges stand forward of the rib -- the fold.
    positions.push(-half, t, lift + fold * half, 0, t, lift, half, t, lift + fold * half);
    if (row === 0) continue;
    const a = (row - 1) * 3;
    const b = row * 3;
    indices.push(a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A shuffle, in place, from the seeded stream. */
function shuffle(list, random) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * @param {THREE.Scene} scene
 * @param {object} opts
 * @param {object} opts.room  what room.js's addRoom returned: its walls, and
 *   the arched windows cut into them
 * @param {THREE.Box3} opts.floorBox  the walkable floor
 * @param {THREE.Box3} opts.deskBox
 * @param {THREE.Box3} opts.sofaBox
 * @param {THREE.Box3} opts.shelfBox  the bookshelf where it stands
 * @param {object} opts.mezzanine  what mezzanine.js's addMezzanine returned
 * @returns {{ group: THREE.Group, setDensity(share: number): void, dispose(): void }}
 */
export function addFoliage(scene, { room, floorBox, deskBox, sofaBox, shelfBox, mezzanine }) {
  const random = seeded(SEED);
  const between = (low, high) => low + (high - low) * random();
  const chance = (share) => random() < share;
  const jitter = (amount) => between(-amount, amount);

  const floorY = floorBox.min.y;
  const cards = [];
  const leaves = Object.fromEntries(Object.keys(LEAF_KINDS).map((kind) => [kind, []]));
  const stems = [];
  const pots = [];

  // --- clumps --------------------------------------------------------------------------
  const _local = new THREE.Vector3();
  const _normal = new THREE.Vector3();
  const _roll = new THREE.Quaternion();

  /**
   * A clump: an ellipsoid of leaf cards round `centre`, its three radii
   * along `axes` (x, y, z -- world directions, at right angles), most of its
   * cards near its surface. `lean` pulls every normal toward a direction --
   * into the room, for ivy flat on a wall -- `scale` sizes its cards, and
   * `tint` lightens or darkens the lot (1 as it comes).
   */
  function clump(centre, radii, {
    axes = [new THREE.Vector3(1, 0, 0), UP, Z_AXIS], lean = null, scale = 1, tint = 1,
  } = {}) {
    const [a, b, c] = radii;
    const [ex, ey, ez] = axes;
    // Roughly the ellipsoid's surface, over which the cards are spread.
    const surface = 4 * Math.PI * ((a * b + b * c + a * c) / 3);
    const count = THREE.MathUtils.clamp(Math.round(surface * CARDS_PER_M2), 3, 400);
    for (let i = 0; i < count; i++) {
      // A direction, uniformly, and a depth mostly out near the surface.
      const z = random() * 2 - 1;
      const phi = random() * Math.PI * 2;
      const ring = Math.sqrt(1 - z * z);
      const depth = 0.45 + 0.55 * Math.sqrt(random());
      _local.set(ring * Math.cos(phi), z, ring * Math.sin(phi)).multiplyScalar(depth);
      const at = centre.clone()
        .addScaledVector(ex, _local.x * a)
        .addScaledVector(ey, _local.y * b)
        .addScaledVector(ez, _local.z * c);
      // The ellipsoid's own normal there -- the light the card is given.
      _normal.set(0, 0, 0)
        .addScaledVector(ex, _local.x / a)
        .addScaledVector(ey, _local.y / b)
        .addScaledVector(ez, _local.z / c)
        .normalize();
      if (lean) _normal.addScaledVector(lean, 0.6).normalize();
      // The card's face: toward that normal, tipped a little, spun about it.
      const face = _normal.clone().add(new THREE.Vector3(jitter(CARD_TILT), jitter(CARD_TILT), jitter(CARD_TILT))).normalize();
      const turn = new THREE.Quaternion().setFromUnitVectors(Z_AXIS, face);
      turn.multiply(_roll.setFromAxisAngle(Z_AXIS, random() * Math.PI * 2));
      // Darker toward the heart, and underneath.
      const shade = (CLUMP_HEART + (1 - CLUMP_HEART) * (depth - 0.45) / 0.55)
        * (0.78 + 0.22 * (_normal.y * 0.5 + 0.5)) * tint;
      cards.push({
        at,
        turn,
        size: between(CARD_SIZE[0], CARD_SIZE[1]) * scale,
        normal: _normal.clone(),
        shade,
      });
    }
  }

  /**
   * Clumps along a path, one every `step` metres, their size following
   * `size(t)` (t 0 at the start, 1 at the end), for ivy up a jamb or a
   * cascade hanging off the balcony.
   */
  function clumpsAlong(points, step, make) {
    if (points.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(points);
    const length = curve.getLength();
    const count = Math.max(1, Math.round(length / step));
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      make(curve.getPointAt(t), curve.getTangentAt(t), t);
    }
  }

  // --- the windows ---------------------------------------------------------------------
  // In each window's own wall frame -- x along the wall, y up from the floor,
  // +z into the room -- and carried into the world by the wall itself.
  for (const row of room.windows ?? []) {
    const wall = room.walls[row.side];
    if (!wall || !row.arches) continue;
    wall.updateMatrixWorld(true);
    const along = new THREE.Vector3(1, 0, 0).transformDirection(wall.matrixWorld);
    const inward = new THREE.Vector3(0, 0, 1).transformDirection(wall.matrixWorld);
    const toWorld = (x, y, z) => wall.localToWorld(new THREE.Vector3(x, y, z));
    const flat = [along, UP, inward];
    // A window over the desk starts on its sill; a low one climbs from the floor.
    const fromFloor = row.sill < 1.2;

    /**
     * Ivy up one side of an arched window and over it. Every climb its own:
     * how vigorous it is, how gappy, how flat to the wall, how far it wanders,
     * its shade of green -- and how it ends: part way up the arch, over the
     * top and some way down the far side, or with a trail hanging off the
     * arch in front of the glass.
     */
    function growIvy(arch, left) {
      const vigour = between(0.55, 1.5);
      const gaps = between(0, 0.35);
      const flatness = between(0.45, 0.85);
      const wander = between(0.02, 0.07);
      const tint = between(0.8, 1.15);
      const x = left ? arch.left - WINDOW_FRAME.width / 2 : arch.right + WINDOW_FRAME.width / 2;
      const z = WINDOW_FRAME.depth;
      const centreX = (arch.left + arch.right) / 2;
      const r = arch.radius + WINDOW_FRAME.width / 2;
      const along = (angle) => toWorld(centreX + Math.cos(angle) * r, arch.spring + Math.sin(angle) * r, z);

      // Up the jamb -- from the floor, or from the sill for some even when the
      // floor is there to start from.
      const points = [];
      const start = fromFloor && chance(0.65) ? 0.15 : arch.sill + between(0, 0.2);
      for (let y = start; y < arch.spring; y += 0.25) points.push(toWorld(x + jitter(wander), y, z));
      // Over the arch, as far as it gets...
      const over = chance(0.3) ? Math.PI : between(0.3, 0.95) * Math.PI;
      for (let a = 0.15; a <= over; a += 0.22) points.push(along(left ? Math.PI - a : a));
      // ...and, having crossed it, some way down the far side.
      if (over >= Math.PI) {
        const farX = left ? arch.right + WINDOW_FRAME.width / 2 : arch.left - WINDOW_FRAME.width / 2;
        const down = between(0.3, Math.max(0.35, (arch.spring - arch.sill) * 0.7));
        for (let y = arch.spring; y >= arch.spring - down; y -= 0.25) {
          points.push(toWorld(farX + jitter(wander), y, z));
        }
      }

      clumpsAlong(points, 0.14 / Math.sqrt(vigour), (at, _, t) => {
        if (t > 0.05 && random() < gaps) return;
        const bulge = chance(0.12) ? between(1.3, 1.7) : 1;
        const size = THREE.MathUtils.lerp(fromFloor ? 0.24 : 0.17, 0.09, t)
          * vigour ** 0.5 * bulge * between(0.7, 1.3);
        clump(at.addScaledVector(inward, size * 0.45), [
          size * between(0.8, 1.3), size * between(0.8, 1.3), size * flatness,
        ], { axes: flat, lean: inward, scale: THREE.MathUtils.lerp(1, 0.7, t), tint });
      });

      // A trail hanging off the arch in front of the glass.
      if (chance(0.3)) {
        const from = along(left ? Math.PI - Math.min(over, Math.PI) * between(0.4, 0.9) : Math.min(over, Math.PI) * between(0.4, 0.9));
        const drop = between(0.2, 0.7);
        clumpsAlong([
          from.clone().addScaledVector(inward, 0.06),
          from.clone().addScaledVector(inward, 0.08).addScaledVector(UP, -drop * 0.5),
          from.clone().addScaledVector(inward, 0.07).addScaledVector(UP, -drop),
        ], 0.08, (at, _, t) => {
          const size = THREE.MathUtils.lerp(0.09, 0.04, t);
          clump(at, [size, size * 1.3, size * 0.8], { axes: flat, lean: inward, scale: 0.7, tint });
        });
      }
    }

    for (const arch of row.arches) {
      if (chance(WINDOW_SHARE)) {
        const sides = chance(0.3) ? ['left', 'right'] : [chance(0.5) ? 'left' : 'right'];
        for (const side of sides) growIvy(arch, side === 'left');
      }

      // Heaped on a low sill, spilling a little over its front.
      if (fromFloor && chance(SILL_SHARE)) {
        const x = between(arch.left + 0.1, arch.right - 0.1);
        const width = Math.min(0.3, (arch.right - arch.left) * 0.45);
        clump(toWorld(x, arch.sill + 0.06, WINDOW_SILL_PROJECTION * 0.5),
          [width, 0.13, WINDOW_SILL_PROJECTION * 0.7], { axes: flat, lean: inward });
        clumpsAlong([
          toWorld(x, arch.sill, WINDOW_SILL_PROJECTION + 0.03),
          toWorld(x + jitter(0.05), arch.sill - between(0.15, 0.35), 0.06),
        ], 0.09, (at, _, t) => {
          const size = THREE.MathUtils.lerp(0.09, 0.05, t);
          clump(at, [size, size * 1.3, size * 0.7], { axes: flat, lean: inward, scale: 0.75 });
        });
      }
    }
  }

  // --- the balcony ---------------------------------------------------------------------
  if (mezzanine?.edges) {
    const { deckY, underY, railHeight, railInset } = mezzanine;
    const longest = Math.max(0.3, (underY - floorY) - 0.6);

    for (const edge of mezzanine.edges) {
      const out = new THREE.Vector3(edge.outward[0], 0, edge.outward[1]);
      const length = Math.hypot(edge.bx - edge.ax, edge.bz - edge.az);
      const along = new THREE.Vector3(edge.bx - edge.ax, 0, edge.bz - edge.az).normalize();
      const axes = [along, UP, out];
      const onEdge = (s, y) => new THREE.Vector3(edge.ax, y, edge.az).addScaledVector(along, s);

      // A hedge along the rail -- as if planted along the balcony and grown
      // up through the balusters and over the top.
      for (let s = 0.1; s < length; s += RAIL_STEP * between(0.7, 1.2)) {
        if (!chance(RAIL_SHARE)) continue;
        const reach = between(0.25, 0.45);
        clump(onEdge(s, deckY + railHeight * between(0.55, 1.05)).addScaledVector(out, between(0, 0.08)),
          [reach, between(0.2, 0.34), between(0.15, 0.26)], { axes });
      }

      // Masses tucked under the deck's edge, where the hedge spills over.
      const lip = railInset + 0.08;
      for (let s = 0.2; s < length; s += RAIL_STEP * between(1, 1.6)) {
        if (!chance(SPILL_SHARE)) continue;
        clump(onEdge(s, deckY - between(0.05, 0.15)).addScaledVector(out, lip),
          [between(0.22, 0.38), between(0.18, 0.28), between(0.12, 0.18)], { axes });
      }

      // And trailing off it into the room below: chains of clumps, each smaller
      // than the one above it, swaying a little as they hang.
      for (let s = 0.2; s < length - 0.1; s += CASCADE_STEP * between(0.6, 1)) {
        if (!chance(CASCADE_SHARE)) continue;
        const hang = Math.min(longest,
          CASCADE_LENGTH[0] + (CASCADE_LENGTH[1] - CASCADE_LENGTH[0]) * random() ** 1.5);
        const phase = random() * Math.PI * 2;
        const top = onEdge(s, underY).addScaledVector(out, lip + 0.04);
        const points = [];
        for (let d = 0; d <= hang; d += 0.2) {
          points.push(top.clone()
            .addScaledVector(along, Math.sin(phase + d * 2.6) * 0.06)
            .addScaledVector(out, d * 0.04)
            .setY(underY - d));
        }
        clumpsAlong(points, 0.09, (at, _, t) => {
          const size = THREE.MathUtils.lerp(0.13, 0.05, t) * between(0.85, 1.15);
          clump(at, [size, size * 1.25, size], { axes, lean: out, scale: THREE.MathUtils.lerp(0.9, 0.6, t) });
        });
      }
    }

    // Along the stair's handrails, curving up with them: clumps on and round
    // the rail, and now and then something trailing down its open side.
    for (const rail of mezzanine.stairRails ?? []) {
      const curve = new THREE.CatmullRomCurve3(rail.points);
      const length = curve.getLength();
      for (let s = 0.15; s < length - 0.1; s += STAIR_STEP * between(0.7, 1.3)) {
        if (!chance(STAIR_SHARE)) continue;
        const t = s / length;
        const at = curve.getPointAt(t);
        const tangent = curve.getTangentAt(t);
        // The way out over the rail here, from the nearest of its points.
        const out = rail.outward[Math.round(t * (rail.outward.length - 1))].clone();
        const lift = new THREE.Vector3().crossVectors(out, tangent).normalize();
        if (lift.y < 0) lift.negate();
        const axes = [tangent, lift, out];
        const size = between(0.16, 0.3);
        clump(at.clone().addScaledVector(out, between(0, 0.06)).addScaledVector(UP, jitter(0.12)),
          [size * between(1, 1.6), size * between(0.7, 1), size * between(0.6, 0.9)], { axes });

        // Trailing down its open side, short enough to clear the floor.
        const clearance = at.y - floorY - 0.4;
        if (clearance > 0.3 && chance(STAIR_CASCADE_SHARE)) {
          const hang = Math.min(clearance, between(0.25, 0.9));
          const top = at.clone().addScaledVector(out, 0.1).addScaledVector(UP, -0.1);
          clumpsAlong([
            top,
            top.clone().addScaledVector(out, 0.03).addScaledVector(UP, -hang * 0.5),
            top.clone().addScaledVector(out, 0.05).addScaledVector(UP, -hang),
          ], 0.09, (point, _, k) => {
            const bit = THREE.MathUtils.lerp(0.11, 0.045, k);
            clump(point, [bit, bit * 1.3, bit], { lean: out, scale: THREE.MathUtils.lerp(0.85, 0.6, k) });
          });
        }
      }
    }

    // Ivy up some of the posts: thick at the foot, thinning toward the deck.
    const around = mezzanine.postSize / 2;
    for (const post of mezzanine.posts ?? []) {
      if (!chance(POST_SHARE)) continue;
      const top = underY - between(0.1, 0.8);
      const phase = random() * Math.PI * 2;
      for (let y = floorY + 0.15; y <= top; y += 0.16) {
        const t = (y - floorY) / (top - floorY);
        const phi = phase + t * between(2, 3) * Math.PI;
        const outward = new THREE.Vector3(Math.cos(phi), 0, Math.sin(phi));
        const size = THREE.MathUtils.lerp(0.2, 0.09, t) * between(0.8, 1.2);
        clump(new THREE.Vector3(post.x, y, post.z).addScaledVector(outward, around + size * 0.5),
          [size, size * 1.2, size], { lean: outward, scale: THREE.MathUtils.lerp(1, 0.7, t) });
      }
    }
  }

  // --- the potted plants ---------------------------------------------------------------
  /** A potted plant's leaf: its stalk at `at`, pointing along `dir`, its face toward `facing`. */
  function leaf(kind, at, dir, facing, size) {
    leaves[kind].push({ at: at.clone(), dir: dir.clone().normalize(), facing: facing.clone(), size });
  }

  /**
   * A pot on the ground at (x, y, z): a turned profile, flared a little to its
   * rim, with soil a little below it. Returns the soil's middle, which is
   * where the plant grows from.
   */
  function pot(x, y, z, radius, height, colour) {
    const base = radius * 0.78;
    const lip = radius * 1.08;
    const inner = radius * 0.94;
    const soil = height - 0.05;
    const geometry = new THREE.LatheGeometry([
      new THREE.Vector2(0, 0),
      new THREE.Vector2(base, 0),
      new THREE.Vector2(radius, height - 0.045),
      new THREE.Vector2(lip, height - 0.04),
      new THREE.Vector2(lip, height),
      new THREE.Vector2(inner, height),
      new THREE.Vector2(inner, soil),
      new THREE.Vector2(0, soil),
    ], 28);
    const potColour = new THREE.Color(colour);
    const dirt = new THREE.Color(SOIL_COLOUR);
    const position = geometry.getAttribute('position');
    const colours = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      const isSoil = Math.abs(position.getY(i) - soil) < 1e-3
        && Math.hypot(position.getX(i), position.getZ(i)) < inner - 1e-3;
      (isSoil ? dirt : potColour).toArray(colours, i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.translate(x, y, z);
    pots.push(geometry);
    return new THREE.Vector3(x, y + soil, z);
  }

  /** A fiddle-leaf fig: a leaning trunk, a branch or two, big leaves up top. */
  function fig(x, z, y = floorY, tall = between(1.6, 2)) {
    const soil = pot(x, y, z, 0.22, 0.42, POT_COLOURS.terracotta);
    const lean = new THREE.Vector3(jitter(0.12), 0, jitter(0.12));
    const trunk = [0, 0.3, 0.6, 1].map((f) => soil.clone()
      .addScaledVector(UP, f * tall)
      .addScaledVector(lean, f * f)
      .add(new THREE.Vector3(jitter(0.03), 0, jitter(0.03))));
    const limbs = [trunk];
    const branches = chance(0.5) ? 2 : 1;
    for (let b = 0; b < branches; b++) {
      const curve = new THREE.CatmullRomCurve3(trunk);
      const from = curve.getPointAt(between(0.5, 0.7));
      const angle = random() * Math.PI * 2;
      const outward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const reach = between(0.35, 0.6);
      limbs.push([
        from,
        from.clone().addScaledVector(outward, reach * 0.5).addScaledVector(UP, reach * 0.4),
        from.clone().addScaledVector(outward, reach).addScaledVector(UP, reach * 0.9),
      ]);
    }
    limbs.forEach((points, i) => {
      const curve = new THREE.CatmullRomCurve3(points);
      stems.push(new THREE.TubeGeometry(curve, 16, i === 0 ? 0.018 : 0.012, 6, false));
      // Leaves up the top of each limb, spiralling round it.
      const count = Math.round(curve.getLength() / 0.06);
      for (let k = 0; k < count; k++) {
        const t = (k + 0.5) / count;
        if (i === 0 && t < 0.4) continue;
        const at = curve.getPointAt(t);
        const angle = k * 2.4 + random() * 0.5;
        const outward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
        leaf('broad', at,
          outward.clone().addScaledVector(UP, between(0.1, 0.7)),
          UP.clone().addScaledVector(outward, 0.35),
          between(0.2, 0.32) * (1 - 0.3 * t * (i === 0 ? 1 : 0.5)));
      }
    });
  }

  /** A palm: arching fronds of narrow leaflets, from one crown. */
  function palm(x, z, y = floorY, spread = between(0.9, 1.25)) {
    const soil = pot(x, y, z, 0.2, 0.38, POT_COLOURS.cream);
    const fronds = Math.round(between(10, 14));
    for (let f = 0; f < fronds; f++) {
      const angle = (f / fronds) * Math.PI * 2 + jitter(0.3);
      const outward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const length = spread * between(0.7, 1.1);
      const rise = between(0.8, 1.3);
      const points = [];
      for (let s = 0; s <= 1.0001; s += 0.2) {
        points.push(soil.clone()
          .addScaledVector(outward, length * s * 0.85)
          .addScaledVector(UP, length * rise * (1.05 * s - 0.75 * s * s) + 0.05));
      }
      const curve = new THREE.CatmullRomCurve3(points);
      stems.push(new THREE.TubeGeometry(curve, 14, 0.006, 5, false));
      const count = Math.round(curve.getLength() / 0.04);
      for (let k = 0; k < count; k++) {
        const t = (k + 0.5) / count;
        if (t < 0.15) continue;
        const at = curve.getPointAt(t);
        const tangent = curve.getTangentAt(t);
        for (const sign of [-1, 1]) {
          const side = new THREE.Vector3().crossVectors(tangent, UP).normalize().multiplyScalar(sign);
          leaf('leaflet', at,
            side.clone().multiplyScalar(0.75).addScaledVector(tangent, 0.55).addScaledVector(UP, -0.35),
            UP.clone().addScaledVector(side, 0.2),
            between(0.18, 0.26) * (1 - 0.5 * t));
        }
      }
    }
  }

  /** A snake plant: a sheaf of upright blades. */
  function snakePlant(x, z, y = floorY) {
    const soil = pot(x, y, z, 0.16, 0.32, POT_COLOURS.slate);
    const blades = Math.round(between(12, 17));
    for (let b = 0; b < blades; b++) {
      const angle = random() * Math.PI * 2;
      const outward = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
      const at = soil.clone().addScaledVector(outward, random() * 0.1);
      leaf('blade', at,
        UP.clone().addScaledVector(outward, between(0.05, 0.3)),
        outward.clone().applyAxisAngle(UP, jitter(1.2)),
        between(0.45, 0.85));
    }
  }

  /**
   * A pothos on a high shelf: a mound in its pot, trailing over the shelf's
   * edges in cascades. `over` is each edge and which way is out over it, e.g.
   * { at: x, axis: 'x', out: 1 }.
   */
  function pothos(x, z, y, over) {
    const soil = pot(x, y, z, 0.12, 0.14, POT_COLOURS.terracotta);
    clump(soil.clone().addScaledVector(UP, 0.06), [0.2, 0.12, 0.2]);
    const trails = Math.round(between(4, 6));
    for (let v = 0; v < trails; v++) {
      const edge = over[v % over.length];
      const outward = new THREE.Vector3();
      outward[edge.axis] = edge.out;
      const lip = soil.clone().setY(y + 0.03);
      lip[edge.axis] = edge.at + edge.out * 0.06;
      lip[edge.axis === 'x' ? 'z' : 'x'] += jitter(0.18);
      const drop = between(0.35, 1.2);
      const points = [soil.clone().addScaledVector(UP, 0.05), lip];
      for (let d = 0.15; d <= drop; d += 0.15) {
        const p = lip.clone().setY(y - d);
        p[edge.axis] = edge.at + edge.out * (0.07 + d * 0.02);
        p[edge.axis === 'x' ? 'z' : 'x'] += jitter(0.04);
        points.push(p);
      }
      clumpsAlong(points, 0.08, (at, _, t) => {
        const size = THREE.MathUtils.lerp(0.1, 0.045, t);
        clump(at, [size, size * 1.2, size], { lean: outward, scale: THREE.MathUtils.lerp(0.8, 0.55, t) });
      });
    }
  }

  // --- where they stand -----------------------------------------------------------------
  // In from the walls by about a pot's width, at the ends of things rather
  // than in anyone's way.
  const inset = 0.45;
  // The corner where the desk's window wall meets the back wall: by the windows.
  fig(floorBox.max.x - inset, floorBox.min.z + inset);
  // Beside the sofa, at its far end.
  palm((sofaBox.min.x + sofaBox.max.x) / 2, sofaBox.max.z + 0.55);
  // Beside the desk, on the back-wall side of it, against the window wall.
  snakePlant(floorBox.max.x - 0.3, deskBox.min.z - 0.35);
  if (mezzanine?.arms) {
    const { long, door } = mezzanine.arms;
    // Up on the balcony: in the corner of the long arm, where the two meet...
    palm(long.minX + 0.4, long.maxZ - 0.4, mezzanine.deckY, between(0.7, 0.9));
    // ...and at the far end of the arm over the door, by the rail.
    fig(door.maxX - 0.45, door.minZ + 0.45, mezzanine.deckY, between(1.2, 1.5));
  }
  // On top of the bookshelf, at its end, trailing over the front and the side.
  pothos(shelfBox.max.x - 0.18, shelfBox.max.z - 0.2, shelfBox.max.y, [
    { at: shelfBox.max.x, axis: 'x', out: 1 },
    { at: shelfBox.max.z, axis: 'z', out: 1 },
  ]);

  // --- into meshes ----------------------------------------------------------------------
  const group = new THREE.Group();
  group.name = 'foliage';
  const instanced = [];
  const _matrix = new THREE.Matrix4();
  const _scale = new THREE.Vector3();
  const _colour = new THREE.Color();
  const _low = new THREE.Color();
  const _high = new THREE.Color();

  // The clumps' cards: one quad, instanced, each carrying its clump's normal.
  const cardTexture = leafCardTexture(random);
  const cardMaterial = clumpMaterial(cardTexture);
  shuffle(cards, random);
  const cardGeometry = new THREE.PlaneGeometry(1, 1);
  const normals = new Float32Array(cards.length * 3);
  const cardMesh = new THREE.InstancedMesh(cardGeometry, cardMaterial, cards.length);
  cardMesh.name = 'foliageClumps';
  _low.setHex(CLUMP_COLOURS[0]);
  _high.setHex(CLUMP_COLOURS[1]);
  cards.forEach((card, i) => {
    _matrix.compose(card.at, card.turn, _scale.setScalar(card.size));
    cardMesh.setMatrixAt(i, _matrix);
    cardMesh.setColorAt(i, _colour.copy(_low).lerp(_high, random()).multiplyScalar(card.shade));
    card.normal.toArray(normals, i * 3);
  });
  cardGeometry.setAttribute('clumpNormal', new THREE.InstancedBufferAttribute(normals, 3));
  cardMesh.castShadow = true;
  cardMesh.receiveShadow = true;
  cardMesh.computeBoundingSphere();
  group.add(cardMesh);
  instanced.push(cardMesh);

  // The potted plants' leaves: one bent leaf per kind, instanced.
  const leafMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.6, metalness: 0, side: THREE.DoubleSide,
  });
  const _x = new THREE.Vector3();
  const _y = new THREE.Vector3();
  const _z = new THREE.Vector3();
  const _size = new THREE.Matrix4();
  for (const [kind, list] of Object.entries(leaves)) {
    if (!list.length) continue;
    shuffle(list, random);
    const spec = LEAF_KINDS[kind];
    const mesh = new THREE.InstancedMesh(leafGeometry(spec), leafMaterial, list.length);
    mesh.name = `leaves-${kind}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    _low.setHex(spec.colours[0]);
    _high.setHex(spec.colours[1]);
    list.forEach((one, i) => {
      // The leaf's length along its pointing, its face as near the facing as
      // that allows, and the third axis across it.
      _y.copy(one.dir);
      _z.copy(one.facing).addScaledVector(_y, -one.facing.dot(_y));
      if (_z.lengthSq() < 1e-6) _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
      _z.normalize();
      _x.crossVectors(_y, _z);
      _matrix.makeBasis(_x, _y, _z).multiply(_size.makeScale(one.size, one.size, one.size));
      _matrix.setPosition(one.at);
      mesh.setMatrixAt(i, _matrix);
      mesh.setColorAt(i, _colour.copy(_low).lerp(_high, random()));
    });
    mesh.computeBoundingSphere();
    group.add(mesh);
    instanced.push(mesh);
  }

  const stemMesh = stems.length ? new THREE.Mesh(
    mergeGeometries(stems, false),
    new THREE.MeshStandardMaterial({ color: STEM_COLOUR, roughness: 0.8, metalness: 0 }),
  ) : null;
  for (const geometry of stems) geometry.dispose();
  if (stemMesh) {
    stemMesh.name = 'stems';
    stemMesh.castShadow = true;
    stemMesh.receiveShadow = true;
    group.add(stemMesh);
  }

  const potMesh = pots.length ? new THREE.Mesh(
    mergeGeometries(pots, false),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
  ) : null;
  for (const geometry of pots) geometry.dispose();
  if (potMesh) {
    potMesh.name = 'pots';
    potMesh.castShadow = true;
    potMesh.receiveShadow = true;
    group.add(potMesh);
  }

  scene.add(group);

  const totals = instanced.map((mesh) => mesh.count);
  const leafCount = totals.slice(1).reduce((a, b) => a + b, 0);
  console.info(`Foliage: ${cards.length} cards of leaves in clumps, ${leafCount} potted-plant leaves, ${pots.length} pots.`);

  return {
    group,

    /**
     * Draw this share (0..1) of the cards and leaves -- the graphics
     * quality's (state/quality.js's foliageDensity). Stems and pots stay whole.
     */
    setDensity(share) {
      const keep = THREE.MathUtils.clamp(share, 0, 1);
      instanced.forEach((mesh, i) => { mesh.count = Math.round(totals[i] * keep); });
    },

    dispose() {
      scene.remove(group);
      for (const mesh of instanced) {
        mesh.geometry.dispose();
        mesh.dispose();
      }
      cardMaterial.dispose();
      cardTexture.dispose();
      leafMaterial.dispose();
      stemMesh?.geometry.dispose();
      stemMesh?.material.dispose();
      potMesh?.geometry.dispose();
      potMesh?.material.dispose();
    },
  };
}
