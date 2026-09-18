import * as THREE from 'three';
import { seeded } from '../seeded.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Volumetric clouds: a layer of cloud between two altitudes, ray-marched per
 * pixel -- the approach of Guerrilla's "Nubis" (Horizon Zero Dawn), cut down
 * to what a small outdoor scene with the clouds far overhead needs.
 *
 * THE SHAPE is noise in three dimensions, generated here, tileable:
 *
 *   shape    Perlin-Worley -- smooth value noise pushed into billows by
 *            Worley noise -- at a few kilometres a repeat. Where it rises
 *            above (1 - coverage) there is cloud.
 *   detail   Worley noise at a few hundred metres, eating away at the edges
 *            so they are wispy rather than blobby.
 *   weather  a flat map of its own, tens of kilometres a repeat, varying the
 *            coverage across the sky so clouds come in groups with gaps --
 *            and which slice of the shape noise each patch reads, and how
 *            tall its clouds grow.
 *
 * NOT A GRID. A 64^3 tile of noise stamped out every few kilometres along the
 * world's axes reads, from the ground, as rows of clouds. So every field is
 * turned its own way, the weather bends the shape noise and picks a different
 * depth of it from patch to patch, and the weather map itself repeats far
 * less often than anything you can see at once.
 *
 * A height profile rounds the bottoms and softens the tops. Wind slides all
 * of it along.
 *
 * ABOVE IT, CIRRUS at ~9.5 km: a thin sheet that is not marched at all -- one
 * texture read, lit as a single slab -- of ice streaks combed out along the
 * (faster, turned) wind aloft. It is a shell around a round planet rather
 * than a flat sheet, so it comes down to the horizon a few hundred kilometres
 * off. The cumulus stays a flat layer.
 *
 * BEHIND THE MOUNTAINS. The far pass's mountains are not in the scene's depth
 * buffer, so outdoorPost hands this pass how far away they are along each
 * ray. Cloud that has passed a range -- further along the ray than the rock
 * -- is hidden; cloud short of it is drawn over it, and the cumulus thins
 * out over the last stretch before a slope instead of stopping dead on it.
 *
 * THE LIGHT, per step along the view ray through the layer:
 *
 *   sun      a short march toward the sun measures how much cloud it has come
 *            through (Beer-Lambert), with a "powder" term darkening the
 *            thinnest edges; a two-lobe Henyey-Greenstein phase makes the
 *            silver lining toward the sun.
 *   ambient  the sky's own colour from above, from the same cubemap the fog
 *            uses (scene/outside/outdoorLight.js), brighter toward the tops.
 *
 * Scattering is integrated the energy-conserving way (each step adds what
 * that step's extinction scatters, weighted by how much light still gets
 * through to the camera), so the result is a colour to add and a
 * transmittance to multiply the sky by.
 *
 * CHEAP ENOUGH because: it runs at half resolution and is bilinearly
 * upsampled; the march is jittered per pixel so too few steps turn into fine
 * grain instead of bands; detail is only sampled where there is cloud to
 * erode; the sun march is five steps; a ray straight up takes only as many
 * steps as its short path needs; and a ray stops once the cloud in front of
 * it is opaque. The clouds are far above the walkable terrain, so the march
 * ignores it -- the composite (in outdoorPost's fog pass, which has the
 * depth buffer) only lays them where the scene shows sky or mountains.
 */

