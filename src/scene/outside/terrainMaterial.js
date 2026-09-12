import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * The terrain's material: textures laid on by the shape of the ground.
 *
 * The same trick as UE4's slope-based auto-material. It is a
 * MeshStandardMaterial -- so lights, shadows and the environment all work
 * as usual -- with its colour step replaced in onBeforeCompile by a blend of
 * four layers:
 *
 *   sand   the lowest ground
 *   grass  everything else that is flat enough
 *   snow   the high ground
 *   rock   anywhere steep, over all of the above
 *
 * Steepness is dot(normal, up): 1 on flat ground, 0 on a cliff. Height is
 * the vertex's own height above the terrain's lowest point, as a fraction of
 * its full height. Each boundary is a smoothstep, so layers fade into each
 * other rather than meeting at a line.
 *
 * TRIPLANAR. Textures are projected from all three axes and blended by the
 * normal. A plain top-down projection smears a texture into streaks on a
 * steep face -- exactly where the rock is.
 *
 * BREAKING UP THE REPEAT, two landscape tricks from Unreal:
 *
 *   Distance tiling  every layer is sampled twice, at a small tile and a
 *                    large one, and crossfades from the first to the second
 *                    with distance from the camera -- detailed underfoot, and
 *                    no visible grid of repeats across a valley.
 *
 *   Macro variation  a light-to-dark noise texture sampled at three large,
 *                    unrelated scales, multiplied together and laid over the
 *                    ground, so the same texture reads as patchy rather than
 *                    uniform. The noise is generated here (macroVariation),
 *                    tileable, rather than loaded.
 *
 * THE TEXTURES come from public/textures, one file per layer. A .glb is read
 * for the first base-colour texture on any material inside it; any other
 * extension is loaded as an image. Until a layer's texture arrives (or if
 * its file has none) that layer is a flat colour, so the terrain always
 * shows its layout.
 */

const LAYERS = {
  // Poly Haven sets exported from Blender, one folder each; the base colour
  // on each file's material is that set's _diff map.
  sand: { url: '/textures/sand/coast_sand_01_2k.gltf', colour: 0xc9b58a },
  grass: { url: '/textures/grass/rocky_terrain_02_2k.gltf', colour: 0x5f7a3a },
  rock: { url: '/textures/rock/marble_cliff_05_2k.gltf', colour: 0x7a746c },
  snow: { url: '/textures/snow/snow_02_2k.gltf', colour: 0xf2f4f7 },
};

// Where the layers change, all tunable.
const BLEND = {
  // dot(normal, up): rock is complete below the first, gone above the second.
  // 0.7 is about 45 degrees, 0.88 about 28.
  rockSteep: 0.7,
  rockFlat: 0.88,
  // Fractions of the terrain's height.
  sandTop: 0.04,
  sandFade: 0.04,
  snowLine: 0.62,
  snowFade: 0.12,
};

// Metres of ground one texture repeat covers.
const TILE_SIZE = 6;

// Distance tiling: the repeat grows to FAR_TILE_SIZE, crossfading between
// these distances from the camera, in metres.
const DISTANCE_TILING = {
  farTile: 40,
  blendStart: 15,
  blendEnd: 120,
};

// Macro variation: how strongly it darkens and lightens the ground (0 off),
// and the three sizes, in metres, its noise repeats at -- far apart and not
// multiples of each other, so the three never line up into a pattern.
const MACRO_VARIATION = {
  strength: 0.5,
  scales: [23, 97, 331],
};

/**
 * Tileable light-to-dark noise: a few octaves of value noise on lattices that
 * wrap exactly at the edge, normalised to the full 0..1 range. Grey, linear,
 * sampled with repeat wrapping.
 */
function macroVariation(size = 256) {
  let seed = 1337;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const fade = (t) => t * t * (3 - 2 * t);

  const values = new Float32Array(size * size);
  let amplitude = 1;
  for (let cells = 4; cells <= 64; cells *= 2) {
    const lattice = Float32Array.from({ length: cells * cells }, random);
    const at = (x, y) => lattice[(y % cells) * cells + (x % cells)];
    for (let py = 0; py < size; py++) {
      const gy = (py / size) * cells;
      const y0 = Math.floor(gy);
      const ty = fade(gy - y0);
      for (let px = 0; px < size; px++) {
        const gx = (px / size) * cells;
        const x0 = Math.floor(gx);
        const tx = fade(gx - x0);
        const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
        const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        values[py * size + px] += (top + (bottom - top) * ty) * amplitude;
      }
    }
    amplitude *= 0.5;
  }

  let min = Infinity;
  let max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < values.length; i++) {
    const grey = Math.round(((values[i] - min) / (max - min || 1)) * 255);
    data.set([grey, grey, grey, 255], i * 4);
  }

  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** A 1x1 white texture, sampled until a layer's real one arrives. */
