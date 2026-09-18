import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CLOUD_FIELD_GLSL } from './volumetricClouds.js';

/**
 * Cloud shadows: the cumulus overhead, cast onto the ground by the sun.
 *
 * A MAP, LOOKED DOWN ON. A small square texture over the land, tens of
 * kilometres across, of how much sunlight gets through the cloud to each
 * point of the ground -- found by marching from the ground toward the sun
 * through the very same cloud field the sky is drawn from
 * (volumetricClouds.js's CLOUD_FIELD_GLSL), with the cheap shape only. Every
 * sunlit surface then reads it once and takes the sun down by it.
 *
 * WHY IT IS CHEAP. 512 x 512 texels of twelve steps each is a few million
 * texture reads, against the tens of millions the clouds on screen take, and
 * clouds cross a 140 m texel in a quarter of a minute -- so it is redrawn ten
 * times a second, not every frame. Reading it is one texture fetch a pixel.
 * And the sun's own shadow map, drawn once and kept (outdoorLight.js), never
 * has to be redrawn for it: the cloud shadow is multiplied on separately.
 *
 * SURFACES AT ANY HEIGHT. The map is drawn for rays starting at the ground;
 * a point higher up -- a mountainside -- is slid down its own sun ray to the
 * ground and reads the shadow there, which is the same ray. Above the cloud
 * base less and less of the cloud is above it, and a peak above the tops is
 * in full sun.
 *
 * WHO TAKES IT. Every three.js lit material (standard, physical, Lambert,
 * Phong, toon) is taught it by shadeWithClouds, which multiplies the
 * directional lights by it inside three's own lighting -- sun only, sky light
 * untouched, which is how a cloud shadow looks: dim and blue, not black. The
 * mountains' material is written by hand and calls cloudShadowAt itself
 * (distantRange.js). Inside, the strength is zero and the lookup returns 1
 * before it reads anything.
 */

export const CLOUD_SHADOWS = {
  size: 512, // texels a side
  span: 72000, // metres across: the whole mountain ring, and room to slide
  strength: 0.85, // 0 none .. 1 as dark as the cloud's thickness says
  rate: 10, // redraws a second
};

const STEPS = 12;
// The sun is never taken as lower than this for the march: a sun on the
// horizon would slide a shadow off the map altogether.
const MIN_SUN_HEIGHT = 0.08;

const WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
WHITE.needsUpdate = true;

/**
 * The uniforms every shaded material shares -- the same objects, so one
 * redraw reaches all of them. Module-wide because the materials are built
 * before the clouds are, and outlive a trip outside.
 */
export const cloudShadowUniforms = {
  cloudShadowMap: { value: WHITE },
  // x, z of the map's middle; 1 / its span; the ground height it was drawn at.
  cloudShadowFrame: { value: new THREE.Vector4(0, 0, 1 / CLOUD_SHADOWS.span, 0) },
  // How far a point slides across per metre it slides down (the sun's x and z
  // over its height); the cloud's bottom and top.
  cloudShadowSlide: { value: new THREE.Vector4(0, 0, 1e5, 1e5) },
  // Zero when there are no cloud shadows: inside, or with the clouds off.
  cloudShadowStrength: { value: 0 },
};

/** The lookup, for a fragment shader: 1 in full sun, less under cloud. */
export const CLOUD_SHADOW_GLSL = /* glsl */`
  uniform sampler2D cloudShadowMap;
  uniform vec4 cloudShadowFrame;
  uniform vec4 cloudShadowSlide;
  uniform float cloudShadowStrength;

  float cloudShadowAt(vec3 world) {
    if (cloudShadowStrength <= 0.0) return 1.0;
    // Down its own sun ray to the ground the map was drawn at.
    vec2 atGround = world.xz - cloudShadowSlide.xy * (world.y - cloudShadowFrame.w);
    vec2 uv = (atGround - cloudShadowFrame.xy) * cloudShadowFrame.z + 0.5;
    // Off the map, no shadow -- faded in, not a hard square.
    vec2 inside = smoothstep(0.0, 0.03, uv) * (1.0 - smoothstep(0.97, 1.0, uv));
    // Up through the cloud, less and less of it is still above.
    float below = 1.0 - smoothstep(cloudShadowSlide.z, cloudShadowSlide.w, world.y);
    float lit = texture2D(cloudShadowMap, uv).r;
    return mix(1.0, lit, cloudShadowStrength * inside.x * inside.y * below);
  }
`;

