import * as THREE from 'three';
import { loadGLTF } from '../models.js';
import { disposeObject } from '../disposal.js';
import { heading, flatDirection, sideways } from '../direction.js';

/**
 * A hanging egg chair, outside, on a rope from a limb of the tree
 * (scene/outside/tree.js). Right-click it, near enough, and you sit in it.
 *
 * THE MODEL is already a hanging chair, in metres: a bamboo egg with a fabric
 * cushion in its bottom, on a rope, with its ORIGIN AT THE TOP OF THE ROPE --
 * the hook. So hanging it is putting that origin on a branch. Measured off
 * the geometry rather than written down:
 *   - the egg is everything below the top of the bamboo; the rope is the
 *     fabric above it (a strip three centimetres wide);
 *   - the way it OPENS is the way its shell does not go -- the bamboo leans
 *     toward the closed back at every height, so the front is the other way;
 *   - the SEAT is the top of the cushion near the middle and toward the open
 *     front. Further back the fabric climbs the back cushion, which is where
 *     you lean, not where you sit.
 *
 * FROM A REAL LIMB. The tree is asked for a point on its own wood
 * (tree.findBranch): out from the trunk, high enough, on the far side of the
 * bench from the trunk, and never close enough to the bench to swing into it.
 * The limbs are three and a half to five and a half metres up, and the chair's
 * own rope is under a metre -- so the ROPE IS STRETCHED to reach, the model's
 * own rope vertices drawn out to length, rather than a second rope added that
 * would not match it.
 *
 * IT HANGS STILL. The seat you sit in (cameraModes.sitOn) is taken as a fixed
 * point when you sit down, so a chair that swung would leave you floating
 * beside it.
 */

const CHAIR_URL = '/eggchair.glb';

// --- where it hangs -------------------------------------------------------------------
const CLEARANCE = 0.82; // metres of air under the egg
const MIN_ROPE = 0.35; // metres: shorter than this, and it is not hanging so much as bolted on
// Where on the tree to look for a limb: metres out from the trunk (clear of it
// by the egg's own width), and metres up.
const REACH = [1.6, 2.7];
const HANG_HEIGHT = [3.0, 5.5];
// Kept this far, in metres across the ground, from the middle of the bench:
// the bench's half-length, the egg's half-width, and room to walk between.
const KEEP_CLEAR = 1.65;
// Where to fall back to if no limb will do: out from the trunk, and up.
const FALLBACK_REACH = 2.0;
const FALLBACK_HEIGHT = 3.4;

// --- sitting in it ----------------------------------------------------------------------
const SEATED_EYE = 0.60; // the eye above the top of the cushion
const SEAT_FORWARD = -0.1; // how far forward of the egg's middle you sit
const STAND_OFF = 0.8; // how far in front of the egg's middle you get up to
// How far round the egg the grass is kept off (grass.js's setClearing): the
// egg hangs a hand's breadth off the ground, and the grass is taller than
// that, so without this it grows up through the shell.
const CLEARING_RADIUS = 0.95;


/**
 * @returns {Promise<{ object: THREE.Group, seat: object|null,
 *   place(opts: { tree: object, facing: THREE.Vector3, bench: { x: number, z: number },
 *     heightAt(x: number, z: number): number }): boolean,
 *   dispose(): void }>}
 */
