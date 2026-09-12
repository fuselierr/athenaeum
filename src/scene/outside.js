import * as THREE from 'three';
import {
  loadHeightmap, createTerrain, terrainHeightAt, disposeTerrain, sampleTerrain,
} from './terrain.js';
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
 * ONE PLACE AT A TIME. Outside, nothing of the room is drawn: its shell and
 * floor, and whatever else the caller counts as indoors -- the furniture, the
 * shelf and its books, the instruction card, the room's lights. Inside,
 * nothing outdoors is. The book is the one thing that can come with you: it
 * shows outside only while it is in your hand, and disappears with the desk
 * once it goes back to it.
 *
 * AND BACK. goInside() puts the room's look back -- its fog, its view
 * distance, its backdrop and light, no tone mapping -- exactly as they were
 * when you left, and then UNLOADS the outdoors: terrain, grass, sky, sun, and
 * the whole post-processing chain, off the GPU and out of memory. That is for
 * machines without much of either: nothing outdoors costs anything while you
 * are in the room. The price is that every trip outside is a full load again
 * (the files come from the browser's cache after the first time, but the
 * terrain, grass and cloud noise are rebuilt), and the debug panel's settings
 * start from their defaults each visit.
 */

const HEIGHTMAP_URL = '/heightmaps/swissalps.raw'; // public/heightmaps
const TERRAIN = { width: 400, height: 60, segments: 255 };
// How far in from the terrain's edge you can walk, in metres -- short of
// where the ground ends and the void begins.
const GROUND_EDGE_MARGIN = 10;

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
 * @param {THREE.Object3D[]} [opts.inside]  everything else of the room's that
 *   is drawn, to hide while outside
 * @param {{ object: THREE.Object3D, isCarried(): boolean }|null} [opts.book]
 *   the book, shown outside only while isCarried()
 * @param {((ground: { heightAt(x: number, z: number): number, bounds: THREE.Box3 }|null) => void)|null} [opts.setGround]
 *   given the terrain to walk on when you arrive outside, and null when you
 *   leave -- input/cameraModes.js's setGround
 */
export function createOutside({
  scene, camera, renderer, room, floor, inside = [], book = null, setGround = null,
}) {
  let state = 'inside'; // 'loading' | 'outside'
  let terrain = null;
  let daylight = null;
  let post = null;
  let grass = null;

  // The room's scene-wide settings, taken as you leave and restored as you
  // come back.
  let insideLook = null;
  // Where you were standing in the room, to come back in to.
  const insideCameraPosition = new THREE.Vector3();

  // Everything of the room's that is drawn, and whether each was showing when
  // you went out -- so the walls switch (H), say, comes back as it was.
  const indoors = [room.group, floor, ...inside];
  let indoorVisibility = null; // null while the room is showing

  function hideInside() {
    indoorVisibility = indoors.map((object) => [object, object.visible]);
    for (const object of indoors) object.visible = false;
    followBook();
  }

  function showInside() {
    if (!indoorVisibility) return;
    for (const [object, visible] of indoorVisibility) object.visible = visible;
    indoorVisibility = null;
    if (book) book.object.visible = true;
  }

  /**
   * Outside, the book is there only while you are holding it. It is the one
   * thing out there that casts a moving shadow, so while it shows -- and on
   * the frame it goes -- the sun's otherwise frozen shadow map is redrawn.
   */
  function followBook() {
    if (!book) return;
    const was = book.object.visible;
    book.object.visible = book.isCarried();
    if (book.object.visible || was) daylight?.requestShadowUpdate();
  }

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

  /**
   * Free everything a trip outside built. Safe on a half-built trip: whatever
   * got made is freed, whatever did not is skipped. The room's look has to be
   * back first -- the scene's environment is the sky light until then.
   */
  function unloadOutside() {
    post?.dispose();
    daylight?.dispose();
    if (grass) {
      scene.remove(grass.group);
      grass.dispose();
    }
    if (terrain) {
      scene.remove(terrain);
      disposeTerrain(terrain);
    }
    post = null;
    daylight = null;
    grass = null;
    terrain = null;
  }

  /** Back into the room, as it was when you left it -- and the outdoors unloaded. */
  function goInside() {
    if (state !== 'outside') return;
    restoreLook(insideLook);
    showInside();
    // Back on the room's floor, where you were standing when you went out --
    // before the terrain the ground reads from is freed.
    camera.position.copy(insideCameraPosition);
    setGround?.(null);
    unloadOutside();
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
    insideCameraPosition.copy(camera.position);
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
        terrainWidth: TERRAIN.width,
        segments: TERRAIN.segments,
        camera,
      });
      scene.add(grass.group);

      loadingScreen.status('Lighting the sky…');
      await nextFrame();

      hideInside();
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
      // The cloud noise is generated here, which takes a moment.
      loadingScreen.status('Gathering clouds…');
      await nextFrame();
      post = createOutdoorPost({
        renderer,
        scene,
        camera,
        sunDirection: daylight.sunDirection,
        groundHeight: floorBox.max.y,
        skyTexture: daylight.skyTexture,
        sun: daylight.sun,
      });

      // Compiled now, behind the screen, rather than as a stall on the first
      // frame outside.
      loadingScreen.status('Almost there…');
      await renderer.compileAsync(scene, camera);

      // On your feet on the terrain, wherever in it you came out.
      const walkable = TERRAIN.width / 2 - GROUND_EDGE_MARGIN;
      setGround?.({
        heightAt: (x, z) => terrain.position.y + sampleTerrain(terrain, 'position', 1, x, z, TERRAIN),
        bounds: new THREE.Box3(
          new THREE.Vector3(terrain.position.x - walkable, 0, terrain.position.z - walkable),
          new THREE.Vector3(terrain.position.x + walkable, 0, terrain.position.z + walkable),
        ),
      });

      state = 'outside';
      world.place = 'outside';
      loadingScreen.finish();
    } catch (err) {
      console.error('Going outside failed:', err);
      // Back as you were, with whatever had been built so far freed.
      setGround?.(null);
      restoreLook(insideLook);
      showInside();
      unloadOutside();
      state = 'inside';
      world.place = 'room';
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
      followBook();
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