export const CLOUDS = {
  // --- the cumulus layer, ray-marched ---
  coverage: 0.35, // 0 clear .. 1 overcast
  // Extinction per metre of full cloud. Real cumulus is 0.05-0.1; after the
  // coverage remap and the erosion most of a cloud is a fraction of "full",
  // and at 0.02 the bodies were a veil -- the cirrus above showed straight
  // through them.
  density: 0.035,
  bottom: 200, // metres
  top: 1600,
  shapeScale: 4000, // metres a repeat of the shape noise covers
  detailScale: 650,
  detailStrength: 0.35, // how much the detail erodes the edges
  weatherScale: 42000, // metres a repeat of the weather map covers
  weatherContrast: 0.5, // how far the weather pushes coverage up and down
  warp: 0.35, // how far the weather bends the shape noise, in shape repeats
  wind: [15, 10], // metres per second, x and z
  sunLight: 1.2, // the sun's brightness on the clouds, times the sun light's
  ambient: 1, // the sky's light on the clouds
  // How quickly sunlight dims through cloud. It scales the SAME optical depth
  // the density sets, so it came down as the density went up (0.02 x 1 =
  // 0.05 x 0.4): the clouds block what is behind them far more, and are lit
  // exactly as before.
  absorption: 0.4,
  powder: 0.35, // how much the thinnest edges darken
  forwardScattering: 0.75, // Henyey-Greenstein g of the silver lining
  steps: 48, // along the view ray at most; the shader's maximum is 64
  maxDistance: 20000, // metres: past this the layer fades out
  resolution: 0.5, // of the screen

  // --- the high layer: cirrus, one sheet ---
  windAloft: [24, -7], // metres per second: the jet stream, faster and turned
  cirrusHeight: 9500,
  cirrusCoverage: 0.5,
  cirrusOpacity: 0.1,
  cirrusScale: 46000, // metres a repeat covers
  highLight: 0.75, // its brightness
  highFade: 51000, // metres: gone by here, where they would only be a smear

  // --- aerial perspective ---
  // The air between you and a cloud lays the sky's colour over it, as it does
  // over the mountains: the density is the range's own (distantRange.js's
  // HAZE_DENSITY -- outdoorPost shares the very uniform when there is a
  // range), so a cloud at the mountains is as hazy as the rock behind it.
  hazeDensity: 0.000135, // per metre, at ground level
  // Metres in which the haze thins by e: it is low-lying air, so a cloud
  // straight overhead is barely touched and one on the horizon, seen through
  // tens of kilometres of it, dissolves into the sky.
  hazeHeight: 1000,
};

// --- noise ------------------------------------------------------------------------

const fade = (t) => t * t * (3 - 2 * t);

/** Tileable value-noise fbm on a size^3 grid, 0..1. */
function valueNoise3D(size, startCells, octaves, random) {
  const out = new Float32Array(size * size * size);
  let amplitude = 1;
  let total = 0;
  for (let octave = 0, cells = startCells; octave < octaves; octave++, cells *= 2) {
    const lattice = Float32Array.from({ length: cells * cells * cells }, random);
    const at = (x, y, z) => lattice[((z % cells) * cells + (y % cells)) * cells + (x % cells)];
    let i = 0;
    for (let z = 0; z < size; z++) {
      const gz = (z / size) * cells;
      const z0 = Math.floor(gz);
      const tz = fade(gz - z0);
      for (let y = 0; y < size; y++) {
        const gy = (y / size) * cells;
        const y0 = Math.floor(gy);
        const ty = fade(gy - y0);
        for (let x = 0; x < size; x++, i++) {
          const gx = (x / size) * cells;
          const x0 = Math.floor(gx);
          const tx = fade(gx - x0);
          const a = at(x0, y0, z0) + (at(x0 + 1, y0, z0) - at(x0, y0, z0)) * tx;
          const b = at(x0, y0 + 1, z0) + (at(x0 + 1, y0 + 1, z0) - at(x0, y0 + 1, z0)) * tx;
          const c = at(x0, y0, z0 + 1) + (at(x0 + 1, y0, z0 + 1) - at(x0, y0, z0 + 1)) * tx;
          const d = at(x0, y0 + 1, z0 + 1) + (at(x0 + 1, y0 + 1, z0 + 1) - at(x0, y0 + 1, z0 + 1)) * tx;
          const near = a + (b - a) * ty;
          const far = c + (d - c) * ty;
          out[i] += (near + (far - near) * tz) * amplitude;
        }
      }
    }
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Tileable Worley noise: 1 at a feature point, falling to 0 a cell away. */
function worley3D(size, cells, random) {
  const points = Float32Array.from({ length: cells * cells * cells * 3 }, random);
  const out = new Float32Array(size * size * size);
  let i = 0;
  for (let z = 0; z < size; z++) {
    const pz = ((z + 0.5) / size) * cells;
    const cz = Math.floor(pz);
    for (let y = 0; y < size; y++) {
      const py = ((y + 0.5) / size) * cells;
      const cy = Math.floor(py);
      for (let x = 0; x < size; x++, i++) {
        const px = ((x + 0.5) / size) * cells;
        const cx = Math.floor(px);
        let best = Infinity;
        for (let dz = -1; dz <= 1; dz++) {
          const nz = cz + dz;
          const wz = ((nz % cells) + cells) % cells;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = cy + dy;
            const wy = ((ny % cells) + cells) % cells;
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx;
              const wx = ((nx % cells) + cells) % cells;
              const p = ((wz * cells + wy) * cells + wx) * 3;
              const fx = nx + points[p] - px;
              const fy = ny + points[p + 1] - py;
              const fz = nz + points[p + 2] - pz;
              const d2 = fx * fx + fy * fy + fz * fz;
              if (d2 < best) best = d2;
            }
          }
        }
        out[i] = 1 - Math.min(Math.sqrt(best), 1);
      }
    }
  }
  return out;
}

