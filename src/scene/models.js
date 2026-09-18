import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Loading models.
 *
 * ONE LOADER for the whole app, rather than a new one wherever a model is
 * loaded. It costs nothing to share, and it is the one place to teach every
 * model a new trick -- compressed meshes (Draco, meshopt) or textures (KTX2)
 * are a loader setting, and set here they reach the desk and the egg chair
 * alike.
 */
const loader = new GLTFLoader();

/**
 * Load a glTF model.
 *
 * @param {string} url
 * @returns {Promise<import('three/addons/loaders/GLTFLoader.js').GLTF>}
 */
export function loadGLTF(url) {
  return loader.loadAsync(url);
}

/**
 * Every mesh under `root` casting a shadow and taking one -- what a solid piece
 * of furniture wants.
 *
 * @param {THREE.Object3D} root
 * @param {{ cast?: boolean, receive?: boolean }} [opts]
 * @returns {THREE.Object3D} `root`
 */
export function enableShadows(root, { cast = true, receive = true } = {}) {
  root.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = cast;
    child.receiveShadow = receive;
  });
  return root;
}
