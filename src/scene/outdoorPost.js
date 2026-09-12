import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Outside's post-processing: exponential height fog, and a post process
 * volume that controls exposure -- the two Unreal pieces an outdoor level
 * adds on top of its sun, sky light and atmosphere (scene/outdoorLight.js).
 *
 * THE CHAIN, all in linear HDR until the very end:
 *
 *   render     the scene into a half-float target, with its depth kept
 *   fog        height fog laid over it, from that depth
 *   exposure   the frame's brightness measured, adapted to, and applied
 *   output     ACES tone mapping and sRGB, onto the screen
 *
 * EXPONENTIAL HEIGHT FOG. Fog whose density falls off exponentially with
 * height: thick in the valleys, thin on the peaks, and thicker the further
 * you look through it -- Unreal's model. It is done here, over the finished
 * frame, rather than inside every material: the depth buffer says where each
 * pixel is, so one pass fogs everything, including materials made later
 * (book pages, turning leaves) that a per-material patch would miss.
 *
 * The density along a view ray has a closed form. With density
 * d(h) = D * exp(-F * (h - H)), a ray from the camera (height c) that covers
 * distance L and rises by r = L * dir.y collects
 *
 *   D * exp(-F * (c - H)) * L * (1 - exp(-F * r)) / (F * r)
 *
 * which becomes opacity through 1 - exp(-amount). Looking toward the sun the
 * fog also takes on the sun's colour -- Unreal's directional inscattering.
 *
 * EXPOSURE (eye adaptation). The frame's average brightness is measured on
 * the GPU: each pixel's log luminance is written into a small target whose
 * mip chain averages it down to one texel -- a geometric mean, the way auto
 * exposure is metered. The exposure that brings that average to middle grey
 * is eased toward over time, faster when it gets brighter than when it gets
 * darker, like eyes. Nothing is read back to the CPU.
 */

// --- exponential height fog --------------------------------------------------
const FOG = {
  density: 0.004, // per metre, at the fog's base height
  heightFalloff: 0.06, // per metre: density falls by e every 1/0.06 ~ 17 m up
  startDistance: 5, // metres of clear air in front of the camera
  maxOpacity: 1,
  color: 0xbfd0e3,
  brightness: 0.6, // the fog colour is in scene light units, before exposure
  // Toward the sun: its colour, how strongly, and how tight a glow.
  inscatteringColor: 0xffe2b8,
  inscatteringBrightness: 0.8,
  inscatteringExponent: 8,
  // How far the sky counts as, for fogging it: far enough that the horizon
  // is fully fogged, and rays climbing away from the ground gather little.
  skyDistance: 3000,
};

// --- exposure -----------------------------------------------------------------
const EXPOSURE = {
  key: 0.18, // the brightness the average is brought to: middle grey
  compensation: 1, // a multiplier on top, like Unreal's exposure compensation
  min: 0.05,
  max: 4,
  speedBrighter: 3, // 1/s, adapting to a brighter frame
  speedDarker: 1, // 1/s, adapting to a darker one
};
const LUMINANCE_SIZE = 64; // metering resolution; its mip 6 is a single texel

const FULLSCREEN_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