/** Stretched to the full 0..1 range and packed into a single-channel 3D texture. */
function toTexture(values, size) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const bytes = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    bytes[i] = Math.round(((values[i] - min) / (max - min || 1)) * 255);
  }
  const texture = new THREE.Data3DTexture(bytes, size, size, size);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** The cloud shapes: Perlin-Worley. */
function shapeNoise(size = 64) {
  const random = seeded(4242);
  const perlin = valueNoise3D(size, 4, 4, random);
  const w1 = worley3D(size, 4, random);
  const w2 = worley3D(size, 8, random);
  const w3 = worley3D(size, 16, random);
  const out = new Float32Array(perlin.length);
  for (let i = 0; i < out.length; i++) {
    const worley = w1[i] * 0.625 + w2[i] * 0.25 + w3[i] * 0.125;
    // Perlin remapped by Worley: its low regions cut away into billows.
    out[i] = Math.max(0, (perlin[i] - (worley - 1)) / (2 - worley));
  }
  return toTexture(out, size);
}

/** The edges: Worley fbm. */
function detailNoise(size = 32) {
  const random = seeded(777);
  const w1 = worley3D(size, 4, random);
  const w2 = worley3D(size, 8, random);
  const w3 = worley3D(size, 16, random);
  const out = new Float32Array(w1.length);
  for (let i = 0; i < out.length; i++) out[i] = w1[i] * 0.625 + w2[i] * 0.25 + w3[i] * 0.125;
  return toTexture(out, size);
}

// --- the flat noise: weather, and the cirrus --------------------------------

/**
 * Tileable 2D value-noise fbm, 0..1. The cells across and down can differ,
 * which stretches it into streaks; `warp` (two arrays of offsets, in repeats)
 * bends where each texel reads from, and keeps it tileable as long as the
 * offsets are tileable themselves.
 */
function valueNoise2D(size, cellsX, cellsY, octaves, random, warp = null) {
  const out = new Float32Array(size * size);
  let amplitude = 1;
  let total = 0;
  for (let octave = 0, cx = cellsX, cy = cellsY; octave < octaves; octave++, cx *= 2, cy *= 2) {
    const lattice = Float32Array.from({ length: cx * cy }, random);
    const at = (x, y) => lattice[(((y % cy) + cy) % cy) * cx + (((x % cx) + cx) % cx)];
    let i = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++, i++) {
        const gx = (x / size + (warp ? warp[0][i] : 0)) * cx;
        const gy = (y / size + (warp ? warp[1][i] : 0)) * cy;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const tx = fade(gx - x0);
        const ty = fade(gy - y0);
        const near = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
        const far = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        out[i] += (near + (far - near) * ty) * amplitude;
      }
    }
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Tileable 2D Worley noise: 1 at a feature point, falling to 0 a cell away. */
function worley2D(size, cells, random) {
  const points = Float32Array.from({ length: cells * cells * 2 }, random);
  const out = new Float32Array(size * size);
  let i = 0;
  for (let y = 0; y < size; y++) {
    const py = ((y + 0.5) / size) * cells;
    const cy = Math.floor(py);
    for (let x = 0; x < size; x++, i++) {
      const px = ((x + 0.5) / size) * cells;
      const cx = Math.floor(px);
      let best = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        const wy = ((ny % cells) + cells) % cells;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const wx = ((nx % cells) + cells) % cells;
          const p = (wy * cells + wx) * 2;
          const fx = nx + points[p] - px;
          const fy = ny + points[p + 1] - py;
          best = Math.min(best, fx * fx + fy * fy);
        }
      }
      out[i] = 1 - Math.min(Math.sqrt(best), 1);
    }
  }
  return out;
}

