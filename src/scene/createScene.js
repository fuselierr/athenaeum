import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

/**
 * Builds the renderer, camera, orbit controls, environment lighting and
 * shadow light, and installs the window-resize handler. Returns the handles
 * main.js needs to run the render loop.
 */
export async function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11141a); // until the EXR below loads
  scene.fog = new THREE.Fog(0x11141a, 8, 20);

  // 70 degrees: the settings' default (state/settings.js), which bindSettings
  // applies -- given here too so the first frames are not drawn narrower.
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
  // Metres (scene/worldScale.js): roughly half a metre back from a book
  // about 16 cm across, keeping the old viewing direction.
  camera.position.set(-0.48, 0.27, 0.15);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    // Ask for the faster GPU on a machine with two -- a laptop's dedicated
    // card over its built-in graphics. Only a hint the browser or the OS may
    // overrule; ui/gpuNotice.js checks what was actually given.
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  const environment = createEnvironment(scene, renderer);
  addLights(scene);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.06, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // Right-drag no longer pans the camera -- main.js repurposes it to rotate
  // the book itself instead, and drives its own WASD-based camera pan in
  // place of what right-drag used to do. Left-drag still orbits, middle
  // still dollies.
  controls.mouseButtons.RIGHT = null;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return {
    scene, camera, renderer, controls, environment,
  };
}

/**
 * The backdrop, and the room's light -- which are the same object.
 *
 * A background texture is never sampled by the lighting pipeline, so the
 * EXR has to be prefiltered by PMREMGenerator into a radiance map on
 * scene.environment for MeshStandardMaterial to pick it up as image-based
 * lighting. The raw EXR is kept as scene.background as well, being a
 * crisper backdrop than the blurred radiance map.
 *
 * The generator is kept alive between switches rather than disposed after
 * the first load: it is reusable, and rebuilding it per background would
 * throw away its compiled shader every time the user tried another sky.
 *
 * LIT BY THE ROOM, ONCE THERE IS ONE. Image-based lighting has no notion of
 * what is in the way: every surface is lit by the whole sky, as if the room
 * had no walls. So once the room is built (lightFromRoom), the light it is
 * given is not the sky but a picture of the ROOM, taken from its middle -- a
 * cube of the walls, the ceiling and the balcony, with the sky showing only
 * through the windows. The light then comes in from where the windows are,
 * the walls give back a dim bounce, and anything shiny reflects the room
 * rather than open sky.
 *
 * TWICE, for the bounce. The first picture is of a room lit by the whole sky,
 * which is too bright everywhere; the second is of the room lit by the first,
 * which is near enough what it settles to. Taken again when the backdrop
 * changes or the walls come down (refreshRoom) -- with the walls gone the room
 * is open to the sky, and the sky is the light again. Never per frame: one
 * room, one picture, nothing to pay while you are in it.
 */
const ROOM_CAPTURE_SIZE = 256; // texels a side of the cube the room is pictured in
const ROOM_BOUNCES = 2;

function createEnvironment(scene, renderer) {
  const loader = new EXRLoader();
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  let current = null; // { url, raw, radiance }

  // Lighting from the room: where it is pictured from, and whether it is
  // closed in at the moment (the walls can be hidden). Null until there is one.
  let room = null;
  let roomLight = null; // the render target the room's light is in
  // A picture asked for while you were not in the room -- outside, where the
  // scene is a meadow -- and still owed to it.
  let owed = false;
  const cubeTarget = new THREE.WebGLCubeRenderTarget(ROOM_CAPTURE_SIZE, {
    type: THREE.HalfFloatType,
    generateMipmaps: false,
  });
  const cubeCamera = new THREE.CubeCamera(0.05, 500, cubeTarget);

  function captureRoom() {
    if (!room || !current) return;
    if (!room.here()) {
      owed = true;
      return;
    }
    owed = false;
    const previous = roomLight;
    roomLight = null;
    if (!room.enclosed()) {
      // Open to the sky: the sky is the light.
      scene.environment = current.radiance;
    } else {
      cubeCamera.position.copy(room.at);
      // Nothing moves between the twelve faces of the two bounces, so the
      // shadow maps are drawn for the first and kept for the rest -- the
      // lamp's alone is six passes each time.
      const shadowsAuto = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = true;
      let light = null;
      for (let bounce = 0; bounce < ROOM_BOUNCES; bounce++) {
        scene.environment = light?.texture ?? current.radiance;
        cubeCamera.update(renderer, scene);
        const next = pmrem.fromCubemap(cubeTarget.texture);
        light?.dispose();
        light = next;
      }
      renderer.shadowMap.autoUpdate = shadowsAuto;
      roomLight = light;
      scene.environment = roomLight.texture;
    }
    previous?.dispose();
  }

  return {
    get url() { return current?.url ?? null; },

    /**
     * From now on, light the room with a picture of itself taken from `at`,
     * rather than with the sky it stands in -- see LIT BY THE ROOM. Call once
     * the room and everything in it is built. `enclosed` says whether its
     * walls are up at the moment, `here` whether you are in it -- a picture
     * asked for while you are not is taken when you are back (refreshRoom).
     *
     * @param {{ at: THREE.Vector3, enclosed: () => boolean, here: () => boolean }} opts
     */
    lightFromRoom({ at, enclosed, here }) {
      room = { at: at.clone(), enclosed, here };
      captureRoom();
    },

    /**
     * Take the room's picture again: the walls have come down or gone back
     * up. With `onlyIfOwed`, only if one was asked for while you were away.
     */
    refreshRoom({ onlyIfOwed = false } = {}) {
      if (onlyIfOwed && !owed) return;
      captureRoom();
    },

    /** Load `url` and make it the room. Resolves once it is actually up. */
    async set(url) {
      if (current?.url === url) return;
      const raw = await loader.loadAsync(url);
      raw.mapping = THREE.EquirectangularReflectionMapping;
      const radiance = pmrem.fromEquirectangular(raw).texture;

      // Swap first, dispose second: the outgoing textures are still bound
      // to the last frame the renderer drew.
      const previous = current;
      scene.environment = radiance;
      scene.background = raw;
      current = { url, raw, radiance };
      // And the room pictured again, under its new sky.
      captureRoom();
      previous?.raw.dispose();
      previous?.radiance.dispose();
    },
  };
}

// The EXR drives ambient/reflected light via scene.environment; the
// hemisphere light is just a low fill. The dedicated overhead `sun`
// DirectionalLight that used to live here has been removed -- the room is
// now lit only by the EXR environment (+ this fill) and, once loaded, the
// lamp's own point light (see lamp.js).
function addLights(scene) {
  const fill = new THREE.HemisphereLight(0xaabbff, 0x1a1a1a, 0.15);
  fill.name = 'roomFill'; // found by name to switch off outside (scene/outside/outside.js)
  scene.add(fill);
}