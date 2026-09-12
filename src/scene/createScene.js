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

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 50);
  // Metres (scene/worldScale.js): roughly half a metre back from a book
  // about 16 cm across, keeping the old viewing direction.
  camera.position.set(-0.48, 0.27, 0.15);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
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
 */
function createEnvironment(scene, renderer) {
  const loader = new EXRLoader();
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  let current = null; // { url, raw, radiance }

  return {
    get url() { return current?.url ?? null; },

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