/** Stretched to fill 0..1, in place. */
function stretch(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const range = max - min || 1;
  for (let i = 0; i < values.length; i++) values[i] = (values[i] - min) / range;
  return values;
}

/**
 * One RGBA texture, three unrelated fields, each read at its own scale:
 *
 *   r  WEATHER -- where the cumulus gathers and where the sky is clear.
 *      Rolling noise with Worley blobs in it, so clouds come in groups.
 *   g  VARIETY -- which slice of the shape noise a patch of sky uses and how
 *      tall its clouds grow, so neighbouring patches are not copies.
 *   b  CIRRUS -- streaks, many times longer than wide, bent by a warp so
 *      they curl rather than run ruler-straight, with finer ridged strands
 *      through them: the fibres.
 *
 * Unlike the 3D noise, this one is mipmapped: the cirrus is read from it as
 * a sheet that run all the way to the horizon, where a texel is
 * kilometres wide and an unfiltered read is a field of crawling noise.
 */
function skyNoise(size = 512) {
  const random = seeded(9091);

  const weather = valueNoise2D(size, 4, 4, 5, random);
  const clumps = worley2D(size, 6, random);
  for (let i = 0; i < weather.length; i++) weather[i] = weather[i] * 0.55 + clumps[i] * 0.45;
  stretch(weather);

  const variety = stretch(valueNoise2D(size, 3, 3, 4, random));

  const bend = (n) => { for (let i = 0; i < n.length; i++) n[i] = (n[i] - 0.5) * 0.14; return n; };
  const warp = [bend(valueNoise2D(size, 4, 4, 3, random)), bend(valueNoise2D(size, 4, 4, 3, random))];
  const streaks = valueNoise2D(size, 2, 14, 5, random, warp);
  const strands = valueNoise2D(size, 3, 36, 3, random, warp);
  const cirrus = new Float32Array(streaks.length);
  for (let i = 0; i < cirrus.length; i++) {
    cirrus[i] = streaks[i] * 0.65 + (1 - Math.abs(strands[i] * 2 - 1)) * 0.35;
  }
  stretch(cirrus);

  const bytes = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    bytes[i * 4] = Math.round(weather[i] * 255);
    bytes[i * 4 + 1] = Math.round(variety[i] * 255);
    bytes[i * 4 + 2] = Math.round(cirrus[i] * 255);
    bytes[i * 4 + 3] = 255; // unused
  }
  const texture = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace; // numbers, not colours
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

// --- the cloud field, shared -------------------------------------------------------

/**
 * The cumulus as a field of density, in GLSL: where it is, how thick, how the
 * weather and the wind move it. The march on screen reads it, and so does the
 * cloud shadow map (scene/outside/cloudShadows.js) -- one definition, so the
 * shadows on the ground are cast by the very clouds you see. Its uniforms are
 * the pass's own objects (VolumetricCloudsPass.fieldUniforms), so the panel
 * moves both at once.
 */