class HeightFogPass extends Pass {
  constructor({ camera, sunDirection, groundHeight }) {
    super();
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        projectionInverse: { value: new THREE.Matrix4() },
        cameraWorld: { value: new THREE.Matrix4() },
        cameraPos: { value: new THREE.Vector3() }, // not three's cameraPosition: that is the quad's camera
        fogColor: { value: new THREE.Color(FOG.color).multiplyScalar(FOG.brightness) },
        fogDensity: { value: FOG.density },
        fogFalloff: { value: FOG.heightFalloff },
        fogHeight: { value: groundHeight },
        fogStart: { value: FOG.startDistance },
        fogMaxOpacity: { value: FOG.maxOpacity },
        skyDistance: { value: FOG.skyDistance },
        // The vector itself, not a copy: moving the sun moves the glow.
        sunDirection: { value: sunDirection },
        inscatterColor: {
          value: new THREE.Color(FOG.inscatteringColor).multiplyScalar(FOG.inscatteringBrightness),
        },
        inscatterExponent: { value: FOG.inscatteringExponent },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform mat4 projectionInverse;
        uniform mat4 cameraWorld;
        uniform vec3 cameraPos;
        uniform vec3 fogColor;
        uniform float fogDensity;
        uniform float fogFalloff;
        uniform float fogHeight;
        uniform float fogStart;
        uniform float fogMaxOpacity;
        uniform float skyDistance;
        uniform vec3 sunDirection;
        uniform vec3 inscatterColor;
        uniform float inscatterExponent;
        varying vec2 vUv;

        // A point on this pixel's view ray, in world space, at NDC depth z.
        vec3 worldAt(float z) {
          vec4 view = projectionInverse * vec4(vUv * 2.0 - 1.0, z, 1.0);
          return (cameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
        }

        void main() {
          vec4 scene = texture2D(tDiffuse, vUv);
          float depth = texture2D(tDepth, vUv).x;

          // The ray's direction from a point well inside the frustum: at the
          // far plane (the sky) the reconstruction divides by zero.
          vec3 direction = normalize(worldAt(0.0) - cameraPos);
          bool sky = depth >= 0.99999;
          // Not called "distance": that is a GLSL built-in.
          float rayLength = sky ? skyDistance : length(worldAt(depth * 2.0 - 1.0) - cameraPos);
          rayLength = max(rayLength - fogStart, 0.0);

          // Density at the camera, then the closed-form integral along the ray.
          float atCamera = fogDensity * exp(-fogFalloff * (cameraPos.y - fogHeight));
          float rise = fogFalloff * direction.y * rayLength;
          float spread = abs(rise) > 1e-4 ? (1.0 - exp(-rise)) / rise : 1.0 - 0.5 * rise;
          float amount = atCamera * rayLength * spread;
          float opacity = min(1.0 - exp(-amount), fogMaxOpacity);

          vec3 colour = fogColor
            + inscatterColor * pow(max(dot(direction, sunDirection), 0.0), inscatterExponent);
          gl_FragColor = vec4(mix(scene.rgb, colour, opacity), scene.a);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.brightness = FOG.brightness;
    this.inscatteringBrightness = FOG.inscatteringBrightness;
  }

  /** The fog colour's brightness, in scene light units. */
  setBrightness(value) {
    this.brightness = value;
    this.material.uniforms.fogColor.value.set(FOG.color).multiplyScalar(value);
  }

  /** How bright the glow toward the sun is. */
  setInscatteringBrightness(value) {
    this.inscatteringBrightness = value;
    this.material.uniforms.inscatterColor.value.set(FOG.inscatteringColor).multiplyScalar(value);
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    u.projectionInverse.value.copy(this.camera.projectionMatrixInverse);
    u.cameraWorld.value.copy(this.camera.matrixWorld);
    u.cameraPos.value.setFromMatrixPosition(this.camera.matrixWorld);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}

class AutoExposurePass extends Pass {
  constructor() {
    super();

    // Log luminance, metered small; the renderer builds its mips after each
    // render, and the last one is the average.
    this.luminanceTarget = new THREE.WebGLRenderTarget(LUMINANCE_SIZE, LUMINANCE_SIZE, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    // The adapted value, one texel, ping-ponged so each frame can read the last.
    const adapted = () => new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
    this.adaptedRead = adapted();
    this.adaptedWrite = adapted();
    this.firstFrame = true;

    this.luminanceMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() {
          float luminance = dot(texture2D(tDiffuse, vUv).rgb, vec3(0.2126, 0.7152, 0.0722));
          gl_FragColor = vec4(log(max(luminance, 1e-4)), 0.0, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.adaptMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tLuminance: { value: null },
        tPrevious: { value: null },
        lastLevel: { value: Math.log2(LUMINANCE_SIZE) },
        deltaTime: { value: 0 },
        speedBrighter: { value: EXPOSURE.speedBrighter },
        speedDarker: { value: EXPOSURE.speedDarker },
        reset: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */`
        uniform sampler2D tLuminance;
        uniform sampler2D tPrevious;
        uniform float lastLevel;
        uniform float deltaTime;
        uniform float speedBrighter;
        uniform float speedDarker;
        uniform float reset;
        varying vec2 vUv;
        void main() {
          float measured = textureLod(tLuminance, vec2(0.5), lastLevel).r;
          float previous = texture2D(tPrevious, vec2(0.5)).r;
          float speed = measured > previous ? speedBrighter : speedDarker;
          float blend = reset > 0.5 ? 1.0 : 1.0 - exp(-deltaTime * speed);
          gl_FragColor = vec4(mix(previous, measured, blend), 0.0, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.applyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tAdapted: { value: null },
        key: { value: EXPOSURE.key },
        compensation: { value: EXPOSURE.compensation },
        minExposure: { value: EXPOSURE.min },
        maxExposure: { value: EXPOSURE.max },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler2D tAdapted;
        uniform float key;
        uniform float compensation;
        uniform float minExposure;
        uniform float maxExposure;
        varying vec2 vUv;
        void main() {
          float averageLuminance = exp(texture2D(tAdapted, vec2(0.5)).r);
          float exposure = clamp(key / averageLuminance, minExposure, maxExposure) * compensation;
          vec4 colour = texture2D(tDiffuse, vUv);
          gl_FragColor = vec4(colour.rgb * exposure, colour.a);
        }`,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new FullScreenQuad(this.luminanceMaterial);
  }

  render(renderer, writeBuffer, readBuffer, deltaTime) {
    // Meter.
    this.luminanceMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.luminanceMaterial;
    renderer.setRenderTarget(this.luminanceTarget);
    this.quad.render(renderer);

    // Adapt: last frame's value eased toward this one's.
    const adapt = this.adaptMaterial.uniforms;
    adapt.tLuminance.value = this.luminanceTarget.texture;
    adapt.tPrevious.value = this.adaptedRead.texture;
    adapt.deltaTime.value = deltaTime;
    adapt.reset.value = this.firstFrame ? 1 : 0; // the first frame starts adapted
    this.firstFrame = false;
    this.quad.material = this.adaptMaterial;
    renderer.setRenderTarget(this.adaptedWrite);
    this.quad.render(renderer);
    [this.adaptedRead, this.adaptedWrite] = [this.adaptedWrite, this.adaptedRead];

    // Apply.
    this.applyMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.applyMaterial.uniforms.tAdapted.value = this.adaptedRead.texture;
    this.quad.material = this.applyMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.luminanceTarget.dispose();
    this.adaptedRead.dispose();
    this.adaptedWrite.dispose();
    this.luminanceMaterial.dispose();
    this.adaptMaterial.dispose();
    this.applyMaterial.dispose();
    this.quad.dispose();
  }
}

/**
 * @param {object} opts
 * @param {THREE.WebGLRenderer} opts.renderer  its toneMapping is what the
 *   output step applies; exposure is this chain's, so its toneMappingExposure
 *   should be left at 1
 * @param {THREE.Scene} opts.scene
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {THREE.Vector3} opts.sunDirection  toward the sun
 * @param {number} opts.groundHeight  world height the fog is thickest at
 * @returns {{ render(dt: number): void, dispose(): void,
 *   fog: HeightFogPass, exposure: AutoExposurePass }}  the two passes, for
 *   switching them off (`enabled`) and tuning them live
 */
export function createOutdoorPost({ renderer, scene, camera, sunDirection, groundHeight }) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  // Half float for HDR, multisampled because a render target does not get the
  // canvas's own antialiasing, and a float depth texture: at 300 m with a
  // 1 cm near plane, 24-bit depth is too coarse to say where the ground is.
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: 4,
    depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.FloatType),
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(window.innerWidth, window.innerHeight);

  composer.addPass(new RenderPass(scene, camera));
  const fog = new HeightFogPass({ camera, sunDirection, groundHeight });
  composer.addPass(fog);
  const exposure = new AutoExposurePass();
  composer.addPass(exposure);
  composer.addPass(new OutputPass());

  const onResize = () => composer.setSize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', onResize);

  return {
    fog,
    exposure,
    render(dt) {
      composer.render(dt);
    },
    dispose() {
      window.removeEventListener('resize', onResize);
      fog.dispose();
      exposure.dispose();
      composer.dispose();
    },
  };
}