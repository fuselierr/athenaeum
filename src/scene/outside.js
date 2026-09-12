import * as THREE from 'three';
import { loadHeightmap, createTerrain, terrainHeightAt } from './terrain.js';
import { addOutdoorLight } from './outdoorLight.js';
import { createOutdoorPost } from './outdoorPost.js';
import { loadingScreen } from '../ui/loadingScreen.js';

/**
 * Going outside, through the door.
 *
 * BAREBONES. Clicking the door takes the room away -- walls, ceiling, window,
 * door and floor -- and puts terrain from a heightmap in its place, with the
 * ground under the middle of the room at the height the floor was, so you
 * are still standing on something -- lit by a sun, the sky's own light, and
 * an atmosphere to see it through (scene/outdoorLight.js), then height fog
 * and auto exposure over the frame (scene/outdoorPost.js) -- which is why,
 * once outside, main.js renders through render() here instead of straight
 * to the screen. Walking bounds, the book's physics walls and coming back in
 * are all still the room's.
 */

const HEIGHTMAP_URL = '/heightmaps/swissalps.raw'; // public/heightmaps
const TERRAIN = { width: 400, height: 60, segments: 255 };

/** Resolves on the next frame -- so a status line paints before blocking work. */
function nextFrame() {
  return new Promise((resolve) => { requestAnimationFrame(() => resolve()); });
}

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
  let post = null;

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

  // Everything that can fail -- the downloads -- happens before the room is
  // touched, so a failed trip leaves you standing in the room as it was.
  async function goOutside() {
    if (state !== 'inside') return;
    state = 'loading';
    loadingScreen.show('Opening the door…');
    try {
      const heightmap = await loadHeightmap(HEIGHTMAP_URL, (fraction) => {
        loadingScreen.status('Surveying the land…', fraction);
      });

      loadingScreen.status('Shaping the terrain…');
      await nextFrame();
      terrain = createTerrain(heightmap, {
        ...TERRAIN,
        onTextureProgress: (loaded, total) => {
          loadingScreen.status(`Laying the ground… ${loaded} of ${total}`, loaded / total);
        },
      });
      await terrain.material.userData.ready;

      loadingScreen.status('Lighting the sky…');
      await nextFrame();

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
      post = createOutdoorPost({
        renderer,
        scene,
        camera,
        sunDirection: daylight.sunDirection,
        groundHeight: floorBox.max.y,
      });

      // Compiled now, behind the screen, rather than as a stall on the first
      // frame outside.
      loadingScreen.status('Almost there…');
      await renderer.compileAsync(scene, camera);

      state = 'outside';
      loadingScreen.finish();
    } catch (err) {
      console.error('Going outside failed:', err);
      if (state === 'loading') state = 'inside';
      loadingScreen.fail('The way outside is blocked for now.');
    }
  }

  return {
    get outside() { return state === 'outside'; },
    get terrain() { return terrain; },
    get daylight() { return daylight; },
    get post() { return post; },

    /**
     * Draw the frame, if outside: through the fog and exposure chain.
     * Returns false inside, where the caller renders as it always has.
     */
    render(dt) {
      if (state !== 'outside' || !post) return false;
      post.render(dt);
      return true;
    },

    /** A click in the room. Returns true if it was on the door. */
    handleClick(event) {
      if (state !== 'inside' || !doorUnder(event)) return false;
      goOutside();
      return true;
    },

    goOutside,
  };
}