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
 * Fetch and decode a square 16-bit little-endian .raw heightmap.
 *
 * @param {string} url
 * @returns {Promise<{ size: number, heights: Float32Array }>}  `heights` is
 *   row by row from the top of the image, normalised to 0..1 across the
 *   map's own lowest and highest sample.
 */
export async function loadHeightmap(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Heightmap failed to load (${response.status})`);
  const buffer = await response.arrayBuffer();

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
 * A heightmap as a mesh, `width` metres on a side and `height` metres from
 * its lowest point to its highest, centred on the origin with its lowest
 * point at y = 0.
 *
 * @param {{ size: number, heights: Float32Array }} heightmap
 * @param {{ width?: number, height?: number, segments?: number }} [opts]
 * @returns {THREE.Mesh}
 */
export function createTerrain(heightmap, { width = 400, height = 60, segments = 255 } = {}) {
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
    position.setY(i, heightmap.heights[y * heightmap.size + x] * height);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // Sand, grass, rock and snow, laid on by slope and height.
  const mesh = new THREE.Mesh(geometry, createTerrainMaterial({ height }));
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * The terrain's height at a world x/z, read off the heightmap the mesh was
 * built from -- for standing something on it.
 */
export function terrainHeightAt(heightmap, terrain, x, z, { width = 400, height = 60 } = {}) {
  const u = THREE.MathUtils.clamp((x - terrain.position.x) / width + 0.5, 0, 1);
  const v = THREE.MathUtils.clamp((z - terrain.position.z) / width + 0.5, 0, 1);
  const last = heightmap.size - 1;
  const sample = heightmap.heights[Math.round(v * last) * heightmap.size + Math.round(u * last)];
  return terrain.position.y + sample * height;
}