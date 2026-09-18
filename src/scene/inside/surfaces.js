import * as THREE from 'three';
import { loadGLTF } from '../models.js';

/**
 * What the room is made of: the floorboards, the plywood walls, and the coated
 * pine everything built of wood is finished in -- the balcony, the ceiling and
 * the shelves run along the wall.
 *
 * Each is a Poly Haven texture set shipped as a glTF (public/textures) --
 * a plane wearing a full PBR material: colour, normal, and roughness (the
 * floor's also carries ambient occlusion and metalness, packed into one
 * image). The material is taken straight off that plane, so every map comes
 * with the colour space and channel the glTF gave it, and nothing here has
 * to know which maps a set happens to include.
 *
 * TILING. Every surface in the room has its UVs in METRES (room.js's walls
 * get that from ShapeGeometry, floor.js lays the floor's out to match), so a
 * texture's repeat is simply one over how many metres one copy of it covers,
 * and the same set would tile a wall and a floor at the same real size.
 */

const SURFACES = {
  // One copy of the texture, in metres. Raise to make the planks or the
  // plywood grain larger.
  floor: { url: '/textures/old_wooden_floor/old_wooden_floor_02_2k.gltf', tile: 1.6 },
  walls: { url: '/textures/plywood/plywood_2k.gltf', tile: 1.6 },
  // The joinery. Finer than the floor and the walls: it is seen close to, on
  // pieces a few centimetres across (scene/inside/woodwork.js lays their UVs
  // out in metres so it tiles the same real size on all of them).
  pine: { url: '/textures/coated_pine_2k.gltf/coated_pine_2k.gltf', tile: 1 },
};

/** The material off a texture set's glTF, tiled `tile` metres to a copy. */
async function loadSurface({ url, tile }) {
  const gltf = await loadGLTF(url);
  let material = null;
  gltf.scene.traverse((object) => {
    if (material || !object.isMesh) return;
    material = [object.material].flat()[0] ?? null;
  });
  // The plane it came on is not wanted -- only what it was wearing.
  gltf.scene.traverse((object) => { if (object.isMesh) object.geometry.dispose(); });
  if (!material) throw new Error(`${url} has no material in it`);

  for (const value of Object.values(material)) {
    if (!value?.isTexture) continue;
    value.wrapS = THREE.RepeatWrapping;
    value.wrapT = THREE.RepeatWrapping;
    value.repeat.set(1 / tile, 1 / tile);
    value.anisotropy = 8;
    value.needsUpdate = true;
  }
  // Facing into the room only, as every room surface is: from outside it,
  // the walls are simply not drawn (room.js). A texture set's glTF is often
  // double-sided, which would put the walls in front of the orbit camera.
  material.side = THREE.FrontSide;
  material.needsUpdate = true;
  return material;
}

/**
 * Load the room's surfaces. Never rejects: a set that does not load comes back
 * null, and whatever it was for keeps its plain colour.
 *
 * @returns {Promise<{ floor: THREE.Material|null, walls: THREE.Material|null,
 *   pine: THREE.Material|null }>}
 */
export async function loadRoomSurfaces() {
  const load = (name) => loadSurface(SURFACES[name]).catch((err) => {
    console.warn(`The room's ${name} texture did not load; it stays a plain colour.`, err);
    return null;
  });
  const [floor, walls, pine] = await Promise.all([load('floor'), load('walls'), load('pine')]);
  return { floor, walls, pine };
}
