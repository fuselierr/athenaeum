import * as THREE from 'three';
import {
  loadHeightmap, createTerrain, terrainHeightAt, disposeTerrain, sampleTerrain,
} from './terrain.js';
import { addOutdoorLight } from './outdoorLight.js';
import { createOutdoorPost } from './outdoorPost.js';
import { loadingScreen } from '../../ui/loadingScreen.js';
import { createGrass } from './grass.js';
import { loadGrassClumps } from './grassClumps.js';
import { createWindField } from './wind.js';
import { createDistantRange } from './distantRange.js';
import { loadParkBench } from './parkBench.js';
import { loadTree } from './tree.js';
import { world } from '../../state/world.js';
import { watch } from 'vue';
import { settings } from '../../state/settings.js';
import { qualityPreset } from '../../state/quality.js';

/**
 * Going outside, through the door.
 *
 * BAREBONES. Clicking the door takes the room away -- walls, ceiling, window,
 * door and floor -- and puts terrain from a heightmap in its place, with the
 * ground under the middle of the room at the height the floor was, so you
 * are still standing on something -- lit by a sun, the sky's own light, and
 * an atmosphere to see it through (scene/outside/outdoorLight.js), then height fog
 * and auto exposure over the frame (scene/outside/outdoorPost.js) -- which is why,
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
 * A BENCH stands a few steps ahead of where you come out, facing the way you
 * were looking, with the grass kept off it (scene/outside/parkBench.js).
 * Right-click it, near enough, and you sit down on it. A TREE stands over it
 * (scene/outside/tree.js), rooted behind the backrest so the canopy is
 * overhead and the view from the seat is clear.
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
const TERRAIN = {
  width: 400, // metres on a side
  height: 60, // metres from the map's lowest point to its highest, before exaggeration
  exaggeration: 0.5, // every height times this: taller mountains, steeper slopes
  sharpness: 1.5, // above 1, valley floors pressed down and their walls steepened
  segments: 255,
};
// How far in from the terrain's edge you can walk, in metres -- short of
// where the ground ends and the void begins.
const GROUND_EDGE_MARGIN = 10;
// How near the bench you have to be for a right-click to sit you on it.
const SIT_REACH = 8;

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
 * @param {{ objects(): THREE.Object3D[], carried(): THREE.Object3D|null }|null} [opts.book]
 *   the books in the room; only the one carried() is shown outside
 * @param {((ground: { heightAt(x: number, z: number): number, bounds: THREE.Box3 }|null) => void)|null} [opts.setGround]
 *   given the terrain to walk on when you arrive outside, and null when you
 *   leave -- input/cameraModes.js's setGround
 * @param {() => number} [opts.lying]  how far down the player is lying, 0..1,
 *   for the grass to part round them
 * @param {((seat: { eye: THREE.Vector3, yaw: number, standAt: { x: number, z: number } }) => void)|null} [opts.sit]
 *   sit the player on the bench -- input/cameraModes.js's sitOn
 * @param {{ objects: () => THREE.Object3D[], outdoors: () => THREE.Object3D[] }} [opts.book]
 *   every book in the room, and which of them are out here -- the one in
 *   your hand, and any you have set down on the grass
 * @param {() => THREE.Object3D[]} [opts.vrHidden]  what VR holds in front of
 *   your face -- the controllers, the menu panel -- which the exposure outside
 *   is not metered off (scene/outside/outdoorPost.js's renderXR)
 */
