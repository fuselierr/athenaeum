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
 * @param {{ height: number }} opts  the terrain's full height, in its own
 *   units -- what the height fractions in BLEND are fractions of
 * @returns {THREE.MeshStandardMaterial}
 */
export function createTerrainMaterial({ height }) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });

  const uniforms = {
    terrainHeight: { value: height },
    terrainTile: { value: TILE_SIZE },
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

  for (const [name, layer] of Object.entries(LAYERS)) {
    loadLayerTexture(layer.url)
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
      });
  }

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTerrainPosition;
        varying vec3 vTerrainNormal;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        // The terrain's own space: height measured from its lowest point, and
        // textures that stay put on the ground however the mesh is placed.
        vTerrainPosition = transformed;
        vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTerrainPosition;
        varying vec3 vTerrainNormal;
        uniform float terrainHeight;
        uniform float terrainTile;
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

        // A texture projected along all three axes, each weighted by how
        // squarely the surface faces that axis.
        vec3 terrainTriplanar(sampler2D map, vec3 p, vec3 weights) {
          vec3 alongX = texture2D(map, p.zy / terrainTile).rgb;
          vec3 alongY = texture2D(map, p.xz / terrainTile).rgb;
          vec3 alongZ = texture2D(map, p.xy / terrainTile).rgb;
          return alongX * weights.x + alongY * weights.y + alongZ * weights.z;
        }`)
      .replace('#include <map_fragment>', `
        vec3 terrainN = normalize(vTerrainNormal);
        // Sharpened, so a face takes mostly one projection and the three do
        // not blur into each other across a slope.
        vec3 weights = pow(abs(terrainN), vec3(4.0));
        weights /= max(weights.x + weights.y + weights.z, 1e-5);

        vec3 sand = terrainTriplanar(sandMap, vTerrainPosition, weights) * sandTint;
        vec3 grass = terrainTriplanar(grassMap, vTerrainPosition, weights) * grassTint;
        vec3 rock = terrainTriplanar(rockMap, vTerrainPosition, weights) * rockTint;
        vec3 snow = terrainTriplanar(snowMap, vTerrainPosition, weights) * snowTint;

        float up = terrainN.y; // dot(normal, up): 1 flat, 0 a cliff
        float heightFraction = clamp(vTerrainPosition.y / max(terrainHeight, 1e-5), 0.0, 1.0);

        vec3 ground = mix(sand, grass,
          smoothstep(terrainSandTop, terrainSandTop + terrainSandFade, heightFraction));
        ground = mix(ground, snow,
          smoothstep(terrainSnowLine, terrainSnowLine + terrainSnowFade, heightFraction));
        ground = mix(rock, ground, smoothstep(terrainRockSteep, terrainRockFlat, up));

        diffuseColor.rgb *= ground;`);
  };

  return material;
}