export const CLOUD_FIELD_GLSL = /* glsl */`
  precision highp sampler3D;

  uniform sampler3D shapeNoise;
  uniform sampler3D detailNoise;
  uniform sampler2D skyNoise;
  uniform float time;
  uniform vec2 wind;
  uniform float coverage;
  uniform float density;
  uniform float bottom;
  uniform float top;
  uniform float shapeScale;
  uniform float detailScale;
  uniform float detailStrength;
  uniform float weatherScale;
  uniform float weatherContrast;
  uniform float warp;

  // Each field read turned its own way, so none of them repeats along
  // the world's axes -- or along the others' -- and their tiles never
  // line up into a grid.
  const mat2 SHAPE_TURN = mat2(0.8, -0.6, 0.6, 0.8);
  const mat2 DETAIL_TURN = mat2(0.28, -0.96, 0.96, 0.28);
  const mat2 WEATHER_TURN = mat2(0.96, 0.28, -0.28, 0.96);

  float remap(float v, float fromLow, float fromHigh, float toLow, float toHigh) {
    return toLow + (v - fromLow) * (toHigh - toLow) / max(fromHigh - fromLow, 1e-4);
  }

  // The weather where p is: r how cloudy, g which variety of cloud.
  vec4 weatherAt(vec3 p) {
    vec2 q = WEATHER_TURN * (p.xz + wind * time);
    return textureLod(skyNoise, q / weatherScale, 0.0);
  }

  // Extinction per metre at p. Without detail: the cheap shape only,
  // for the sun march.
  float cloudDensity(vec3 p, vec4 weather, float localCoverage, bool withDetail) {
    if (localCoverage <= 0.0) return 0.0;
    float altitude = p.y;
    // Some patches of sky grow tall clouds, some stay low and flat.
    float tallness = mix(0.45, 1.0, smoothstep(0.3, 0.7, weather.g));
    float height = (altitude - bottom) / max((top - bottom) * tallness, 1.0);
    // Outside the layer: no texture reads at all.
    if (height <= 0.0 || height >= 1.0) return 0.0;
    // Rounded bottoms, softer tops.
    float profile = smoothstep(0.0, 0.12, height) * (1.0 - smoothstep(0.55, 1.0, height));

    vec2 moved = p.xz + wind * time;
    // Turned, bent by the weather, and read from a different depth of
    // the (tileable, three-dimensional) noise in every patch of sky:
    // so one tile of it is not stamped out again every few kilometres.
    vec2 across = SHAPE_TURN * moved + (weather.rg - 0.5) * warp * shapeScale;
    vec3 s = vec3(across.x, altitude + weather.g * shapeScale, across.y);
    float shape = textureLod(shapeNoise, s / shapeScale, 0.0).r * profile;
    float cloud = clamp(remap(shape, 1.0 - localCoverage, 1.0, 0.0, 1.0), 0.0, 1.0);
    if (cloud <= 0.0 || !withDetail) return cloud * density;

    vec2 fine = DETAIL_TURN * moved;
    float detail = textureLod(detailNoise, vec3(fine.x, altitude, fine.y) / detailScale, 0.0).r;
    cloud = clamp(remap(cloud, detail * detailStrength, 1.0, 0.0, 1.0), 0.0, 1.0);
    return cloud * density;
  }

  // How much of the sky is cloud where this weather is.
  float coverageFrom(vec4 weather) {
    return clamp(coverage + (weather.r - 0.5) * weatherContrast, 0.0, 1.0);
  }
`;

// The names of the uniforms CLOUD_FIELD_GLSL reads.
const FIELD_UNIFORMS = ['shapeNoise', 'detailNoise', 'skyNoise', 'time', 'wind', 'coverage', 'density',
  'bottom', 'top', 'shapeScale', 'detailScale', 'detailStrength', 'weatherScale', 'weatherContrast', 'warp'];

// --- the pass -----------------------------------------------------------------------

/**
 * Renders the clouds into its own half-resolution target, `texture`: rgb is
 * the light they add, alpha how much of what is behind still shows. It draws
 * nothing to the composer's buffers (needsSwap false); the fog pass lays it
 * onto the sky.
 */
