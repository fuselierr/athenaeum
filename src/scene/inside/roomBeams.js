import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Sunbeams in the room, and the dust that shows in them.
 *
 * THE BEAMS are light scattered toward you by the air the sun passes through,
 * so they are worked out the way that happens: for every pixel, a ray from the
 * camera to whatever the pixel shows is walked in steps through the room, and
 * each step asks the sun's own shadow map (scene/inside/roomDaylight.js)
 * whether sunlight reaches that point. The share of the ray in sunlight is the
 * beam. So the beams are exactly the shape of the patches on the floor -- the
 * arches, with the glazing bars across them -- the balcony, the balusters and
 * the furniture cut them off, and they follow the time of day and the clouds
 * with nothing more said. Brighter looking toward the sun, as haze is: a
 * Henyey-Greenstein phase, normalised so side-on is 1.
 *
 * Only inside the room's box: the sky seen through a window is not the air of
 * the room. Walked at half resolution, with each pixel's steps offset by a
 * fixed noise so the banding of a few dozen steps becomes grain, which a small
 * blur then smooths away -- fixed rather than changing every frame, which
 * with nothing to average it over would only make the beams fizz.
 *
 * THE CHAIN. The room is otherwise drawn straight to the screen. For the beams
 * it goes through a short chain instead -- the scene into a buffer with its
 * depth, the beams added over it, then out to the screen with the same tone
 * mapping and colour conversion a direct draw has (OutputPass). Only while
 * there is sun in the room to make beams of: at night, under a full overcast,
 * with shadows off or in a headset it is the direct draw again, and costs
 * nothing.
 *
 * THE DUST is a few thousand specks drifting through the whole room, each
 * asking the same shadow map whether it is in the sun: out of it, not drawn at
 * all; in it, glinting -- brighter toward the sun, like the beam.
 *
 * Its numbers are roomDaylight.js's ROOM_DAYLIGHT (the beam's strength and how
 * forward it scatters, the dust's brightness and size), read every frame, so
 * the debug overlay's sliders move them live. How finely the beams are walked
 * and how much dust there is are the graphics quality's (state/quality.js's
 * beamSteps and dust).
 */

const SHADOW_BIAS = 0.0015; // depth, in the shadow map's 0..1
const MAX_STEPS = 64;

// --- the shared GLSL: is a world point in the sun, and how bright toward us ------------
const SUN_GLSL = /* glsl */ `
  uniform sampler2DShadow tShadow;
  uniform mat4 shadowMatrix;
  uniform vec3 sunDir;   // toward the sun
  uniform vec3 sunLight; // its colour times its strength
  uniform float forward; // Henyey-Greenstein g

  float inSun(vec3 world) {
    vec4 c = shadowMatrix * vec4(world, 1.0);
    c.xyz /= c.w;
    if (any(lessThan(c.xyz, vec3(0.0))) || any(greaterThan(c.xyz, vec3(1.0)))) return 0.0;
    return texture(tShadow, vec3(c.xy, c.z - ${SHADOW_BIAS}));
  }

  // How much brighter than side-on the haze looks along 'view' (camera to point).
  float phase(vec3 view) {
    float g = forward;
    float c = dot(view, sunDir);
    float hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * c, 1e-4), 1.5);
    float side = (1.0 - g * g) / pow(1.0 + g * g, 1.5);
    return hg / side;
  }
`;

const sunUniforms = () => ({
  tShadow: { value: null },
  shadowMatrix: { value: new THREE.Matrix4() },
  sunDir: { value: new THREE.Vector3(0, 1, 0) },
  sunLight: { value: new THREE.Color() },
  forward: { value: 0.5 },
});

/** Point the shared uniforms at the sun as it is this frame. */
function aimAtSun(uniforms, sun) {
  uniforms.tShadow.value = sun.shadow.map?.depthTexture ?? null;
  uniforms.shadowMatrix.value.copy(sun.shadow.matrix);
  uniforms.sunDir.value.subVectors(sun.position, sun.target.position).normalize();
  uniforms.sunLight.value.copy(sun.color).multiplyScalar(sun.intensity);
}

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

