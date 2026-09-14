import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FURNITURE_SCALE } from '../worldScale.js';

/**
 * A park bench, outside, to sit on: right-click it (scene/outside/outside.js,
 * input/cameraModes.js's sitOn).
 *
 * "Park Bench" by DutraBR98, CC-BY-4.0 --
 * https://sketchfab.com/3d-models/park-bench-84426d6537ac4cdc837d602ccabe7036
 *
 * SIZE. The model is authored in metres -- 1.5 long, 0.7 to the top of its
 * back -- and drawn at the scene's shared oversize (scene/worldScale.js), like
 * the room's furniture.
 *
 * WHERE THE SEAT IS is measured off the model rather than written down: its
 * planks are the long thin parts, the seat's lying flat and the back's
 * standing up. The top of the seat planks is what you sit on, and the way
 * from the back to the seat is the way the bench faces.
 *
 * WHERE IT GOES. place() puts it a few steps ahead of a point, facing a way
 * -- where you came out, the way you were looking -- trying a handful of
 * spots nearby and taking the flattest, so it stands on the ground rather
 * than hanging off a slope.
 */

const BENCH_URL = '/park_bench.glb';
const SCALE = FURNITURE_SCALE;

// World units -- the same units the camera's eye height is in.
const SEATED_EYE = 0.95; // the eye above the top of the seat
const STAND_OFF = 0.9; // how far in front of the seat you get up to
const SINK = 0.04; // pressed into the ground a little, so no foot floats on uneven ground

// The spots place() tries: this far ahead, and this far to either side.
const PLACE_AHEAD = [4, 5, 6, 7, 8];
const PLACE_ACROSS = [-2.5, -1.25, 0, 1.25, 2.5];
const PREFERRED_AHEAD = 5;

/** Which way a direction faces, as a camera yaw: 0 along -Z. */
const heading = (direction) => Math.atan2(-direction.x, -direction.z);

/**
 * @returns {Promise<{ object: THREE.Group, seat: object|null, clearingRadius: number,
 *   place(opts: { x: number, z: number, facing: THREE.Vector3,
 *     heightAt(x: number, z: number): number }): void,
 *   dispose(): void }>}
 */
export async function loadParkBench() {
  const gltf = await new GLTFLoader().loadAsync(BENCH_URL);
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
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const middle = box.getCenter(new THREE.Vector3());
  model.position.set(-middle.x, -box.min.y, -middle.z);

  const object = new THREE.Group();
  object.name = 'parkBench';
  object.add(model);
  object.updateMatrixWorld(true);

  // --- the seat, measured -----------------------------------------------------------
  const seatBox = new THREE.Box3();
  const backBox = new THREE.Box3();
  const _part = new THREE.Box3();
  const _partSize = new THREE.Vector3();
  const thin = 0.12 * SCALE;
  object.traverse((child) => {
    if (!child.isMesh) return;
    _part.setFromObject(child).getSize(_partSize);
    // Thick both ways: the frame and legs, not a plank.
    if (_partSize.y > thin && _partSize.z > thin) return;
    // Lying flat is the seat; standing up is the back.
    if (_partSize.z >= _partSize.y) seatBox.union(_part);
    else backBox.union(_part);
  });

  const seatTop = seatBox.isEmpty() ? size.y * 0.5 : seatBox.max.y;
  const seatCentre = seatBox.isEmpty() ? new THREE.Vector3() : seatBox.getCenter(new THREE.Vector3());
  seatCentre.y = 0;
  // From the back to the seat is forward; without a back to measure, the
  // bench is taken to face -Z, as this one does.
  const forward = new THREE.Vector3(0, 0, -1);
  if (!seatBox.isEmpty() && !backBox.isEmpty()) {
    const backCentre = backBox.getCenter(new THREE.Vector3());
    forward.set(seatCentre.x - backCentre.x, 0, seatCentre.z - backCentre.z);
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1);
    forward.normalize();
  }

  const halfLength = size.x / 2;
  const halfDepth = size.z / 2;

  const _facing = new THREE.Vector3();
  const _side = new THREE.Vector3();

  const bench = {
    object,

    /**
     * Where you sit, once placed: `eye` the world position of the eye,
     * `yaw` which way it faces (as a camera yaw), `standAt` the spot in front
     * of the bench you get up to. Null until place().
     */
    seat: null,

    /**
     * How far round the bench the grass should be kept off (grass.js's
     * setClearing), so none grows through the seat -- its ends included.
     */
    clearingRadius: (halfLength + 0.15 * SCALE) / 0.6,

    place({ x, z, facing, heightAt }) {
      _facing.set(facing.x, 0, facing.z);
      if (_facing.lengthSq() < 1e-8) _facing.set(0, 0, -1);
      _facing.normalize();
      // The bench's length runs across the way it faces.
      _side.set(-_facing.z, 0, _facing.x);

      // The flattest of the spots tried, nearer ones winning a close call.
      let best = null;
      for (const ahead of PLACE_AHEAD) {
        for (const across of PLACE_ACROSS) {
          const cx = x + _facing.x * ahead + _side.x * across;
          const cz = z + _facing.z * ahead + _side.z * across;
          const heights = [heightAt(cx, cz)];
          for (const along of [-halfLength, halfLength]) {
            for (const deep of [-halfDepth, halfDepth]) {
              heights.push(heightAt(
                cx + _side.x * along + _facing.x * deep,
                cz + _side.z * along + _facing.z * deep,
              ));
            }
          }
          const spread = Math.max(...heights) - Math.min(...heights);
          const score = spread + 0.02 * Math.hypot(ahead - PREFERRED_AHEAD, across);
          if (!best || score < best.score) {
            const mean = heights.reduce((sum, h) => sum + h, 0) / heights.length;
            best = { score, cx, cz, y: mean };
          }
        }
      }

      object.position.set(best.cx, best.y - SINK, best.cz);
      object.rotation.set(0, heading(_facing) - heading(forward), 0);
      object.updateMatrixWorld(true);

      const eye = object.localToWorld(new THREE.Vector3(seatCentre.x, seatTop + SEATED_EYE, seatCentre.z));
      const stand = object.localToWorld(seatCentre.clone().addScaledVector(forward, STAND_OFF));
      const facingWorld = forward.clone().transformDirection(object.matrixWorld);
      bench.seat = { eye, yaw: heading(facingWorld), standAt: { x: stand.x, z: stand.z } };
    },

    dispose() {
      object.traverse((child) => {
        if (!child.isMesh) return;
        child.geometry.dispose();
        for (const material of [].concat(child.material)) {
          for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
          material.dispose();
        }
      });
    },
  };
  return bench;
}
