import * as THREE from 'three';
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
 *   weather  the shape noise again, far larger and read flat, varying the
 *            coverage across the sky so clouds come in groups with gaps.
 *
 * A height profile rounds the bottoms and softens the tops. Wind slides all
 * of it along.
 *
 * THE LIGHT, per step along the view ray through the layer:
 *
 *   sun      a short march toward the sun measures how much cloud it has come
 *            through (Beer-Lambert), with a "powder" term darkening the
 *            thinnest edges; a two-lobe Henyey-Greenstein phase makes the
 *            silver lining toward the sun.
 *   ambient  the sky's own colour from above, from the same cubemap the fog
 *            uses (scene/outdoorLight.js), brighter toward the tops.
 *
 * Scattering is integrated the energy-conserving way (each step adds what
 * that step's extinction scatters, weighted by how much light still gets
 * through to the camera), so the result is a colour to add and a
 * transmittance to multiply the sky by.
 *
 * CHEAP ENOUGH because: it runs at half resolution and is bilinearly
 * upsampled; the march is jittered per pixel so too few steps turn into fine
 * grain instead of bands; detail is only sampled where there is cloud to
 * erode; the sun march is five steps; and a ray stops once the cloud in front
 * of it is opaque. Clouds are only ever overhead and far above the terrain,
 * so the march ignores the ground entirely -- the composite (in outdoorPost's
 * fog pass, which has the depth buffer) only lays them on the sky.
 */

export const CLOUDS = {
  coverage: 0.45, // 0 clear .. 1 overcast
  density: 0.02, // extinction per metre of full cloud
  bottom: 1200, // metres
  top: 2600,
  shapeScale: 4000, // metres a repeat of the shape noise covers
  detailScale: 650,
  detailStrength: 0.35, // how much the detail erodes the edges
  wind: [9, 3], // metres per second, x and z
  sunLight: 1.2, // the sun's brightness on the clouds, times the sun light's
  ambient: 1, // the sky's light on the clouds
  absorption: 1, // how quickly sunlight dims through cloud
  powder: 0.35, // how much the thinnest edges darken
  forwardScattering: 0.75, // Henyey-Greenstein g of the silver lining
  steps: 48, // along the view ray; the shader's maximum is 64
  maxDistance: 30000, // metres: past this the layer fades out
  resolution: 0.5, // of the screen
};

// --- noise ------------------------------------------------------------------------

