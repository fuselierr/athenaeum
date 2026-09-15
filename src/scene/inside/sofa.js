import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FURNITURE_SCALE } from '../worldScale.js';

/**
 * The sofa in the middle of the room, to sit on anywhere: right-click any part
 * of it and you sit down on the seat there (input/cameraModes.js's sitOn).
 *
 * "sofa" by MaX3Dd, CC-BY-4.0 --
 * https://sketchfab.com/3d-models/sofa-33a982d268d749ddb803263ea7da84b0
 *
 * SIZE. Authored in metres -- 2.6 long, 1.75 deep with its chaise, 0.8 to the
 * top of its back -- and drawn at the scene's shared furniture scale
 * (scene/worldScale.js).
 *
 * WHERE YOU CAN SIT is measured off the model, as a height map: the top of the
 * sofa looking straight down, in 5 cm cells. The height most of it is at is the
 * seat; anything well above that is a back or an arm. A cell is somewhere to
 * sit if it is at seat height with nothing raised between it and the front --
 * so the cushions and the chaise are, and the strip behind the back is not.
 * Which way is the front is measured too: from the raised parts toward the seat.
 *
 * A right-click anywhere on it -- the back, an arm, the chaise -- sits you on
 * the nearest of those cells, eased off a back or an arm so you are not sat
 * inside one, facing the sofa's front; you get up onto the floor in front of
 * wherever you sat.
 *
 * THE BOOK lands on it too: the same height map, merged into boxes, is handed
 * to the book's placement physics (book/placement/bookPlacement.js's obstacles).
 */

const SOFA_URL = '/sofa.glb';
const SCALE = FURNITURE_SCALE;

// World units -- the same units the camera's eye height is in.
const CELL = 0.05 * SCALE; // the height map's cells
const SEATED_EYE = 0.7; // the eye above the top of the seat
const ABOVE_SEAT = 0.15 * SCALE; // this far over the seat, a cell is a back or an arm
const BELOW_SEAT = 0.15 * SCALE; // a dip this deep between cushions is still seat
const SIT_CLEAR = 0.25 * SCALE; // how far the middle of you sits from a back or an arm
const STAND_OFF = 0.35; // past the front edge, where you get up to
const SIT_REACH = 4; // how near a right-click has to be to sit you down
const COLLISION_CELLS = 2; // height-map cells to a collision cell, each way
const COLLISION_STEP = 0.05 * SCALE; // collision heights rounded to this, so neighbours merge

const EMPTY = 0;
const SEAT_HEIGHT = 1;
const RAISED = 2;

/** Which way a direction faces, as a camera yaw: 0 along -Z. */
const heading = (direction) => Math.atan2(-direction.x, -direction.z);

/** Whether an object is drawn -- it and everything it hangs under. */
function shown(object) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/**
 * The highest point of `object` over each cell of `box`'s footprint, in the
 * object's own frame: -Infinity where there is nothing. Every triangle is
 * sampled finely enough that none slips between cells.
 */
function measureTops(object, box) {
  const nx = Math.max(1, Math.ceil((box.max.x - box.min.x) / CELL));
  const nz = Math.max(1, Math.ceil((box.max.z - box.min.z) / CELL));
  const tops = new Float32Array(nx * nz).fill(-Infinity);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  object.traverse((child) => {
    if (!child.isMesh) return;
    const position = child.geometry.attributes.position;
    const index = child.geometry.index;
    const count = index ? index.count : position.count;
    const vertex = (i, target) => target
      .fromBufferAttribute(position, index ? index.getX(i) : i)
      .applyMatrix4(child.matrixWorld);

    for (let t = 0; t + 2 < count; t += 3) {
      vertex(t, a);
      vertex(t + 1, b);
      vertex(t + 2, c);
      const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
      const steps = Math.min(64, Math.max(1, Math.ceil(longest / (CELL * 0.5))));
      for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps - i; j++) {
          const u = i / steps;
          const v = j / steps;
          const w = 1 - u - v;
          const cx = Math.floor((a.x * w + b.x * u + c.x * v - box.min.x) / CELL);
          const cz = Math.floor((a.z * w + b.z * u + c.z * v - box.min.z) / CELL);
          if (cx < 0 || cz < 0 || cx >= nx || cz >= nz) continue;
          const y = a.y * w + b.y * u + c.y * v;
          const k = cz * nx + cx;
          if (y > tops[k]) tops[k] = y;
        }
      }
    }
  });
  return { nx, nz, tops };
}

/**
 * The height map as boxes standing on the floor, in the object's frame: the
 * cells coarsened, their heights rounded, and runs of the same height merged
 * along rows and then down them.
 */