export class VolumetricCloudsPass extends Pass {
  constructor({ camera, sun, sunDirection, skyTexture }) {
    super();
    this.needsSwap = false;
    this.camera = camera;
    this.sun = sun;
    this.resolution = CLOUDS.resolution;
    this.farDistance = null;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        shapeNoise: { value: shapeNoise() },
        detailNoise: { value: detailNoise() },
        skyNoise: { value: skyNoise() },
        skyColour: { value: skyTexture },
        farDistance: { value: null },
        farOn: { value: 0 },
        projectionInverse: { value: new THREE.Matrix4() },
        cameraWorld: { value: new THREE.Matrix4() },
        cameraPos: { value: new THREE.Vector3() },
        sunDirection: { value: sunDirection }, // shared: follows the sun
        sunColour: { value: new THREE.Color() },
        time: { value: 0 },
        wind: { value: new THREE.Vector2(...CLOUDS.wind) },
        coverage: { value: CLOUDS.coverage },
        density: { value: CLOUDS.density },
        bottom: { value: CLOUDS.bottom },
        top: { value: CLOUDS.top },
        shapeScale: { value: CLOUDS.shapeScale },
        detailScale: { value: CLOUDS.detailScale },
        detailStrength: { value: CLOUDS.detailStrength },
        weatherScale: { value: CLOUDS.weatherScale },
        weatherContrast: { value: CLOUDS.weatherContrast },
        warp: { value: CLOUDS.warp },
        sunLight: { value: CLOUDS.sunLight },
        ambient: { value: CLOUDS.ambient },
        absorption: { value: CLOUDS.absorption },
        powder: { value: CLOUDS.powder },
        forwardScattering: { value: CLOUDS.forwardScattering },
        stepCount: { value: CLOUDS.steps },
        maxDistance: { value: CLOUDS.maxDistance },
        highOn: { value: 1 },
        windAloft: { value: new THREE.Vector2(...CLOUDS.windAloft) },
        cirrusHeight: { value: CLOUDS.cirrusHeight },
        cirrusCoverage: { value: CLOUDS.cirrusCoverage },
        cirrusOpacity: { value: CLOUDS.cirrusOpacity },
        cirrusScale: { value: CLOUDS.cirrusScale },
        highLight: { value: CLOUDS.highLight },
        highFade: { value: CLOUDS.highFade },
        hazeDensity: { value: CLOUDS.hazeDensity },
        hazeHeight: { value: CLOUDS.hazeHeight },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        ${CLOUD_FIELD_GLSL}

        uniform samplerCube skyColour;
        uniform sampler2D farDistance;
        uniform float farOn;
        uniform mat4 projectionInverse;
        uniform mat4 cameraWorld;
        uniform vec3 cameraPos;
        uniform vec3 sunDirection;
        uniform vec3 sunColour;
        uniform float sunLight;
        uniform float ambient;
        uniform float absorption;
        uniform float powder;
        uniform float forwardScattering;
        uniform int stepCount;
        uniform float maxDistance;
        uniform float highOn;
        uniform vec2 windAloft;
        uniform float cirrusHeight;
        uniform float cirrusCoverage;
        uniform float cirrusOpacity;
        uniform float cirrusScale;
        uniform float highLight;
        uniform float highFade;
        uniform float hazeDensity;
        uniform float hazeHeight;
        varying vec2 vUv;

        const int MAX_STEPS = 64;
        const int LIGHT_STEPS = 5;
        // Metres: the march never takes steps shorter than this, so a ray
        // straight up (a kilometre and a half of layer) takes a few dozen
        // and the long, shallow ones toward the horizon take the rest.
        const float MIN_STEP = 45.0;
        const float PLANET_RADIUS = 6371000.0;
        // Metres before a mountain over which the cumulus thins out.
        const float MOUNTAIN_SOFTEN = 1500.0;
        // How far below level a ray may look and still find cirrus: the
        // horizon of a curved world dips, a little.
        const float HORIZON_DIP = -0.03;

        // How much of the sky's colour the air has laid over whatever is t
        // metres out along a ray rising at "rise" (direction.y): haze thick at
        // the ground and thinning with height, integrated along the ray --
        // the same closed form the height fog uses (outdoorPost.js).
        float hazeAt(float t, float rise) {
          float x = rise * t / hazeHeight;
          float spread = abs(x) > 1e-4 ? (1.0 - exp(-x)) / x : 1.0 - 0.5 * x;
          return 1.0 - exp(-hazeDensity * t * spread);
        }

        // Henyey-Greenstein, scaled so it averages 1 over the sphere.
        float phaseHG(float cosTheta, float g) {
          float g2 = g * g;
          return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5);
        }

        // THE CIRRUS IS ROUND: a shell around a planet under the camera, not
        // a flat sheet, so it meets the horizon instead of running on to
        // infinity as a smear. How far along the ray it leaves the shell at
        // this altitude, from a camera below it. Written to cancel nothing
        // large against anything large: the planet is six million metres,
        // the height ten thousand, and single floats do not survive the
        // obvious formula.
        float shellExit(float altitude, vec3 direction) {
          float b = (cameraPos.y + PLANET_RADIUS) * direction.y;
          float c = (cameraPos.y - altitude) * (2.0 * PLANET_RADIUS + cameraPos.y + altitude);
          float s = sqrt(max(b * b - c, 0.0));
          return b > 0.0 ? -c / (b + s) : s - b;
        }

