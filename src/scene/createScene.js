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

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(-3.2, 2.4, 1);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  await addEnvironment(scene, renderer);
  addLights(scene);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.0, 0);
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
    scene, camera, renderer, controls,
  };
}

// A background texture is never sampled by the lighting pipeline, so the EXR
// has to be prefiltered by PMREMGenerator into a radiance map on
// scene.environment for MeshStandardMaterial to pick it up as image-based
// lighting. Needs `renderer` (the prefilter is a real render pass). The raw
// EXR is kept as scene.background for a crisper backdrop than the blurred
// env map, so only the PMREMGenerator itself is disposed here.
async function addEnvironment(scene, renderer) {
  const rawEnv = await new EXRLoader().loadAsync('./public/background.exr');
  rawEnv.mapping = THREE.EquirectangularReflectionMapping;

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(rawEnv).texture;
  scene.background = rawEnv;
  pmrem.dispose();
}

// The EXR drives ambient/reflected light via scene.environment; the
// hemisphere light is just a low fill. The dedicated overhead `sun`
// DirectionalLight that used to live here has been removed -- the room is
// now lit only by the EXR environment (+ this fill) and, once loaded, the
// lamp's own point light (see lamp.js).
function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xaabbff, 0x1a1a1a, 0.15));
}