class BeamPass extends Pass {
  constructor({ camera, sun, box, values }) {
    super();
    this.camera = camera;
    this.sun = sun;
    this.values = values;
    this.steps = 32;

    const half = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.beams = half();
    this.spare = half();

    this.march = new THREE.ShaderMaterial({
      uniforms: {
        ...sunUniforms(),
        tDepth: { value: null },
        projectionInverse: { value: new THREE.Matrix4() },
        cameraWorld: { value: new THREE.Matrix4() },
        eye: { value: new THREE.Vector3() },
        boxMin: { value: box.min.clone() },
        boxMax: { value: box.max.clone() },
        strength: { value: 0 },
        steps: { value: 32 },
      },
      vertexShader: QUAD_VERTEX,
      fragmentShader: /* glsl */ `
        ${SUN_GLSL}
        uniform sampler2D tDepth;
        uniform mat4 projectionInverse;
        uniform mat4 cameraWorld;
        uniform vec3 eye;
        uniform vec3 boxMin;
        uniform vec3 boxMax;
        uniform float strength;
        uniform int steps;
        varying vec2 vUv;

        void main() {
          float depth = texture(tDepth, vUv).r;
          vec4 view = projectionInverse * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          vec3 end = (cameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
          vec3 ray = end - eye;
          float far = length(ray);
          ray /= far;

          // Only the stretch of the ray inside the room.
          vec3 inv = 1.0 / ray;
          vec3 t0 = (boxMin - eye) * inv;
          vec3 t1 = (boxMax - eye) * inv;
          vec3 lo = min(t0, t1);
          vec3 hi = max(t0, t1);
          float from = max(max(lo.x, lo.y), max(lo.z, 0.0));
          float to = min(min(hi.x, hi.y), min(hi.z, far));
          if (to <= from) { gl_FragColor = vec4(0.0); return; }

          float stride = (to - from) / float(steps);
          // Interleaved gradient noise: a different start in each pixel, the
          // same every frame.
          float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float lit = 0.0;
          for (int i = 0; i < ${MAX_STEPS}; i++) {
            if (i >= steps) break;
            lit += inSun(eye + ray * (from + (float(i) + jitter) * stride));
          }
          // Metres of sunlit air along the ray.
          lit *= stride;
          gl_FragColor = vec4(sunLight * strength * phase(ray) * lit, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    // A small separable Gaussian, at half resolution.
    this.blur = new THREE.ShaderMaterial({
      uniforms: { tInput: { value: null }, texel: { value: new THREE.Vector2() } },
      vertexShader: QUAD_VERTEX,
      fragmentShader: /* glsl */ `
        uniform sampler2D tInput;
        uniform vec2 texel;
        varying vec2 vUv;
        void main() {
          vec3 sum = texture(tInput, vUv).rgb * 0.2270270;
          sum += texture(tInput, vUv + texel * 1.3846153).rgb * 0.3162162;
          sum += texture(tInput, vUv - texel * 1.3846153).rgb * 0.3162162;
          sum += texture(tInput, vUv + texel * 3.2307692).rgb * 0.0702702;
          sum += texture(tInput, vUv - texel * 3.2307692).rgb * 0.0702702;
          gl_FragColor = vec4(sum, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    // The room with the beams over it.
    this.composite = new THREE.ShaderMaterial({
      uniforms: { tScene: { value: null }, tBeams: { value: null } },
      vertexShader: QUAD_VERTEX,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene;
        uniform sampler2D tBeams;
        varying vec2 vUv;
        void main() {
          vec4 scene = texture(tScene, vUv);
          gl_FragColor = vec4(scene.rgb + texture(tBeams, vUv).rgb, scene.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new FullScreenQuad(this.march);
  }

  setSize(width, height) {
    const w = Math.max(1, Math.ceil(width / 2));
    const h = Math.max(1, Math.ceil(height / 2));
    this.beams.setSize(w, h);
    this.spare.setSize(w, h);
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.march.uniforms;
    aimAtSun(u, this.sun);
    u.forward.value = this.values.beamForward;
    u.strength.value = this.values.beamStrength;
    u.steps.value = this.steps;
    u.tDepth.value = readBuffer.depthTexture;
    u.projectionInverse.value.copy(this.camera.projectionMatrixInverse);
    u.cameraWorld.value.copy(this.camera.matrixWorld);
    this.camera.getWorldPosition(u.eye.value);

    this.quad.material = this.march;
    renderer.setRenderTarget(this.beams);
    this.quad.render(renderer);

    const b = this.blur.uniforms;
    this.quad.material = this.blur;
    b.tInput.value = this.beams.texture;
    b.texel.value.set(1 / this.beams.width, 0);
    renderer.setRenderTarget(this.spare);
    this.quad.render(renderer);
    b.tInput.value = this.spare.texture;
    b.texel.value.set(0, 1 / this.beams.height);
    renderer.setRenderTarget(this.beams);
    this.quad.render(renderer);

    const c = this.composite.uniforms;
    c.tScene.value = readBuffer.texture;
    c.tBeams.value = this.beams.texture;
    this.quad.material = this.composite;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.beams.dispose();
    this.spare.dispose();
    this.march.dispose();
    this.blur.dispose();
    this.composite.dispose();
    this.quad.dispose();
  }
}

/**
 * The room's frame, drawn with sunbeams when there is sun to make them of.
 *
 * @param {object} opts
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {THREE.Scene} opts.scene
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {THREE.DirectionalLight} opts.sun  roomDaylight.js's sun
 * @param {THREE.Box3} opts.box  the room, both storeys
 * @param {object} opts.values  ROOM_DAYLIGHT
 * @returns {{ render(dt: number): void, applyQuality(preset: object): void, dispose(): void }}
 */
export function createRoomBeams({ renderer, scene, camera, sun, box, values }) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  // Half float for the sun's highlights, multisampled because a render target
  // does not get the canvas's own antialiasing, and a float depth texture for
  // the beams to find each pixel's distance in.
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: 4,
    depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.FloatType),
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(window.innerWidth, window.innerHeight);

  composer.addPass(new RenderPass(scene, camera));
  const beams = new BeamPass({ camera, sun, box, values });
  composer.addPass(beams);
  composer.addPass(new OutputPass());

  const onResize = () => composer.setSize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', onResize);

  return {
    /** Draw the room: through the beams when they would show, straight otherwise. */
    render(dt) {
      const worth = beams.steps > 0
        && values.beamStrength > 0
        && sun.intensity > 0.01
        && renderer.shadowMap.enabled
        && sun.shadow.map?.depthTexture
        && !renderer.xr.isPresenting;
      if (worth) composer.render(dt);
      else renderer.render(scene, camera);
    },

    /** A graphics quality preset (state/quality.js): steps, and anti-aliasing. */
    applyQuality({ beamSteps, msaa }) {
      beams.steps = Math.min(MAX_STEPS, Math.max(0, Math.round(beamSteps ?? 32)));
      for (const buffer of [composer.renderTarget1, composer.renderTarget2]) {
        if (buffer.samples === msaa) continue;
        buffer.samples = msaa;
        buffer.dispose(); // made again at the new sample count when next drawn into
      }
      composer.setPixelRatio(renderer.getPixelRatio());
    },

    dispose() {
      window.removeEventListener('resize', onResize);
      beams.dispose();
      composer.dispose();
    },
  };
}

/**
 * Dust drifting through the room, seen only where the sun catches it.
 *
 * @param {object} opts
 * @param {THREE.Object3D} opts.group  the room's group, so it goes with it outside
 * @param {THREE.DirectionalLight} opts.sun
 * @param {THREE.Box3} opts.box
 * @param {object} opts.values  ROOM_DAYLIGHT
 * @param {number} [opts.count]  the most there can be; setCount draws fewer
 * @returns {{ points: THREE.Points, update(dt: number, renderer: THREE.WebGLRenderer,
 *   camera: THREE.PerspectiveCamera): void, setCount(n: number): void, dispose(): void }}
 */
export function addRoomDust({ group, sun, box, values, count = 4000 }) {
  // Where each speck starts, as a share of the room's box, and three numbers
  // of its own for how it wanders.
  const start = new Float32Array(count * 3);
  const seed = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) {
    start[i] = Math.random();
    seed[i] = Math.random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(start, 3));
  geometry.setAttribute('seed', new THREE.BufferAttribute(seed, 3));
  // Wherever they have drifted, they are somewhere in the room.
  geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());

  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...sunUniforms(),
      time: { value: 0 },
      boxMin: { value: box.min.clone() },
      boxSize: { value: box.getSize(new THREE.Vector3()) },
      speck: { value: 0.003 },
      pixelScale: { value: 800 },
      brightness: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 seed;
      uniform float time;
      uniform vec3 boxMin;
      uniform vec3 boxSize;
      uniform float speck;
      uniform float pixelScale;
      varying vec3 vWorld;
      varying float vFade;

      void main() {
        // A slow settle, and a wander about it -- all wrapped round the room.
        vec3 share = position;
        share.y -= time * 0.0015 * (0.4 + seed.y);
        share.x += time * 0.0008 * (seed.x - 0.5);
        share.z += time * 0.0008 * (seed.z - 0.5);
        vec3 world = boxMin + fract(share) * boxSize;
        world += 0.04 * vec3(
          sin(time * 0.31 + seed.x * 40.0),
          sin(time * 0.23 + seed.y * 40.0),
          sin(time * 0.27 + seed.z * 40.0));
        vWorld = world;

        vec4 mv = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mv;
        float pixels = speck * (0.5 + seed.x) * pixelScale / max(-mv.z, 0.05);
        // Smaller than a pixel, a speck is drawn at one and dimmed to match,
        // rather than flickering in and out as it lands between pixels.
        gl_PointSize = clamp(pixels, 1.0, 8.0);
        vFade = clamp(pixels, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${SUN_GLSL}
      uniform float brightness;
      varying vec3 vWorld;
      varying float vFade;

      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r = dot(p, p);
        if (r > 1.0) discard;
        float lit = inSun(vWorld);
        if (lit <= 0.0) discard;
        vec3 view = normalize(vWorld - cameraPosition);
        gl_FragColor = vec4(sunLight * brightness * phase(view) * lit * (1.0 - r) * vFade, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'roomDust';
  points.frustumCulled = false;
  group.add(points);

  const _size = new THREE.Vector2();

  return {
    points,

    /** Before the frame is drawn: the time, the sun, and the camera's scale. */
    update(dt, renderer, camera) {
      if (geometry.drawRange.count === 0 || !group.visible) {
        points.visible = false;
        return;
      }
      const u = material.uniforms;
      u.time.value += dt;
      aimAtSun(u, sun);
      u.forward.value = values.beamForward;
      u.brightness.value = values.dustBrightness;
      u.speck.value = values.dustSize;
      renderer.getDrawingBufferSize(_size);
      u.pixelScale.value = _size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      points.visible = values.dustBrightness > 0 && sun.intensity > 0.01
        && renderer.shadowMap.enabled && Boolean(u.tShadow.value);
    },

    /** Draw only the first `n` specks -- the rest are the same, only more. */
    setCount(n) {
      geometry.setDrawRange(0, Math.max(0, Math.min(count, Math.round(n))));
    },

    dispose() {
      group.remove(points);
      geometry.dispose();
      material.dispose();
    },
  };
}
