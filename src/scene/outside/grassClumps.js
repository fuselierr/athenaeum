import * as THREE from 'three';
import { loadGLTF } from '../models.js';
import { WIND_NOISE_URL } from './wind.js';

/**
 * The tuft of grass a blade is made of, at three levels of detail.
 *
 * WHAT CHANGED, AND WHY. The grass used to be one triangle per blade, built
 * from nothing in the vertex shader (scene/outside/grass.js). That is as cheap
 * as grass gets and it reads as grass at a distance, but up close a triangle
 * is a triangle: hard-edged, flat, and unmistakably a single polygon. This is
 * a modelled clump of blades instead, its shape cut out of an alpha texture,
 * so one instance is a TUFT rather than a blade and the edges are the
 * texture's rather than the mesh's.
 *
 * From FluffyGrass (thebenezer/FluffyGrass, MIT) -- its grassLODs.glb and the
 * blade mask that cuts it out. The technique is the usual one for grass in
 * games; what that project had that was worth taking is the art.
 *
 * THREE LEVELS, AND THE CHUNKS PICK. 66 triangles a tuft against the old 1 is
 * sixty-six times the geometry, and at 900 tufts a chunk over a hundred and
 * sixty-nine chunks that matters. The model ships LOD00/01/02 at 66, 32 and 16
 * triangles, and because the grass is already drawn as a grid of chunks, the
 * LOD can be chosen per CHUNK from its distance -- one geometry swap for nine
 * hundred tufts, no per-instance work at all. The chunk grid was built for
 * streaming; this is the same grid paying for itself twice.
 *
 * NORMALISED TO A METRE TALL. The model is about 0.14 units high, which is
 * its own business; every tuft is scaled by the height its instance was given
 * (grass.js's bladeData), and that arithmetic is much clearer if the thing
 * being scaled is 1.
 */

const CLUMPS_URL = '/grass/clumps.glb';
const BLADES_URL = '/grass/blades.jpg';

// The levels in the GLB, nearest first. A chunk takes the first one it is
// close enough for (grass.js's update).
//
// Matched as a SUBSTRING of the mesh's name, not as the whole of it: the
// nodes are called "Grass.LOD00" and three's GLTFLoader runs every name
// through PropertyBinding.sanitizeNodeName on the way in, which strips dots
// and brackets because they mean something in an animation path. So the name
// that arrives is "GrassLOD00", and asking for the one in the file finds
// nothing at all.
const LEVELS = ['LOD00', 'LOD01', 'LOD02'];

/**
 * Load the tuft and its mask.
 *
 * Downloaded alongside the land, like the bench and the tree, and handed to
 * createGrass -- which stays synchronous, because the chunk grid it builds
 * has nothing to wait for.
 *
 * @returns {Promise<{ levels: THREE.BufferGeometry[], height: number,
 *   blades: THREE.Texture, windNoise: THREE.Texture, dispose(): void }>}
 *   `levels` nearest first, each normalised to stand 1 unit tall with its
 *   root at y = 0; `height` is what it measured before that.
 */
export async function loadGrassClumps() {
  const gltf = await loadGLTF(CLUMPS_URL);

  // Every mesh in the file, by name, so the levels can be picked out of it.
  const meshes = [];
  gltf.scene.traverse((child) => { if (child.isMesh) meshes.push(child); });

  const levels = [];
  let height = 1;
  for (const name of LEVELS) {
    const source = meshes.find((mesh) => mesh.name.includes(name)
      || mesh.parent?.name?.includes(name));
    if (!source) continue;

    const geometry = source.geometry.clone();
    // Everything else here is in metres; the model is not.
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const tall = Math.max(box.max.y - box.min.y, 1e-4);
    // The finest level sets the scale, and the others follow it -- they are
    // the same tuft and have to stand the same height, whatever their own
    // boxes happen to measure.
    if (levels.length === 0) height = tall;
    geometry.translate(0, -box.min.y, 0); // root on the ground
    geometry.scale(1 / height, 1 / height, 1 / height);
    // Only what the shader reads. A stray colour or tangent attribute would
    // be uploaded for every chunk that shares this geometry.
    for (const attribute of Object.keys(geometry.attributes)) {
      if (!['position', 'normal', 'uv'].includes(attribute)) geometry.deleteAttribute(attribute);
    }
    levels.push(geometry);
  }

  if (levels.length === 0) throw new Error('grass/clumps.glb has no LOD meshes in it');

  const blades = await new THREE.TextureLoader().loadAsync(BLADES_URL);
  // Read as a mask, not as colour: it decides which pixels of the card are a
  // blade and which are the gaps between them, and sRGB would bend the
  // cutoff.
  blades.colorSpace = THREE.NoColorSpace;
  blades.wrapS = THREE.ClampToEdgeWrapping;
  blades.wrapT = THREE.ClampToEdgeWrapping;
  // Mipped, or a field of tufts is a field of crawling white speckle as the
  // cutoff catches different texels each frame.
  blades.generateMipmaps = true;
  blades.minFilter = THREE.LinearMipmapLinearFilter;
  blades.magFilter = THREE.LinearFilter;
  blades.anisotropy = 4;

  // The wind's own noise field (scene/outside/wind.js). Loaded here because
  // this is where the grass's textures come from, and handed on to the tree
  // as well -- one field, so one gust crosses both.
  const windNoise = await new THREE.TextureLoader().loadAsync(WIND_NOISE_URL);
  windNoise.colorSpace = THREE.NoColorSpace; // a field of numbers, not a picture
  windNoise.wrapS = THREE.RepeatWrapping;
  windNoise.wrapT = THREE.RepeatWrapping;

  return {
    levels,
    height,
    blades,
    windNoise,
    dispose() {
      for (const geometry of levels) geometry.dispose();
      blades.dispose();
      windNoise.dispose();
    },
  };
}
