import * as THREE from 'three';
import { loadHeightmap, createTerrain, terrainHeightAt } from './terrain.js';
import { addOutdoorLight } from './outdoorLight.js';
import { createOutdoorPost } from './outdoorPost.js';
import { loadingScreen } from '../ui/loadingScreen.js';
import { createGrass } from './grass.js';
import { world } from '../state/world.js';

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
 * to the screen. Walking bounds and the book's physics walls are still the
 * room's.
 *
 * AND BACK. goInside() hides everything outdoors and puts the room's look
 * back -- its fog, its view distance, its backdrop and light, no tone
 * mapping -- exactly as they were when you left. Nothing outdoors is thrown
 * away, so going out a second time is instant, and comes back as you left it
 * (the debug panel's settings included).
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
  let grass = null;

  // The scene-wide settings each place needs, taken as you leave it and
  // restored as you come back.
  let insideLook = null;
  let outsideLook = null;
  // The outdoor objects, and whether each was showing when you went in.
  let outdoorVisibility = null;

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

  function captureLook() {
    return {
      fog: scene.fog,
      far: camera.far,
      background: scene.background,
      environment: scene.environment,
      environmentIntensity: scene.environmentIntensity,
      toneMapping: renderer.toneMapping,
      toneMappingExposure: renderer.toneMappingExposure,
    };
  }

  function restoreLook(look) {
    scene.fog = look.fog;
    camera.far = look.far;
    camera.updateProjectionMatrix();
    scene.background = look.background;
    scene.environment = look.environment;
    scene.environmentIntensity = look.environmentIntensity;
    renderer.toneMapping = look.toneMapping;
    renderer.toneMappingExposure = look.toneMappingExposure;
  }

  /** Back outside, with everything already built. */
  function returnOutside() {
    room.group.visible = false;
    floor.visible = false;
    for (const [object, visible] of outdoorVisibility) object.visible = visible;
    restoreLook(outsideLook);
    // Its capture may have been retaken since this look was saved.
    scene.environment = daylight.skyLight;
    // Meter afresh rather than adapting from the room's brightness.
    post.exposure.firstFrame = true;
    state = 'outside';
    world.place = 'outside';
  }

  /** Back into the room, as it was when you left it. */
  function goInside() {
    if (state !== 'outside') return;
    outsideLook = captureLook();
    outdoorVisibility = [terrain, grass?.group, daylight.sky, daylight.sun]
      .filter(Boolean)
      .map((object) => [object, object.visible]);
    for (const [object] of outdoorVisibility) object.visible = false;
    restoreLook(insideLook);
    room.group.visible = true;
    floor.visible = true;
    state = 'inside';
    world.place = 'room';
  }

  // Everything that can fail -- the downloads -- happens before the room is
  // touched, so a failed trip leaves you standing in the room as it was.
  async function goOutside() {
    if (state !== 'inside') return;
    // Before anything outdoors touches the scene: this is what coming back in
    // restores.
    insideLook = captureLook();
    if (terrain && post) {
      returnOutside();
      return;
    }
    state = 'loading';
    world.place = 'loading';
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

      // The ground under the middle of the room goes where the floor was.
      const floorBox = new THREE.Box3().setFromObject(floor);
      const middle = floorBox.getCenter(new THREE.Vector3());
      terrain.position.set(middle.x, 0, middle.z);
      terrain.position.y = floorBox.max.y - terrainHeightAt(heightmap, terrain, middle.x, middle.z, TERRAIN);
      terrain.updateMatrixWorld();
      scene.add(terrain);

      // Planted once the ground is in place, around where you will be standing.
      loadingScreen.status('Growing the grass…');
      await nextFrame();
      grass = createGrass({
        terrain,
        centre: middle,
        terrainWidth: TERRAIN.width,
        segments: TERRAIN.segments,
        camera,
      });
      scene.add(grass.group);

      loadingScreen.status('Lighting the sky…');
      await nextFrame();

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
        skyTexture: daylight.skyTexture,
      });

      // Compiled now, behind the screen, rather than as a stall on the first
      // frame outside.
      loadingScreen.status('Almost there…');
      await renderer.compileAsync(scene, camera);

      state = 'outside';
      world.place = 'outside';
      loadingScreen.finish();
    } catch (err) {
      console.error('Going outside failed:', err);
      if (state === 'loading') {
        state = 'inside';
        world.place = 'room';
      }
      loadingScreen.fail('The way outside is blocked for now.');
    }
  }

  return {
    get outside() { return state === 'outside'; },
    get terrain() { return terrain; },
    get daylight() { return daylight; },
    get post() { return post; },
    get grass() { return grass; },

    /**
     * Draw the frame, if outside: through the fog and exposure chain.
     * Returns false inside, where the caller renders as it always has.
     */
    render(dt) {
      if (state !== 'outside' || !post) return false;
      grass?.update(dt);
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
    goInside,
  };
}