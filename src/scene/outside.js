import * as THREE from 'three';
import { loadHeightmap, createTerrain, terrainHeightAt } from './terrain.js';
import { addOutdoorLight } from './outdoorLight.js';

/**
 * Going outside, through the door.
 *
 * BAREBONES. Clicking the door takes the room away -- walls, ceiling, window,
 * door and floor -- and puts terrain from a heightmap in its place, with the
 * ground under the middle of the room at the height the floor was, so you
 * are still standing on something -- lit by a sun, the sky's own light, and
 * an atmosphere to see it through (scene/outdoorLight.js). Walking bounds,
 * the book's physics walls and coming back in are all still the room's.
 */

const HEIGHTMAP_URL = '/heightmaps/swissalps.raw'; // public/heightmaps
const TERRAIN = { width: 400, height: 60, segments: 255 };

/**
 * @param {object} opts
 * @param {THREE.Scene} opts.scene
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {{ group: THREE.Group, door: THREE.Object3D|null }} opts.room  addRoom's result
 * @param {THREE.Mesh} opts.floor
 */
export function createOutside({ scene, camera, renderer, room, floor }) {
  let state = 'inside'; // 'loading' | 'outside'
  let terrain = null;
  let daylight = null;

  const _raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();

  function shown(object) {
    for (let o = object; o; o = o.parent) if (!o.visible) return false;
    return true;
  }

  /** Is the door the nearest visible thing under this click? */
  function doorUnder(event) {
    if (!room.door) return false;
    const rect = renderer.domElement.getBoundingClientRect();
    _ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    _raycaster.setFromCamera(_ndc, camera);
    const nearest = _raycaster.intersectObject(scene, true).find((hit) => shown(hit.object));
    for (let o = nearest?.object; o; o = o.parent) if (o === room.door) return true;
    return false;
  }

  async function goOutside() {
    if (state !== 'inside') return;
    state = 'loading';
    try {
      const heightmap = await loadHeightmap(HEIGHTMAP_URL);
      terrain = createTerrain(heightmap, TERRAIN);

      // The ground under the middle of the room goes where the floor was.
      const floorBox = new THREE.Box3().setFromObject(floor);
      const middle = floorBox.getCenter(new THREE.Vector3());
      terrain.position.set(middle.x, 0, middle.z);
      terrain.position.y = floorBox.max.y - terrainHeightAt(heightmap, terrain, middle.x, middle.z, TERRAIN);
      scene.add(terrain);

      room.group.visible = false;
      floor.visible = false;
      // The room never needed to see further than its own walls: its fog
      // (createScene.js) is near-black and fully in by 20 m, which turns
      // everything past that into a silhouette, and the camera stopped
      // drawing at 50 m. Both go, so the whole terrain is in view.
      scene.fog = null;
      camera.far = Math.max(camera.far, TERRAIN.width * 1.5);
      camera.updateProjectionMatrix();

      daylight = addOutdoorLight({
        scene,
        renderer,
        centre: terrain.position.clone().setY(floorBox.max.y),
        reach: TERRAIN.width / 2,
      });
      state = 'outside';
    } catch (err) {
      console.error('Going outside failed:', err);
      state = 'inside';
    }
  }

  return {
    get outside() { return state === 'outside'; },
    get terrain() { return terrain; },
    get daylight() { return daylight; },

    /** A click in the room. Returns true if it was on the door. */
    handleClick(event) {
      if (state !== 'inside' || !doorUnder(event)) return false;
      goOutside();
      return true;
    },

    goOutside,
  };
}