        void main() {
          vec4 view = projectionInverse * vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
          vec3 direction = normalize((cameraWorld * vec4(view.xyz / view.w, 1.0)).xyz - cameraPos);

          // How far away the mountains are along this ray, if there are any
          // (outdoorPost's FarDistancePass): cloud behind them is hidden.
          float mountain = farOn > 0.5 ? texture(farDistance, vUv).r * 1000.0 : 1e12;

          float cosTheta = dot(direction, sunDirection);
          // No sun once it is below the horizon.
          vec3 sun = sunColour * sunLight * smoothstep(-0.05, 0.08, sunDirection.y);
          vec3 skyAbove = textureLod(skyColour, vec3(0.0, 1.0, 0.0), 5.0).rgb * ambient;
          // What the haze fades a cloud toward: the sky right behind it, the
          // same colour the mountains fade toward, so the two go together.
          // Never below the horizon, where the sky model goes dark.
          vec3 hazeSky = textureLod(skyColour, normalize(vec3(direction.x, max(direction.y, 0.0), direction.z)), 0.0).rgb;

          // --- the cirrus ----------------------------------------------------------------
          // One sheet, read before anything branches: it is read with
          // mipmaps, and mipmaps need the pixel's neighbours to have come
          // this way too.
          float tCirrus = shellExit(cirrusHeight, direction);
          // Not turned: the streaks run along x in the texture, so this
          // lines them up with the wind aloft, the way cirrus is combed out.
          vec2 aloft = normalize(windAloft + vec2(1e-4, 0.0));
          vec2 cirrusFlat = cameraPos.xz + direction.xz * tCirrus + windAloft * time;
          vec2 cirrusAt = vec2(dot(cirrusFlat, aloft), dot(cirrusFlat, vec2(-aloft.y, aloft.x)));
          float cirrusStreaks = texture(skyNoise, cirrusAt / cirrusScale).b;
          float cirrusGroups = texture(skyNoise, cirrusAt / (cirrusScale * 2.9) + 0.63).g;

          // Seen only above the horizon, in front of the mountains, from
          // below, and not so far off that it is one texel of mush.
          float cirrusSeen = highOn * step(HORIZON_DIP, direction.y) * step(tCirrus, mountain) * step(cameraPos.y, cirrusHeight)
            * (1.0 - smoothstep(highFade * 0.3, highFade, tCirrus));

          float cirrusAmount = cirrusStreaks * 0.7 + cirrusGroups * 0.3;
          float cirrusAlpha = smoothstep(1.0 - cirrusCoverage, 1.0 - cirrusCoverage + 0.3, cirrusAmount)
            * cirrusOpacity * cirrusSeen;

          // Ice, thin: bright, a strong forward glow, never self-shadowed.
          vec3 cirrusLight = (sun * mix(1.0, phaseHG(cosTheta, 0.65), 0.5) + skyAbove * 0.9) * highLight;
          cirrusLight = mix(cirrusLight, hazeSky, hazeAt(tCirrus, direction.y));
          vec3 highScattered = cirrusLight * cirrusAlpha;
          float highTransmittance = 1.0 - cirrusAlpha;

          // --- the cumulus ----------------------------------------------------------------
          vec3 scattered = vec3(0.0);
          float transmittance = 1.0;

          // A flat layer, overhead only.
          float enter = direction.y > 0.002 ? max((bottom - cameraPos.y) / direction.y, 0.0) : 0.0;
          float leave = direction.y > 0.002 ? (top - cameraPos.y) / direction.y : 0.0;
          // Only as far as the mountains: cloud that has gone past a range is
          // behind it, and hidden. Cloud short of it is drawn over it.
          leave = min(leave, min(maxDistance, mountain));
          if (enter < leave) {
            int maxSteps = min(stepCount, MAX_STEPS);
            int steps = int(clamp(ceil((leave - enter) / MIN_STEP), 8.0, float(maxSteps)));
            float stepLength = (leave - enter) / float(steps);
            // Interleaved gradient noise: a different start per pixel, so too
            // few steps show as grain rather than as bands.
            float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
            float t = enter + stepLength * jitter;

            float phase = mix(phaseHG(cosTheta, forwardScattering), phaseHG(cosTheta, -0.25), 0.3);
            float lightStep = (top - bottom) * 0.35 / float(LIGHT_STEPS);

            for (int i = 0; i < MAX_STEPS; i++) {
              if (i >= steps || transmittance < 0.02) break;
              vec3 p = cameraPos + direction * t;
              vec4 weather = weatherAt(p);
              float localCoverage = coverageFrom(weather);
              // Thinned toward the far end, where a step is a kilometre long.
              float reach = 1.0 - smoothstep(maxDistance * 0.55, maxDistance, t);
              // And thinned over the last stretch before a mountain, so a
              // cloud running into a slope fades into it rather than being
              // sliced off along a hard line across the rock.
              reach *= clamp((mountain - t) / MOUNTAIN_SOFTEN, 0.0, 1.0);
              float extinction = cloudDensity(p, weather, localCoverage, true) * reach;
              if (extinction > 0.0) {
                float opticalDepth = 0.0;
                for (int j = 0; j < LIGHT_STEPS; j++) {
                  vec3 toward = p + sunDirection * lightStep * (float(j) + 0.5);
                  opticalDepth += cloudDensity(toward, weather, localCoverage, false) * lightStep;
                }
                float toSun = exp(-opticalDepth * absorption);
                float powdered = mix(1.0, 1.0 - exp(-opticalDepth * absorption * 2.0), powder);
                float height = clamp((p.y - bottom) / max(top - bottom, 1.0), 0.0, 1.0);
                vec3 light = sun * phase * toSun * powdered + skyAbove * mix(0.35, 1.0, height);
                // Faded toward the sky behind by the air in between.
                light = mix(light, hazeSky, hazeAt(t, direction.y));

                float stepTransmittance = exp(-extinction * stepLength);
                scattered += transmittance * light * (1.0 - stepTransmittance);
                transmittance *= stepTransmittance;
              }
              t += stepLength;
            }
          }

          // The cumulus in front of the cirrus.
          gl_FragColor = vec4(scattered + transmittance * highScattered, transmittance * highTransmittance);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /**
   * The graphics quality's say: the render size as a fraction of the screen
   * (taking effect at the next setSize) and the steps per ray.
   */
  setQuality({ resolution, steps }) {
    this.resolution = resolution;
    this.material.uniforms.stepCount.value = steps;
  }

  setSize(width, height) {
    this.target.setSize(
      Math.max(1, Math.round(width * this.resolution)),
      Math.max(1, Math.round(height * this.resolution)),
    );
  }

  /** The clouds, for compositing: rgb added, alpha transmittance. */
  get texture() {
    return this.target.texture;
  }

  /**
   * How far the mountains are along each ray of the screen, in kilometres
   * (outdoorPost's FarDistancePass), or null for no mountains. Without it
   * the clouds are laid over the whole sky, ranges and all.
   */
  setFarDistance(texture) {
    this.farDistance = texture;
  }

  /**
   * The uniforms CLOUD_FIELD_GLSL reads -- this pass's own objects, not
   * copies, for another material to share.
   */
  fieldUniforms() {
    const u = this.material.uniforms;
    return Object.fromEntries(FIELD_UNIFORMS.map((name) => [name, u[name]]));
  }

  /** Blow the clouds on by `dt` seconds. render() does this; renderCubeFace does not. */
  advance(dt) {
    this.material.uniforms.time.value += dt;
  }

  /** March the next draw from this camera's point of view. */
  setView(view) {
    const u = this.material.uniforms;
    u.projectionInverse.value.copy(view.projectionMatrixInverse);
    u.cameraWorld.value.copy(view.matrixWorld);
    u.cameraPos.value.setFromMatrixPosition(view.matrixWorld);
    u.sunColour.value.copy(this.sun.color).multiplyScalar(this.sun.visible ? this.sun.intensity : 0);
  }

  /**
   * The clouds from `view`, into one face of a cube target -- how VR gets
   * them, where the chain this pass belongs to cannot run at all
   * (scene/outside/outdoorPost.js's renderXR). No mountains there: the far
   * distances are for the screen's rays, not the cube's.
   */
  renderCubeFace(renderer, view, target, face) {
    this.setView(view);
    this.material.uniforms.farOn.value = 0;
    renderer.setRenderTarget(target, face);
    this.quad.render(renderer);
  }

  render(renderer, writeBuffer, readBuffer, deltaTime) {
    this.advance(deltaTime);
    this.setView(this.camera);
    const u = this.material.uniforms;
    u.farDistance.value = this.farDistance;
    u.farOn.value = this.farDistance ? 1 : 0;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }

  dispose() {
    this.target.dispose();
    this.material.uniforms.shapeNoise.value.dispose();
    this.material.uniforms.detailNoise.value.dispose();
    this.material.uniforms.skyNoise.value.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