// --- teaching three's materials ------------------------------------------------------

const LIT = new Set([
  'MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshLambertMaterial',
  'MeshPhongMaterial', 'MeshToonMaterial',
]);

// Three's own lighting, with the sun (every directional light) taken down by
// the cloud shadow as each is gathered -- before its own shadow map and before
// it reaches the surface, so specular and diffuse both dim.
const DIRECT = 'getDirectionalLightInfo( directionalLight, directLight );';
const LIGHTS = `float cloudLit = cloudShadowAt( vCloudWorld );\n${THREE.ShaderChunk.lights_fragment_begin
  .replace(DIRECT, `${DIRECT}\n\t\tdirectLight.color *= cloudLit;`)}`;
if (!THREE.ShaderChunk.lights_fragment_begin.includes(DIRECT)) {
  console.warn('cloudShadows: three\'s lights_fragment_begin has changed; no cloud shadows on its materials');
}

// Where the fragment is in the world, carried from the vertex: after three's
// own world position, with instancing and batching, and after any shader of
// ours has moved the vertex (the grass bending, the leaves blowing).
const WORLD_VERTEX = /* glsl */`#include <worldpos_vertex>
  vec4 cloudWorld = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    cloudWorld = batchingMatrix * cloudWorld;
  #endif
  #ifdef USE_INSTANCING
    cloudWorld = instanceMatrix * cloudWorld;
  #endif
  vCloudWorld = ( modelMatrix * cloudWorld ).xyz;`;

const patched = new WeakSet();

/**
 * Teach one material the cloud shadow. On top of whatever onBeforeCompile it
 * already has -- the grass's, the tree's, the books' two-sided shadows -- and
 * with its own program key kept apart from every other's. Once per material;
 * other kinds of material are left alone.
 *
 * @param {THREE.Material} material
 */
export function shadeWithClouds(material) {
  if (!material || patched.has(material) || !LIT.has(material.type)) return;
  if (!THREE.ShaderChunk.lights_fragment_begin.includes(DIRECT)) return;
  patched.add(material);

  const before = material.onBeforeCompile;
  // Taken now: three's default key is the source of onBeforeCompile, which
  // after this would be the same wrapper for every material.
  const key = material.customProgramCacheKey();

  material.onBeforeCompile = function onBeforeCompile(shader, renderer) {
    before.call(this, shader, renderer);
    // Only a shader that still has the pieces this goes into.
    if (!shader.vertexShader.includes('#include <worldpos_vertex>')
      || !shader.fragmentShader.includes('#include <lights_fragment_begin>')) return;
    Object.assign(shader.uniforms, cloudShadowUniforms);
    shader.vertexShader = `varying vec3 vCloudWorld;\n${shader.vertexShader}`
      .replace('#include <worldpos_vertex>', WORLD_VERTEX);
    shader.fragmentShader = `varying vec3 vCloudWorld;\n${CLOUD_SHADOW_GLSL}\n${shader.fragmentShader}`
      .replace('#include <lights_fragment_begin>', LIGHTS);
  };
  material.customProgramCacheKey = () => `${key}|cloudShadow`;
  material.needsUpdate = true;
}

/**
 * Teach every lit material under `root` that is being drawn. Hidden subtrees
 * are skipped -- the room, while you are outside -- so nothing is recompiled
 * that is not about to be seen. Safe to call again: each material is done
 * once.
 *
 * @param {THREE.Object3D} root
 */
export function shadeSceneWithClouds(root) {
  if (!root.visible) return;
  const material = root.material;
  if (Array.isArray(material)) material.forEach(shadeWithClouds);
  else if (material) shadeWithClouds(material);
  for (const child of root.children) shadeSceneWithClouds(child);
}

// --- drawing the map --------------------------------------------------------------

/**
 * @param {object} opts
 * @param {import('./volumetricClouds.js').VolumetricCloudsPass} opts.clouds
 *   the clouds on screen: the shadows are theirs, and off when they are
 * @param {THREE.Vector3} opts.sunDirection  shared: follows the sun
 * @param {number} opts.groundHeight  world height the map is drawn at
 */