function collisionBoxes({ nx, nz, tops }, box) {
  const cnx = Math.ceil(nx / COLLISION_CELLS);
  const cnz = Math.ceil(nz / COLLISION_CELLS);
  const levels = new Int32Array(cnx * cnz);
  for (let cz = 0; cz < nz; cz++) {
    for (let cx = 0; cx < nx; cx++) {
      const top = tops[cz * nx + cx];
      if (!Number.isFinite(top)) continue;
      const k = Math.floor(cz / COLLISION_CELLS) * cnx + Math.floor(cx / COLLISION_CELLS);
      levels[k] = Math.max(levels[k], Math.round(top / COLLISION_STEP));
    }
  }

  const size = CELL * COLLISION_CELLS;
  const boxes = [];
  let open = new Map();
  for (let z = 0; z < cnz; z++) {
    const next = new Map();
    for (let x = 0; x < cnx;) {
      const level = levels[z * cnx + x];
      let end = x + 1;
      while (end < cnx && levels[z * cnx + end] === level) end++;
      if (level > 0) {
        const key = `${x},${end},${level}`;
        let run = open.get(key);
        if (run) run.z1 = z + 1;
        else boxes.push(run = { x0: x, x1: end, z0: z, z1: z + 1, level });
        next.set(key, run);
      }
      x = end;
    }
    open = next;
  }

  return boxes.map(({ x0, x1, z0, z1, level }) => new THREE.Box3(
    new THREE.Vector3(box.min.x + x0 * size, 0, box.min.z + z0 * size),
    new THREE.Vector3(
      Math.min(box.max.x, box.min.x + x1 * size),
      level * COLLISION_STEP,
      Math.min(box.max.z, box.min.z + z1 * size),
    ),
  ));
}

/**
 * Load the sofa into the scene. It stands at the origin, unseen by clicks,
 * until place().
 *
 * @returns {Promise<{ object: THREE.Group,
 *   collision: Array<{ center: {x,y,z}, halfExtents: {x,y,z} }>,
 *   place(opts: { x: number, y: number, z: number, facing: THREE.Vector3 }): void,
 *   seatUnder(event: PointerEvent, opts: { camera: THREE.Camera, dom: HTMLElement,
 *     occluders?: THREE.Object3D[] }): object|null }>}
 */