export async function loadEggChair() {
  const gltf = await loadGLTF(CHAIR_URL);

  // --- into one space: y up, metres, hook at the origin ---------------------------
  // The export is a Sketchfab FBX, its z-up turned y-up by matrices on the
  // nodes. Baked into the geometry, so every measurement below is in the one
  // space the chair is placed from.
  gltf.scene.updateMatrixWorld(true);
  const meshes = [];
  gltf.scene.traverse((child) => { if (child.isMesh) meshes.push(child); });
  const model = new THREE.Group();
  for (const mesh of meshes) {
    mesh.geometry.applyMatrix4(mesh.matrixWorld);
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    model.add(mesh);
  }
  const fabric = meshes.find((mesh) => /fabric/i.test(mesh.name) || /fabric/i.test(mesh.material?.name));
  const bamboo = meshes.find((mesh) => /bamboo/i.test(mesh.name) || /bamboo/i.test(mesh.material?.name));
  if (!fabric || !bamboo) throw new Error('eggchair.glb: expected a fabric part and a bamboo part');

  // --- measured ---------------------------------------------------------------------
  const fabricAt = fabric.geometry.getAttribute('position');
  const bambooAt = bamboo.geometry.getAttribute('position');

  bamboo.geometry.computeBoundingBox();
  const shell = bamboo.geometry.boundingBox;
  const eggTop = shell.max.y; // the rope is what is above this
  let eggBottom = shell.min.y;
  for (let i = 0; i < fabricAt.count; i += 1) eggBottom = Math.min(eggBottom, fabricAt.getY(i));
  const eggX = (shell.min.x + shell.max.x) / 2;
  const eggZ = (shell.min.z + shell.max.z) / 2;

  // Which way it opens: away from where the shell's weight is. Measured
  // through the middle of the egg, where the opening is widest.
  const lean = new THREE.Vector2();
  let counted = 0;
  const midLow = eggBottom + (eggTop - eggBottom) * 0.3;
  const midHigh = eggBottom + (eggTop - eggBottom) * 0.75;
  for (let i = 0; i < bambooAt.count; i += 1) {
    const y = bambooAt.getY(i);
    if (y < midLow || y > midHigh) continue;
    lean.x += bambooAt.getX(i) - eggX;
    lean.y += bambooAt.getZ(i) - eggZ;
    counted += 1;
  }
  const front = new THREE.Vector3(-lean.x, 0, -lean.y);
  if (counted === 0 || front.lengthSq() < 1e-8) front.set(0, 0, 1);
  front.normalize();

  // The seat: the top of the cushion near the middle, forward of centre and
  // low in the egg -- clear of the back cushion climbing behind it.
  let seatTop = -Infinity;
  for (let i = 0; i < fabricAt.count; i += 1) {
    const x = fabricAt.getX(i) - eggX;
    const y = fabricAt.getY(i);
    const z = fabricAt.getZ(i) - eggZ;
    const forward = x * front.x + z * front.z;
    const across = Math.abs(x * front.z - z * front.x);
    if (across < 0.12 && forward > 0 && forward < 0.3 && y < eggBottom + 0.6) seatTop = Math.max(seatTop, y);
  }
  if (!Number.isFinite(seatTop)) seatTop = eggBottom + 0.35;

  // The rope: the fabric above the egg, kept as it came so it can be drawn out
  // to any length from the original each time, and where it hangs across.
  // Heights only, read through the attribute rather than its raw array: the
  // loader can hand back an INTERLEAVED buffer, where the array holds normals
  // and UVs between the positions and [i * 3 + 1] is not vertex i's height.
  const originalY = new Float32Array(fabricAt.count);
  for (let i = 0; i < fabricAt.count; i += 1) originalY[i] = fabricAt.getY(i);
  const ropeAt = new THREE.Vector3();
  let ropeTop = eggTop;
  let ropeCount = 0;
  for (let i = 0; i < fabricAt.count; i += 1) {
    const y = fabricAt.getY(i);
    if (y <= eggTop) continue;
    ropeAt.x += fabricAt.getX(i);
    ropeAt.z += fabricAt.getZ(i);
    ropeTop = Math.max(ropeTop, y);
    ropeCount += 1;
  }
  if (ropeCount > 0) ropeAt.divideScalar(ropeCount);
  else ropeAt.set(eggX, 0, eggZ);
  const ropeLength = ropeTop - eggTop;

  /**
   * Draw the rope out to `length`: every rope vertex moved up in proportion,
   * so the rope keeps its own look, only longer. From the original each time.
   * Returns where its top now is.
   */
  function stretchRope(length) {
    const k = ropeLength > 1e-4 ? length / ropeLength : 1;
    for (let i = 0; i < fabricAt.count; i += 1) {
      const y = originalY[i];
      fabricAt.setY(i, y > eggTop ? eggTop + (y - eggTop) * k : y);
    }
    fabricAt.needsUpdate = true;
    fabric.geometry.computeBoundingBox();
    fabric.geometry.computeBoundingSphere();
    return eggTop + length;
  }

  const object = new THREE.Group();
  object.name = 'eggChair';
  object.add(model);

  const _side = new THREE.Vector3();
  const _toward = new THREE.Vector3();
  const _facing = new THREE.Vector3();
  const _hook = new THREE.Vector3();

  const chair = {
    object,

    /**
     * Where you sit, once hung: `eye` the world position of the eye, `yaw`
     * which way it faces, `standAt` the spot in front you get up to -- the
     * bench's contract (parkBench.js), for cameraModes.sitOn. Null until
     * place().
     */
    seat: null,

    /**
     * The patch of ground under the egg to keep the grass off, once hung:
     * { x, z, radius }. Null until place().
     */
    clearing: null,

    /**
     * Hang it from the tree, beside the bench.
     *
     * @param {object} opts
     * @param {object} opts.tree  the tree, already placed
     * @param {THREE.Vector3} opts.facing  which way the bench faces -- the chair
     *   faces the same way, out at the view
     * @param {{ x: number, z: number }} opts.bench  where the bench stands
     * @param {(x: number, z: number) => number} opts.heightAt  the ground
     * @returns {boolean} whether it hung from a limb (false: from the fallback)
     */
    place({ tree, facing, bench, heightAt }) {
      flatDirection(facing, _facing);
      sideways(_facing, _side);

      // The tree stands behind the bench and a little to its side
      // (tree.js's TRUNK_ASIDE); the chair goes out the OTHER side, and a
      // little forward, so it hangs beside the bench rather than behind it.
      _toward.copy(_facing).multiplyScalar(0.45).addScaledVector(_side, -0.9).normalize();

      let limb = tree.findBranch({
        toward: _toward,
        reach: REACH,
        height: HANG_HEIGHT,
        accept: (point) => Math.hypot(point.x - bench.x, point.z - bench.z) >= KEEP_CLEAR,
      });
      const onLimb = Boolean(limb);
      if (!limb) {
        // No limb will do: hang it where one would be, under the crown. The
        // rope goes up into the leaves, which is where it would disappear to
        // anyway.
        limb = tree.object.position.clone()
          .addScaledVector(_toward, FALLBACK_REACH)
          .add(new THREE.Vector3(0, FALLBACK_HEIGHT, 0));
      }

      // The rope, drawn out so the egg clears the ground under it.
      const ground = heightAt(limb.x, limb.z);
      const rope = Math.max(MIN_ROPE, limb.y - ground - CLEARANCE - (eggTop - eggBottom));
      const top = stretchRope(rope);

      // Turned to face the way the bench does, and hung so the top of the
      // rope is on the limb.
      object.rotation.set(0, Math.atan2(_facing.x, _facing.z) - Math.atan2(front.x, front.z), 0);
      object.position.set(0, 0, 0);
      object.updateMatrixWorld(true);
      _hook.set(ropeAt.x, top, ropeAt.z).applyQuaternion(object.quaternion);
      object.position.copy(limb).sub(_hook);
      object.updateMatrixWorld(true);

      // And the seat in it.
      const eye = object.localToWorld(new THREE.Vector3(
        eggX + front.x * SEAT_FORWARD,
        seatTop + SEATED_EYE,
        eggZ + front.z * SEAT_FORWARD,
      ));
      const stand = object.localToWorld(new THREE.Vector3(
        eggX + front.x * STAND_OFF,
        0,
        eggZ + front.z * STAND_OFF,
      ));
      chair.seat = { eye, yaw: heading(_facing), standAt: { x: stand.x, z: stand.z } };
      const under = object.localToWorld(new THREE.Vector3(eggX, 0, eggZ));
      chair.clearing = { x: under.x, z: under.z, radius: CLEARING_RADIUS };
      return onLimb;
    },

    dispose() {
      disposeObject(object);
    },
  };
  return chair;
}
