import * as THREE from 'three';
import { createTerrainMaterial } from './terrainMaterial.js';

/**
 * Terrain from a heightmap.
 *
 * THE FILE. A .raw heightmap is nothing but samples: no header, no size, no
 * byte order written down. public/heightmaps/swissalps.raw is 16-bit
 * unsigned, little-endian, 2048 x 2048 -- 8 MiB is exactly 2048^2 samples of
 * two bytes each, and read little-endian its first samples step smoothly
 * (1088, 1083, 1078...) where big-endian they jump by thousands. A square
 * map's side can be worked out from the byte count, so only the sample size
 * has to be given.
 *
 * THE MESH. A PlaneGeometry laid flat, with each vertex lifted to the height
 * under it -- sampled, not one vertex per pixel: 2048^2 is four million
 * vertices, and SEGMENTS worth of grid is plenty to see the shape.
 */

/**
 * A response body, read a chunk at a time so `onProgress` can be told how
 * much of it has arrived (0..1). Falls back to a plain read when there is no
 * one to tell, or no length to measure against.
 */
async function readBody(response, onProgress) {
  const total = Number(response.headers.get('content-length'));
  if (!onProgress || !total || !response.body) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    // Capped: a compressed response's length is its compressed size.
    onProgress(Math.min(received / total, 1));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/**
 * Fetch and decode a square 16-bit little-endian .raw heightmap.
 *
 * @param {string} url
 * @param {((fraction: number) => void)|null} [onProgress]  how much of the
 *   file has downloaded, 0..1
 * @returns {Promise<{ size: number, heights: Float32Array }>}  `heights` is
 *   row by row from the top of the image, normalised to 0..1 across the
 *   map's own lowest and highest sample.
 */
export async function loadHeightmap(url, onProgress = null) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Heightmap failed to load (${response.status})`);
  const buffer = await readBody(response, onProgress);

  const count = buffer.byteLength / 2;
  const size = Math.round(Math.sqrt(count));
  if (size * size !== count) {
    throw new Error(`Heightmap is not a square 16-bit map (${buffer.byteLength} bytes)`);
  }

  // A DataView with the byte order said out loud, rather than a Uint16Array
  // that would silently take the machine's own.
  const view = new DataView(buffer);
  const heights = new Float32Array(count);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    const value = view.getUint16(i * 2, true);
    heights[i] = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const range = max - min || 1;
  for (let i = 0; i < count; i++) heights[i] = (heights[i] - min) / range;

  return { size, heights };
}

/**
 * How high the ground stands for a heightmap sample (0..1), in metres.
 *
 * `sharpness` bends the sample before anything else: above 1 it presses the
 * low ground down harder than the high ground, so valley floors stay low and
 * the walls climbing out of them steepen, while the peaks keep their height.
 * `exaggeration` then multiplies the whole of it -- every mountain taller and
 * every slope steeper by that factor. Both 1 is the map as it is, `height`
 * metres from lowest to highest.
 */
export function displacement(sample, { height = 60, exaggeration = 1, sharpness = 1 } = {}) {
  return Math.pow(sample, sharpness) * height * exaggeration;
}

/** The terrain's full height, lowest point to highest, once exaggerated. */
export function terrainRelief({ height = 60, exaggeration = 1 } = {}) {
  return height * exaggeration;
}

/**
 * A heightmap as a mesh, `width` metres on a side, standing
 * terrainRelief(opts) metres from its lowest point to its highest, centred on
 * the origin with its lowest point at y = 0.
 *
 * @param {{ size: number, heights: Float32Array }} heightmap
 * @param {{ width?: number, height?: number, exaggeration?: number, sharpness?: number,
 *   segments?: number, onTextureProgress?: (loaded: number, total: number) => void }} [opts]
 *   height, exaggeration and sharpness: see displacement
 *   onTextureProgress: each ground texture as it arrives (or gives up);
 *   mesh.material.userData.ready resolves once they all have
 * @returns {THREE.Mesh}
 */
export function createTerrain(heightmap, {
  width = 400, height = 60, exaggeration = 1, sharpness = 1, segments = 255, onTextureProgress = null,
} = {}) {
  const relief = { height, exaggeration, sharpness };
  const geometry = new THREE.PlaneGeometry(width, width, segments, segments);
  // Flat on the ground. The plane's rows run from its +Y edge down, which
  // after this turn is from -Z toward +Z: row 0 of the image is the far edge.
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.attributes.position;
  const columns = segments + 1;
  const last = heightmap.size - 1;
  for (let i = 0; i < position.count; i++) {
    const column = i % columns;
    const row = Math.floor(i / columns);
    // Nearest sample under the vertex.
    const x = Math.round((column / segments) * last);
    const y = Math.round((row / segments) * last);
    position.setY(i, displacement(heightmap.heights[y * heightmap.size + x], relief));
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // Sand, grass, rock and snow, laid on by slope and height.
  // The material's height bands (sand, snow) are fractions of the full,
  // exaggerated height, so they rise with the mountains.
  const mesh = new THREE.Mesh(geometry, createTerrainMaterial({
    height: terrainRelief(relief),
    onProgress: onTextureProgress,
  }));
  mesh.name = 'terrain';
  // Both: a ridge throws its shadow down the valley beside it.
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A value off the terrain's grid at a world x/z, blended between the four
 * vertices around it -- so it is exactly the surface the mesh draws, where
 * terrainHeightAt reads the heightmap the mesh was sampled from. For standing
 * on the ground (input/cameraModes.js, through scene/outside/outside.js) and planting
 * in it (scene/outside/grass.js). Outside the grid it clamps to the edge.
 *
 * @param {THREE.Mesh} mesh  createTerrain's mesh, placed
 * @param {'position'|'normal'} attribute
 * @param {number} component  0 x, 1 y, 2 z -- positions are the mesh's own,
 *   so a height needs mesh.position.y added
 * @param {{ width?: number, segments?: number }} [opts]  as the mesh was made
 */
export function sampleTerrain(mesh, attribute, component, x, z, { width = 400, segments = 255 } = {}) {
  const values = mesh.geometry.attributes[attribute];
  const columns = segments + 1;
  // Grid rows run from -Z to +Z (see createTerrain's rotation), columns -X to +X.
  const gx = THREE.MathUtils.clamp(((x - mesh.position.x) / width + 0.5) * segments, 0, segments);
  const gz = THREE.MathUtils.clamp(((z - mesh.position.z) / width + 0.5) * segments, 0, segments);
  const c = Math.min(Math.floor(gx), segments - 1);
  const r = Math.min(Math.floor(gz), segments - 1);
  const tx = gx - c;
  const tz = gz - r;
  const at = (col, row) => values.getComponent(row * columns + col, component);
  const top = at(c, r) + (at(c + 1, r) - at(c, r)) * tx;
  const bottom = at(c, r + 1) + (at(c + 1, r + 1) - at(c, r + 1)) * tx;
  return top + (bottom - top) * tz;
}

/**
 * Free everything createTerrain made on the GPU: its geometry, its material,
 * and every texture the material holds -- the four ground layers (or their
 * blank stand-ins) and the macro variation noise.
 */
export function disposeTerrain(mesh) {
  mesh.geometry.dispose();
  for (const uniform of Object.values(mesh.material.userData.uniforms ?? {})) {
    if (uniform.value?.isTexture) uniform.value.dispose();
  }
  mesh.material.dispose();
}

/**
 * The terrain's height at a world x/z, read off the heightmap the mesh was
 * built from -- for standing something on it.
 */
export function terrainHeightAt(heightmap, terrain, x, z, {
  width = 400, height = 60, exaggeration = 1, sharpness = 1,
} = {}) {
  const u = THREE.MathUtils.clamp((x - terrain.position.x) / width + 0.5, 0, 1);
  const v = THREE.MathUtils.clamp((z - terrain.position.z) / width + 0.5, 0, 1);
  const last = heightmap.size - 1;
  const sample = heightmap.heights[Math.round(v * last) * heightmap.size + Math.round(u * last)];
  return terrain.position.y + displacement(sample, { height, exaggeration, sharpness });
}