export async function loadSofa(scene) {
  const gltf = await new GLTFLoader().loadAsync(SOFA_URL);
  const model = gltf.scene;
  model.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
  });

  // Scaled, then moved so the middle of its footprint is the group's origin
  // and its feet are at the group's floor.
  model.scale.setScalar(SCALE);
  model.updateMatrixWorld(true);
  const rawBox = new THREE.Box3().setFromObject(model);
  const middle = rawBox.getCenter(new THREE.Vector3());
  model.position.set(-middle.x, -rawBox.min.y, -middle.z);

  const object = new THREE.Group();
  object.name = 'sofa';
  object.add(model);
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());

  // --- where to sit, measured ---------------------------------------------------------
  const map = measureTops(object, box);
  const { nx, nz, tops } = map;

  // The seat's height: the commonest height, leaving out the very low and the
  // very high -- the seat is the biggest flat part of any sofa.
  const BIN = 0.03 * SCALE;
  const counts = new Map();
  let seatLevel = size.y * 0.5;
  let most = 0;
  for (const top of tops) {
    if (!Number.isFinite(top) || top < size.y * 0.2 || top > size.y * 0.8) continue;
    const bin = Math.round(top / BIN);
    const n = (counts.get(bin) ?? 0) + 1;
    counts.set(bin, n);
    if (n > most) { most = n; seatLevel = bin * BIN; }
  }

  const kind = new Uint8Array(nx * nz);
  for (let k = 0; k < tops.length; k++) {
    const top = tops[k];
    if (top > seatLevel + ABOVE_SEAT) kind[k] = RAISED;
    else if (top >= seatLevel - BELOW_SEAT) kind[k] = SEAT_HEIGHT;
  }

  const cellOf = (x, z) => {
    const cx = Math.floor((x - box.min.x) / CELL);
    const cz = Math.floor((z - box.min.z) / CELL);
    return cx < 0 || cz < 0 || cx >= nx || cz >= nz ? -1 : cz * nx + cx;
  };
  const centreOf = (k, target) => target.set(
    box.min.x + ((k % nx) + 0.5) * CELL,
    0,
    box.min.z + (Math.floor(k / nx) + 0.5) * CELL,
  );

  // Forward: from the raised parts toward the seat, squared up to the nearest
  // of the model's own axes. Without both to measure, this sofa's own front, +Z.
  const seatMiddle = new THREE.Vector3();
  const raisedMiddle = new THREE.Vector3();
  const _cell = new THREE.Vector3();
  let seatCells = 0;
  let raisedCells = 0;
  for (let k = 0; k < kind.length; k++) {
    if (kind[k] === SEAT_HEIGHT) { seatMiddle.add(centreOf(k, _cell)); seatCells++; }
    if (kind[k] === RAISED) { raisedMiddle.add(centreOf(k, _cell)); raisedCells++; }
  }
  const forward = new THREE.Vector3(0, 0, 1);
  if (seatCells && raisedCells) {
    const dx = seatMiddle.x / seatCells - raisedMiddle.x / raisedCells;
    const dz = seatMiddle.z / seatCells - raisedMiddle.z / raisedCells;
    if (Math.abs(dx) > Math.abs(dz)) forward.set(Math.sign(dx) || 1, 0, 0);
    else forward.set(0, 0, Math.sign(dz) || 1);
  }
  const step = { x: Math.round(forward.x), z: Math.round(forward.z) };
  const side = new THREE.Vector3(-forward.z, 0, forward.x);
  const back = forward.clone().negate();

  // Somewhere to sit: at seat height, and open to the front.
  const seat = new Uint8Array(nx * nz);
  for (let k = 0; k < kind.length; k++) {
    if (kind[k] !== SEAT_HEIGHT) continue;
    let cx = k % nx;
    let cz = Math.floor(k / nx);
    let open = true;
    while (cx >= 0 && cz >= 0 && cx < nx && cz < nz) {
      if (kind[cz * nx + cx] === RAISED) { open = false; break; }
      cx += step.x;
      cz += step.z;
    }
    seat[k] = open ? 1 : 0;
  }

  const localBoxes = collisionBoxes(map, box);

  /** Where you sit for a point on the sofa, in its own frame: world pose, or null. */
  function seatAt(local) {
    let nearest = -1;
    let nearestSq = Infinity;
    for (let k = 0; k < seat.length; k++) {
      if (!seat[k]) continue;
      centreOf(k, _cell);
      const d = (_cell.x - local.x) ** 2 + (_cell.z - local.z) ** 2;
      if (d < nearestSq) { nearestSq = d; nearest = k; }
    }
    if (nearest < 0) return null;

    // Eased off a back behind you, or an arm to either side.
    const spot = centreOf(nearest, new THREE.Vector3());
    for (const away of [back, side, side.clone().negate()]) {
      let clear = SIT_CLEAR;
      for (let d = CELL * 0.5; d <= SIT_CLEAR; d += CELL * 0.5) {
        const k = cellOf(spot.x + away.x * d, spot.z + away.z * d);
        if (k >= 0 && kind[k] === RAISED) { clear = d; break; }
      }
      if (clear >= SIT_CLEAR) continue;
      const moved = spot.clone().addScaledVector(away, clear - SIT_CLEAR);
      const k = cellOf(moved.x, moved.z);
      if (k >= 0 && seat[k]) spot.copy(moved);
    }

    // Up onto the floor just past the front edge in front of you.
    let edge = 0;
    for (;;) {
      const k = cellOf(spot.x + forward.x * edge, spot.z + forward.z * edge);
      if (k < 0 || kind[k] === EMPTY) break;
      edge += CELL * 0.5;
    }
    const top = tops[cellOf(spot.x, spot.z)];
    const eye = object.localToWorld(new THREE.Vector3(spot.x, top + SEATED_EYE, spot.z));
    const stand = object.localToWorld(spot.clone().addScaledVector(forward, edge + STAND_OFF));
    const facing = forward.clone().transformDirection(object.matrixWorld);
    return { eye, yaw: heading(facing), standAt: { x: stand.x, z: stand.z } };
  }

  const _raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _facing = new THREE.Vector3();
  let placed = false;

  scene.add(object);

  const sofa = {
    object,

    /**
     * The sofa as boxes standing on the floor, world space, for the book's
     * placement physics. Empty until place().
     */
    collision: [],

    /**
     * Stand it with the middle of its footprint at (x, z) on a floor at `y`,
     * its front turned toward `facing` -- a quarter turn at a time, so it stays
     * square to the walls.
     */
    place({ x, y, z, facing }) {
      _facing.set(facing.x, 0, facing.z);
      if (_facing.lengthSq() < 1e-8) _facing.copy(forward);
      const quarter = Math.PI / 2;
      const turn = heading(_facing) - heading(forward);
      object.rotation.set(0, Math.round(turn / quarter) * quarter, 0);
      object.position.set(x, y, z);
      object.updateMatrixWorld(true);

      const corner = new THREE.Vector3();
      sofa.collision = localBoxes.map((local) => {
        const world = new THREE.Box3()
          .expandByPoint(object.localToWorld(corner.copy(local.min)))
          .expandByPoint(object.localToWorld(corner.copy(local.max)));
        const center = world.getCenter(new THREE.Vector3());
        const half = world.getSize(new THREE.Vector3()).multiplyScalar(0.5);
        return {
          center: { x: center.x, y: center.y, z: center.z },
          halfExtents: { x: half.x, y: half.y, z: half.z },
        };
      });
      placed = true;
    },

    /**
     * Where a right-click sits you: the seat nearest the point clicked, if the
     * nearest thing under the pointer is the sofa and it is within reach --
     * `{ eye, yaw, standAt }` for cameraModes.sitOn -- or null. `occluders` are
     * what can stand in front of it: the desk, the shelf, the book in your hand.
     */
    seatUnder(event, { camera, dom, occluders = [] }) {
      if (!placed || !shown(object)) return null;
      const rect = dom.getBoundingClientRect();
      _ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      _raycaster.setFromCamera(_ndc, camera);
      const hit = _raycaster
        .intersectObjects([object, ...occluders.filter(Boolean)], true)
        .find((h) => shown(h.object));
      if (!hit || hit.distance > SIT_REACH) return null;
      let o = hit.object;
      while (o && o !== object) o = o.parent;
      if (!o) return null;
      return seatAt(object.worldToLocal(hit.point.clone()));
    },
  };
  return sofa;
}