export function createCloudShadows({ clouds, sunDirection, groundHeight }) {
  const target = new THREE.WebGLRenderTarget(CLOUD_SHADOWS.size, CLOUD_SHADOWS.size, {
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
  });

  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...clouds.fieldUniforms(),
      // How the clouds dim the sunlight they are lit by: the shadow they cast
      // is that same dimming, arriving at the ground.
      absorption: clouds.material.uniforms.absorption,
      sunDirection: { value: sunDirection },
      origin: { value: new THREE.Vector2() },
      span: { value: CLOUD_SHADOWS.span },
      ground: { value: groundHeight },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      ${CLOUD_FIELD_GLSL}

      uniform float absorption;
      uniform vec3 sunDirection;
      uniform vec2 origin;
      uniform float span;
      uniform float ground;
      varying vec2 vUv;

      const int STEPS = ${STEPS};

      void main() {
        vec3 toward = normalize(vec3(sunDirection.x, max(sunDirection.y, ${MIN_SUN_HEIGHT.toFixed(3)}), sunDirection.z));
        vec3 start = vec3(origin.x + (vUv.x - 0.5) * span, ground, origin.y + (vUv.y - 0.5) * span);
        float enter = (bottom - ground) / toward.y;
        float stepLength = (top - bottom) / toward.y / float(STEPS);
        float opticalDepth = 0.0;
        for (int i = 0; i < STEPS; i++) {
          vec3 p = start + toward * (enter + (float(i) + 0.5) * stepLength);
          vec4 weather = weatherAt(p);
          opticalDepth += cloudDensity(p, weather, coverageFrom(weather), false) * stepLength;
        }
        gl_FragColor = vec4(vec3(exp(-opticalDepth * absorption)), 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new FullScreenQuad(material);

  const u = material.uniforms;
  const shared = cloudShadowUniforms;
  let sinceDrawn = Infinity; // draw on the first update
  const _at = new THREE.Vector3();

  const shadows = {
    /** How dark, 0..1. */
    strength: CLOUD_SHADOWS.strength,
    /** Whether to cast them at all -- as well as the clouds being on. */
    enabled: true,

    /**
     * Once a frame, before the scene is drawn: keeps the shared uniforms
     * right, and redraws the map when it is due.
     *
     * @param {THREE.WebGLRenderer} renderer
     * @param {THREE.Camera} camera  the map is centred under it
     * @param {number} dt  seconds
     */
    update(renderer, camera, dt) {
      const on = shadows.enabled && clouds.enabled;
      shared.cloudShadowStrength.value = on ? shadows.strength : 0;
      if (!on) { sinceDrawn = Infinity; return; }
      sinceDrawn += dt;
      if (sinceDrawn < 1 / CLOUD_SHADOWS.rate) return;
      sinceDrawn = 0;

      // Centred under you, in whole texels, so the texels stay put on the
      // ground as you walk rather than crawling across it.
      const span = CLOUD_SHADOWS.span;
      const texel = span / CLOUD_SHADOWS.size;
      // The camera's place in the world, not in whatever carries it.
      _at.setFromMatrixPosition(camera.matrixWorld);
      const x = Math.round(_at.x / texel) * texel;
      const z = Math.round(_at.z / texel) * texel;
      u.origin.value.set(x, z);
      u.span.value = span;

      const was = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      quad.render(renderer);
      renderer.setRenderTarget(was);

      // The frame changes with the map, never before it is drawn.
      const up = Math.max(sunDirection.y, MIN_SUN_HEIGHT);
      const cloud = clouds.material.uniforms;
      shared.cloudShadowMap.value = target.texture;
      shared.cloudShadowFrame.value.set(x, z, 1 / span, u.ground.value);
      shared.cloudShadowSlide.value.set(
        sunDirection.x / up, sunDirection.z / up, cloud.bottom.value, cloud.top.value,
      );
    },

    dispose() {
      shared.cloudShadowStrength.value = 0;
      shared.cloudShadowMap.value = WHITE;
      target.dispose();
      material.dispose();
      quad.dispose();
    },
  };
  return shadows;
}