function blankTexture() {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.needsUpdate = true;
  return texture;
}

/** The texture in a layer's file, or null if it has none. */
async function loadLayerTexture(url) {
  if (/\.(glb|gltf)$/i.test(url)) {
    const gltf = await new GLTFLoader().loadAsync(url);
    let found = null;
    gltf.scene.traverse((object) => {
      if (found || !object.isMesh) return;
      for (const material of [object.material].flat()) {
        if (material?.map) { found = material.map; break; }
      }
    });
    return found;
  }
  const texture = await new THREE.TextureLoader().loadAsync(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * @param {{ height: number, onProgress?: (loaded: number, total: number) => void }} opts
 *   height: the terrain's full height, in its own units -- what the height
 *   fractions in BLEND are fractions of. onProgress: told as each layer's
 *   texture arrives, or gives up.
 * @returns {THREE.MeshStandardMaterial}  userData.ready resolves once every
 *   layer has its texture or has fallen back to its colour -- it never rejects
 */
export function createTerrainMaterial({ height, onProgress = null }) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });

  const uniforms = {
    terrainHeight: { value: height },
    terrainTile: { value: TILE_SIZE },
    terrainFarTile: { value: DISTANCE_TILING.farTile },
    terrainFarBlendStart: { value: DISTANCE_TILING.blendStart },
    terrainFarBlendEnd: { value: DISTANCE_TILING.blendEnd },
    terrainDistanceTiling: { value: 1 }, // 0 turns it off
    terrainMacroMap: { value: macroVariation() },
    terrainMacroScales: { value: new THREE.Vector3(...MACRO_VARIATION.scales) },
    terrainMacroStrength: { value: MACRO_VARIATION.strength },
    terrainRockSteep: { value: BLEND.rockSteep },
    terrainRockFlat: { value: BLEND.rockFlat },
    terrainSandTop: { value: BLEND.sandTop },
    terrainSandFade: { value: BLEND.sandFade },
    terrainSnowLine: { value: BLEND.snowLine },
    terrainSnowFade: { value: BLEND.snowFade },
  };
  for (const [name, layer] of Object.entries(LAYERS)) {
    uniforms[`${name}Map`] = { value: blankTexture() };
    // Multiplies the texture: the layer's own colour while it is blank,
    // white once the real texture is in.
    uniforms[`${name}Tint`] = { value: new THREE.Color(layer.colour) };
  }

  const total = Object.keys(LAYERS).length;
  let settled = 0;
  const loads = Object.entries(LAYERS).map(([name, layer]) => loadLayerTexture(layer.url)
      .then((texture) => {
        if (!texture) {
          console.warn(`Terrain: ${layer.url} has no texture in it; ${name} stays a flat colour.`);
          return;
        }
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = 8;
        texture.needsUpdate = true;
        uniforms[`${name}Map`].value = texture;
        uniforms[`${name}Tint`].value.set(0xffffff);
      })
      .catch((err) => {
        console.warn(`Terrain: ${layer.url} failed to load; ${name} stays a flat colour.`, err);
      })
      .finally(() => {
        settled += 1;
        onProgress?.(settled, total);
      }));
  material.userData.ready = Promise.all(loads);
  // Live, for tuning (debug/outdoorPanel.js): the shader reads these objects.
  material.userData.uniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTerrainPosition;
        varying vec3 vTerrainNormal;
        varying vec3 vTerrainWorld;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        // The terrain's own space: height measured from its lowest point, and
        // textures that stay put on the ground however the mesh is placed.
        vTerrainPosition = transformed;
        vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);
        // World space, for the distance to the camera.
        vTerrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTerrainPosition;
        varying vec3 vTerrainNormal;
        varying vec3 vTerrainWorld;
        uniform float terrainHeight;
        uniform float terrainTile;
        uniform float terrainFarTile;
        uniform float terrainFarBlendStart;
        uniform float terrainFarBlendEnd;
        uniform float terrainDistanceTiling;
        uniform sampler2D terrainMacroMap;
        uniform vec3 terrainMacroScales;
        uniform float terrainMacroStrength;
        uniform float terrainRockSteep;
        uniform float terrainRockFlat;
        uniform float terrainSandTop;
        uniform float terrainSandFade;
        uniform float terrainSnowLine;
        uniform float terrainSnowFade;
        uniform sampler2D sandMap;
        uniform sampler2D grassMap;
        uniform sampler2D rockMap;
        uniform sampler2D snowMap;
        uniform vec3 sandTint;
        uniform vec3 grassTint;
        uniform vec3 rockTint;
        uniform vec3 snowTint;

        // ONLY WHAT SHOWS. Every sample below sits behind a branch that skips
        // it when its weight is nothing -- a projection the surface does not
        // face, a tile size out of range, a layer that is not there -- which
        // leaves most pixels one or two texture reads instead of 24. The
        // samples use textureGrad with derivatives taken once, before any
        // branch: inside a branch the implicit ones are undefined, and the mip
        // choice would break along every seam.

        // A texture projected along the axes the surface faces.
        vec3 terrainTriplanar(sampler2D map, vec3 p, vec3 dpdx, vec3 dpdy, vec3 weights, float tile) {
          vec3 colour = vec3(0.0);
          if (weights.x > 0.0) colour += textureGrad(map, p.zy / tile, dpdx.zy / tile, dpdy.zy / tile).rgb * weights.x;
          if (weights.y > 0.0) colour += textureGrad(map, p.xz / tile, dpdx.xz / tile, dpdy.xz / tile).rgb * weights.y;
          if (weights.z > 0.0) colour += textureGrad(map, p.xy / tile, dpdx.xy / tile, dpdy.xy / tile).rgb * weights.z;
          return colour;
        }

        // One layer, at the near tile crossfading to the far one -- each only
        // where it is in range.
        vec3 terrainLayer(sampler2D map, vec3 p, vec3 dpdx, vec3 dpdy, vec3 weights, float farBlend) {
          vec3 colour = vec3(0.0);
          if (farBlend < 0.999) colour += terrainTriplanar(map, p, dpdx, dpdy, weights, terrainTile) * (1.0 - farBlend);
          if (farBlend > 0.001) colour += terrainTriplanar(map, p, dpdx, dpdy, weights, terrainFarTile) * farBlend;
          return colour;
        }`)
      .replace('#include <map_fragment>', `
        vec3 terrainN = normalize(vTerrainNormal);
        // Sharpened, so a face takes mostly one projection and the three do
        // not blur into each other across a slope.
        vec3 weights = pow(abs(terrainN), vec3(4.0));
        weights /= max(weights.x + weights.y + weights.z, 1e-5);
        // A projection contributing under 2% is dropped, and the rest scaled
        // back up to make the whole again.
        weights *= step(vec3(0.02), weights);
        weights /= max(weights.x + weights.y + weights.z, 1e-5);

        vec3 dpdx = dFdx(vTerrainPosition);
        vec3 dpdy = dFdy(vTerrainPosition);

        float farBlend = terrainDistanceTiling * smoothstep(
          terrainFarBlendStart, terrainFarBlendEnd, distance(vTerrainWorld, cameraPosition));

        // The layer blend, worked out as four weights before anything is
        // sampled -- the same result as mixing sand to grass by height, then
        // in snow by height, then rock by slope.
        float up = terrainN.y; // dot(normal, up): 1 flat, 0 a cliff
        float heightFraction = clamp(vTerrainPosition.y / max(terrainHeight, 1e-5), 0.0, 1.0);
        float toGrass = smoothstep(terrainSandTop, terrainSandTop + terrainSandFade, heightFraction);
        float toSnow = smoothstep(terrainSnowLine, terrainSnowLine + terrainSnowFade, heightFraction);
        float notRock = smoothstep(terrainRockSteep, terrainRockFlat, up);
        float sandWeight = (1.0 - toGrass) * (1.0 - toSnow) * notRock;
        float grassWeight = toGrass * (1.0 - toSnow) * notRock;
        float snowWeight = toSnow * notRock;
        float rockWeight = 1.0 - notRock;

        vec3 ground = vec3(0.0);
        if (sandWeight > 0.001) ground += terrainLayer(sandMap, vTerrainPosition, dpdx, dpdy, weights, farBlend) * sandTint * sandWeight;
        if (grassWeight > 0.001) ground += terrainLayer(grassMap, vTerrainPosition, dpdx, dpdy, weights, farBlend) * grassTint * grassWeight;
        if (snowWeight > 0.001) ground += terrainLayer(snowMap, vTerrainPosition, dpdx, dpdy, weights, farBlend) * snowTint * snowWeight;
        if (rockWeight > 0.001) ground += terrainLayer(rockMap, vTerrainPosition, dpdx, dpdy, weights, farBlend) * rockTint * rockWeight;

        // Macro variation: three samples of the noise, each 0.5..1.5 so
        // their product averages 1 and the ground's overall brightness holds.
        vec2 macroUv = vTerrainPosition.xz;
        float macro = (0.5 + texture2D(terrainMacroMap, macroUv / terrainMacroScales.x).r)
          * (0.5 + texture2D(terrainMacroMap, macroUv / terrainMacroScales.y).r)
          * (0.5 + texture2D(terrainMacroMap, macroUv / terrainMacroScales.z).r);
        ground *= mix(1.0, macro, terrainMacroStrength);

        diffuseColor.rgb *= ground;`);
  };

  return material;
}