function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

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
        skyColour: { value: skyTexture },
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
        sunLight: { value: CLOUDS.sunLight },
        ambient: { value: CLOUDS.ambient },
        absorption: { value: CLOUDS.absorption },
        powder: { value: CLOUDS.powder },
        forwardScattering: { value: CLOUDS.forwardScattering },
        stepCount: { value: CLOUDS.steps },
        maxDistance: { value: CLOUDS.maxDistance },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp sampler3D;

        uniform sampler3D shapeNoise;
        uniform sampler3D detailNoise;
        uniform samplerCube skyColour;
        uniform mat4 projectionInverse;
        uniform mat4 cameraWorld;
        uniform vec3 cameraPos;
        uniform vec3 sunDirection;
        uniform vec3 sunColour;
        uniform float time;
        uniform vec2 wind;
        uniform float coverage;
        uniform float density;
        uniform float bottom;
        uniform float top;
        uniform float shapeScale;
        uniform float detailScale;
        uniform float detailStrength;
        uniform float sunLight;
        uniform float ambient;
        uniform float absorption;
        uniform float powder;
        uniform float forwardScattering;
        uniform int stepCount;
        uniform float maxDistance;
        varying vec2 vUv;

        const int MAX_STEPS = 64;
        const int LIGHT_STEPS = 5;

        float remap(float v, float fromLow, float fromHigh, float toLow, float toHigh) {
          return toLow + (v - fromLow) * (toHigh - toLow) / max(fromHigh - fromLow, 1e-4);
        }

        // Henyey-Greenstein, scaled so it averages 1 over the sphere.
        float phaseHG(float cosTheta, float g) {
          float g2 = g * g;
          return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5);
        }

        // Extinction per metre at p. Without detail: the cheap shape only,
        // for the sun march.
        float cloudDensity(vec3 p, bool withDetail) {
          float height = clamp((p.y - bottom) / max(top - bottom, 1.0), 0.0, 1.0);
          // Rounded bottoms, softer tops.
          float profile = smoothstep(0.0, 0.12, height) * (1.0 - smoothstep(0.55, 1.0, height));
          vec3 q = p + vec3(wind.x, 0.0, wind.y) * time;

          float weather = texture(shapeNoise, vec3(q.x, 0.0, q.z) / (shapeScale * 5.0) + vec3(0.0, 0.37, 0.0)).r;
          float localCoverage = clamp(coverage + (weather - 0.5) * 0.6, 0.0, 1.0);

          float shape = texture(shapeNoise, q / shapeScale).r * profile;
          float cloud = clamp(remap(shape, 1.0 - localCoverage, 1.0, 0.0, 1.0), 0.0, 1.0);
          if (cloud <= 0.0 || !withDetail) return cloud * density;

          float detail = texture(detailNoise, q / detailScale).r;
          cloud = clamp(remap(cloud, detail * detailStrength, 1.0, 0.0, 1.0), 0.0, 1.0);
          return cloud * density;
        }

        void main() {
          vec4 view = projectionInverse * vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
          vec3 direction = normalize((cameraWorld * vec4(view.xyz / view.w, 1.0)).xyz - cameraPos);

          // Nothing to see but clear sky: overhead only.
          if (direction.y <= 0.002) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
          float enter = max((bottom - cameraPos.y) / direction.y, 0.0);
          float leave = min((top - cameraPos.y) / direction.y, maxDistance);
          if (enter >= leave) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

          int steps = min(stepCount, MAX_STEPS);
          float stepLength = (leave - enter) / float(steps);
          // Interleaved gradient noise: a different start per pixel, so too few
          // steps show as grain rather than as bands.
          float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float t = enter + stepLength * jitter;

          float cosTheta = dot(direction, sunDirection);
          float phase = mix(phaseHG(cosTheta, forwardScattering), phaseHG(cosTheta, -0.25), 0.3);
          // No sun once it is below the horizon.
          vec3 sun = sunColour * sunLight * smoothstep(-0.05, 0.08, sunDirection.y);
          vec3 skyAbove = textureLod(skyColour, vec3(0.0, 1.0, 0.0), 5.0).rgb * ambient;
          float lightStep = (top - bottom) * 0.35 / float(LIGHT_STEPS);

          vec3 scattered = vec3(0.0);
          float transmittance = 1.0;
          for (int i = 0; i < MAX_STEPS; i++) {
            if (i >= steps || transmittance < 0.02) break;
            vec3 p = cameraPos + direction * t;
            float extinction = cloudDensity(p, true);
            if (extinction > 0.0) {
              float opticalDepth = 0.0;
              for (int j = 0; j < LIGHT_STEPS; j++) {
                opticalDepth += cloudDensity(p + sunDirection * lightStep * (float(j) + 0.5), false) * lightStep;
              }
              float toSun = exp(-opticalDepth * absorption);
              float powdered = mix(1.0, 1.0 - exp(-opticalDepth * absorption * 2.0), powder);
              float height = clamp((p.y - bottom) / max(top - bottom, 1.0), 0.0, 1.0);
              vec3 light = sun * phase * toSun * powdered + skyAbove * mix(0.35, 1.0, height);

              float stepTransmittance = exp(-extinction * stepLength);
              scattered += transmittance * light * (1.0 - stepTransmittance);
              transmittance *= stepTransmittance;
            }
            t += stepLength;
          }

          // Thin out toward the horizon, where too few steps cover too much.
          float fadeOut = 1.0 - smoothstep(maxDistance * 0.5, maxDistance, enter);
          gl_FragColor = vec4(scattered * fadeOut, mix(1.0, transmittance, fadeOut));
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
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

  render(renderer, writeBuffer, readBuffer, deltaTime) {
    const u = this.material.uniforms;
    u.time.value += deltaTime;
    u.projectionInverse.value.copy(this.camera.projectionMatrixInverse);
    u.cameraWorld.value.copy(this.camera.matrixWorld);
    u.cameraPos.value.setFromMatrixPosition(this.camera.matrixWorld);
    u.sunColour.value.copy(this.sun.color).multiplyScalar(this.sun.visible ? this.sun.intensity : 0);
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }

  dispose() {
    this.target.dispose();
    this.material.uniforms.shapeNoise.value.dispose();
    this.material.uniforms.detailNoise.value.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}