export function createOutside({
  scene, camera, renderer, room, floor, inside = [], book = null, setGround = null, lying = () => 0,
  sit = null, vrHidden = () => [],
}) {
  let state = 'inside'; // 'loading' | 'outside'
  let terrain = null;
  let daylight = null;
  let post = null;
  let grass = null;
  let clumps = null;
  let wind = null;
  let bench = null;
  let tree = null;
  let range = null;

  // The graphics quality reaches whatever outdoors is built right now; a trip
  // built later reads the preset as it builds.
  function applyQuality() {
    const preset = qualityPreset();
    post?.applyQuality(preset);
  }
  watch(() => settings.graphics.quality, applyQuality);

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
    for (const object of book?.objects() ?? []) object.visible = true;
  }

  /**
   * Outside, a book is there if you brought it: in your hand, or lying
   * wherever you put it down out here. Books are the one thing out there that
   * casts a moving shadow, so while one shows -- and on the frame it goes --
   * the sun's otherwise frozen shadow map is redrawn.
   */
  function followBook() {
    if (!book) return;
    // The room can hold several books at once (book/bookInstance.js), and
    // main.js says which of them belong out here; the rest stay indoors with
    // the room.
    const here = book.outdoors();
    let moved = false;
    for (const object of book.objects()) {
      const was = object.visible;
      object.visible = here.includes(object);
      if (object.visible || was) moved = true;
    }
    if (moved) daylight?.requestShadowUpdate();
  }

  const _raycaster = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  const _facing = new THREE.Vector3();
  const _standing = new THREE.Vector3();

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
    // The tuft the grass is made of, and its mask: shared by every chunk, so
    // freed once, here, rather than by any of them.
    clumps?.dispose();
    clumps = null;
    // Uniforms only -- the texture in them is the clumps', freed just above.
    wind = null;
    if (terrain) {
      scene.remove(terrain);
      disposeTerrain(terrain);
    }
    if (bench) {
      scene.remove(bench.object);
      bench.dispose();
    }
    if (tree) {
      scene.remove(tree.object);
      tree.dispose();
    }
    // Never in `scene` -- it lives in the far pass's own scene
    // (outdoorPost.js), which goes with the composer above.
    range?.dispose();
    range = null;
    tree = null;
    bench = null;
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
    // The bench and its tree download alongside the land. They are only
    // scenery, so one that will not load is left out rather than keeping you
    // indoors.
    const benchLoading = loadParkBench().catch((err) => {
      console.warn('The park bench did not load; going out without it.', err);
      return null;
    });
    // The grass's tuft, and with it the wind's noise field. Unlike the
    // scenery this one is not optional -- without it there is no grass to
    // plant -- and the tree waits on it for the field, so that the canopy and
    // the meadow lean in one gust (scene/outside/wind.js).
    const clumpsLoading = loadGrassClumps();
    // ONE field, made once and given to both. Made here rather than inside
    // either of them because it is neither's: two calls to createWindField
    // would hand the grass and the tree their own uniform objects, and a
    // slider that widened the gusts would widen them over the meadow while
    // the tree carried on in the old wind.
    const fieldLoading = clumpsLoading.then(({ windNoise }) => createWindField(windNoise));
    const treeLoading = fieldLoading
      .then((windField) => loadTree({ windField }))
      .catch((err) => {
        console.warn('The tree did not load; going out without it.', err);
        return null;
      });
    try {
      const heightmap = await loadHeightmap(HEIGHTMAP_URL, (fraction) => {
        loadingScreen.status('Surveying the land…', 0.3 * fraction);
      });

      loadingScreen.status('Shaping the terrain…', 0.3, 0.4);
      await nextFrame();
      terrain = createTerrain(heightmap, {
        ...TERRAIN,
        onTextureProgress: (loaded, total) => {
          loadingScreen.status(
            `Laying the ground… ${loaded} of ${total}`,
            0.4 + 0.25 * (loaded / total),
            0.4 + 0.25 * (Math.min(loaded + 1, total) / total),
          );
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
      loadingScreen.status('Growing the grass…', 0.65, 0.72);
      await nextFrame();
      clumps = await clumpsLoading;
      wind = await fieldLoading;
      grass = createGrass({
        terrain,
        terrainWidth: TERRAIN.width,
        segments: TERRAIN.segments,
        camera,
        parting: lying,
        clumps,
        wind,
      });
      scene.add(grass.group);

      // A few steps ahead of where you are standing, facing the way you are
      // looking, on the flattest ground nearby -- and no grass through it.
      bench = await benchLoading;
      if (bench) {
        camera.getWorldPosition(_standing);
        camera.getWorldDirection(_facing);
        bench.place({
          x: _standing.x,
          z: _standing.z,
          facing: _facing,
          heightAt: (x, z) => terrain.position.y + sampleTerrain(terrain, 'position', 1, x, z, TERRAIN),
        });
        scene.add(bench.object);
        grass.setClearing(bench.object.position.x, bench.object.position.z, bench.clearingRadius);
      }

      // Over the bench, once the bench has chosen its spot -- and before the
      // sun is made, whose shadow map is drawn once over whatever is standing
      // by then (scene/outside/outdoorLight.js).
      tree = await treeLoading;
      if (tree && bench) {
        // The way the BENCH ended up facing, from the seat itself, rather
        // than the camera direction it was placed from -- the same heading,
        // said by the thing the tree is standing over.
        const seatYaw = bench.seat.yaw;
        tree.place({
          x: bench.object.position.x,
          z: bench.object.position.z,
          facing: new THREE.Vector3(-Math.sin(seatYaw), 0, -Math.cos(seatYaw)),
          heightAt: (x, z) => terrain.position.y + sampleTerrain(terrain, 'position', 1, x, z, TERRAIN),
        });
        scene.add(tree.object);
      } else if (tree) {
        tree.dispose();
        tree = null;
      }

      loadingScreen.status('Lighting the sky…', 0.72, 0.8);
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
      loadingScreen.status('Gathering clouds…', 0.8, 0.88);
      await nextFrame();
      // The mountains beyond the terrain: the middle distance the scene did
      // not have, and the horizon it never reached
      // (scene/outside/distantRange.js). Built after the sky, because the
      // haze it fades into is that sky.
      loadingScreen.status('Raising the mountains…', 0.76, 0.8);
      await nextFrame();
      range = createDistantRange({
        terrain,
        terrainOpts: TERRAIN,
        skyTexture: daylight.skyTexture,
        sunDirection: daylight.sunDirection,
      });

      post = createOutdoorPost({
        renderer,
        scene,
        camera,
        sunDirection: daylight.sunDirection,
        groundHeight: floorBox.max.y,
        skyTexture: daylight.skyTexture,
        sun: daylight.sun,
        // The mountains, and the sky they stand against: both belong to the
        // far pass, and the sky is only lent to it (see createOutdoorPost).
        distant: { ...range, sky: daylight.sky },
      });
      post.applyQuality(qualityPreset());

      // Compiled now, behind the screen, rather than as a stall on the first
      // frame outside.
      loadingScreen.status('Almost there…', 0.88, 0.98);
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
    get range() { return range; },

    /**
     * Draw the frame, if outside: through the fog and exposure chain.
     * Returns false inside, where the caller renders as it always has.
     */
    render(dt) {
      if (state !== 'outside' || !post) return false;
      followBook();
      grass?.update(dt);
      tree?.update(dt);
      // In VR the chain cannot run -- it renders into targets of its own,
      // which an XR session cannot present -- so the headset gets the clouds
      // and the exposure another way (outdoorPost.js's renderXR). The grass
      // and whatever VR holds in front of your face are kept out of its
      // metering.
      if (renderer.xr.isPresenting) post.renderXR(dt, { hide: [grass?.group, ...vrHidden()] });
      else post.render(dt);
      return true;
    },

    /** A click in the room. Returns true if it was on the door. */
    handleClick(event) {
      if (state !== 'inside' || !doorUnder(event)) return false;
      goOutside();
      return true;
    },

    /**
     * A right-click. Outside, on the bench and within reach, it sits you down
     * on it. Returns whether it did.
     */
    handleRightClick(event) {
      if (state !== 'outside' || !bench?.seat || !sit) return false;
      const rect = renderer.domElement.getBoundingClientRect();
      _ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      _raycaster.setFromCamera(_ndc, camera);
      // The bench and the ground only: a rise in the way hides it.
      const nearest = _raycaster.intersectObjects([bench.object, terrain].filter(Boolean), true)[0];
      if (!nearest || nearest.distance > SIT_REACH) return false;
      for (let o = nearest.object; o; o = o.parent) {
        if (o === bench.object) {
          sit(bench.seat);
          return true;
        }
      }
      return false;
    },

    goOutside,
    goInside,
  };
}